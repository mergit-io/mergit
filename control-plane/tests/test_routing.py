"""Routing eligibility, limits and the draw record (paper 7.5). Run with `pytest -m postgres`.

Follows the seeding conventions of `tests/test_money.py` (`run`/`receive`) and
`tests/test_reputation_store.py` (`rand_hex_address`/`rand_id`/`seed_task`): a fresh, random
plan/task/agent/operator per test, never asserting against "the whole table" -- the postgres container
behind `database_url` is shared for the whole test session and never truncated between these tests, so a
literal, reused agent_id or operator address would let one test's state (an unresolved dispatch, a
falsification observation, a recorded exploratory draw) leak into a later one. Every `Roster` fixture below
mints fresh agent ids and operator addresses on each call for exactly that reason.

The roster used throughout is four agents across three operators:

    agent a1 and agent a2 -- both operator A
    agent b1 -- operator B
    agent c1 -- operator C
"""

from __future__ import annotations

import json
import random
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import mergit_receipt
import pytest
from psycopg.types.json import Jsonb
from pydantic import SecretStr

from mergit_cp import plans as plans_module
from mergit_cp import routing
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.reputation import ingest_due
from mergit_cp.router import Arm, Draw, Mode, draw
from tests.test_api import phi
from tests.test_money import receive, run
from tests.test_reputation_store import rand_hex_address, rand_id, seed_task

pytestmark = pytest.mark.postgres

RUNTIME_KEY = "0x9999999999999999999999999999999999999999"

_TOML = (
    '[providers.anthropic]\nkind = "anthropic"\n\n'
    '[agents.a1]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
    '[agents.a2]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
    '[agents.b1]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
    '[agents.c1]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
)


def _agent(agent_id: str, name: str, operator: str) -> dict[str, str]:
    return {"agent_id": agent_id, "name": name, "operator": operator, "runtime_key": RUNTIME_KEY}


def _rand_agent_id() -> str:
    """A fresh numeric agent_id (`mergit_cp.agents` requires `^(0|[1-9][0-9]*)$`), distinct enough across
    the whole test session that two tests never accidentally share one."""
    return str(random.randint(10**12, 10**13 - 1))


@dataclass(frozen=True)
class Roster:
    """The agents.json/agents.toml pair, the agent ids, and the operator addresses written into them --
    all freshly random per fixture call. See this module's docstring for why that matters."""

    chain: Path
    config: Path
    op_a: str
    op_b: str
    op_c: str
    a1: str
    a2: str
    b1: str
    c1: str


@pytest.fixture
def agents_files(tmp_path: Path) -> Roster:
    """Overrides conftest.py's single-agent fixture: routing tests need several operators."""
    op_a, op_b, op_c = rand_hex_address(), rand_hex_address(), rand_hex_address()
    a1, a2, b1, c1 = _rand_agent_id(), _rand_agent_id(), _rand_agent_id(), _rand_agent_id()
    chain = tmp_path / "agents.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    _agent(a1, "a1", op_a),
                    _agent(a2, "a2", op_a),
                    _agent(b1, "b1", op_b),
                    _agent(c1, "c1", op_c),
                ]
            }
        )
    )
    config = tmp_path / "agents.toml"
    config.write_text(_TOML)
    return Roster(chain, config, op_a, op_b, op_c, a1, a2, b1, c1)


@pytest.fixture
def single_agent_files(tmp_path: Path) -> Roster:
    """One agent, one operator -- for the greedy-is-None scenario, where every other roster agent must
    stay out of the way of the feasibility math entirely rather than merely being excluded."""
    op_a = rand_hex_address()
    a1 = _rand_agent_id()
    chain = tmp_path / "agents.json"
    chain.write_text(json.dumps({"agents": [_agent(a1, "a1", op_a)]}))
    config = tmp_path / "agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.a1]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
    )
    return Roster(chain, config, op_a, op_a, op_a, a1, a1, a1, a1)


def _settings(agents_files: Roster, database_url: str, **overrides: object) -> Settings:
    chain, config = agents_files.chain, agents_files.config
    return Settings(
        database_url=database_url,
        app_domain="app.mergit.test",
        session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
        gateway_url="http://gateway.invalid",
        store_url="http://store.invalid",
        agents_file=str(chain),
        agents_config=str(config),
        planner_model="claude-opus-5",
        planner_provider="anthropic",
        events_token=SecretStr("test-events-token"),
        chain_events_token=SecretStr("test-chain-events-token"),
        worker_token=SecretStr("test-worker-token"),
        **overrides,  # type: ignore[arg-type]
    )


async def seed_plan(
    pool: Pool,
    *,
    category: str = "cat",
    budget_usdc_units: int = 1_000_000,
    routing_mode: str = "auto",
    explore: bool = True,
    retry_tolerant: bool = True,
) -> tuple[str, str]:
    """A funded plan with one task (index 0), no dispatch. Returns (plan_uuid, plan_id)."""
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    task_phi = phi()
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
            " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
            " VALUES (%s, %s, %s, 'g', 'https://github.com/a/b', 'main', %s, %s, 'running', 'wallet', %s,"
            " 'm', now())",
            (plan_uuid, plan_id, rand_hex_address(), category, budget_usdc_units, budget_usdc_units),
        )
        await conn.execute(
            'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, phi_hash,'
            " budget_usdc_units, routing, explore, retry_tolerant)"
            " VALUES (%s, 0, 't', 'do it', %s, %s, %s, %s, %s, %s)",
            (
                plan_uuid,
                Jsonb(task_phi),
                mergit_receipt.phi_hash(json.dumps(task_phi)),
                budget_usdc_units,
                routing_mode,
                explore,
                retry_tolerant,
            ),
        )
    return plan_uuid, plan_id


async def seed_dispatch(
    pool: Pool, *, plan_uuid: str, plan_id: str, agent_id: str, index: int = 0, attempt: int = 1
) -> str:
    """One extra `task_dispatches` row, for a plan/task already seeded (by `seed_plan` or `seed_task`).
    Returns the task_id."""
    task_id = mergit_receipt.task_id(plan_id, index, attempt)
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
            " VALUES (%s, %s, %s, %s, %s)",
            (task_id, plan_uuid, index, attempt, agent_id),
        )
    return task_id


async def seed_error_job(pool: Pool, *, task_id: str, plan_uuid: str, agent_id: str) -> None:
    """A job that errored with nothing ever sealed: must not count toward either cap."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, receipt_root,'
            " finished_at) VALUES (%s, %s, 0, 1, %s, 'error', NULL, now())",
            (task_id, plan_uuid, agent_id),
        )


async def seed_routing_draw(pool: Pool, *, task_id: str, chosen_agent: str, exploratory: bool) -> None:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO routing_draws (task_id, seed, explore, retry_tolerant, budget_micros, samples,"
            " ineligible, chosen_agent, greedy_agent, exploratory)"
            " VALUES (%s, '1', true, true, 1000000, %s, %s, %s, %s, %s)",
            (task_id, Jsonb([]), Jsonb({}), chosen_agent, chosen_agent, exploratory),
        )


async def release_task(pool: Pool, settings: Settings, task_id: str, n: int) -> None:
    await receive(
        pool,
        settings,
        "task.released",
        {
            "task_id": task_id,
            "to": "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
            "amount_usdc_units": "500000",
            "tx": "0x" + format(n, "064x"),
        },
    )


class _FixedSecrets:
    """Stands in for the `secrets` module inside `mergit_cp.routing` for one call, so a test can pick the
    exact seed `route()` draws with instead of a real random one."""

    def __init__(self, value: int) -> None:
        self._value = value

    def randbits(self, _n: int) -> int:
        return self._value


def _find_seed(
    predicate: Callable[[Draw], bool],
    arms: list[Arm],
    budget_micros: int,
    mode: Mode,
    tolerance: float,
    max_tries: int = 5000,
) -> tuple[int, Draw]:
    for seed in range(max_tries):
        d = draw(arms, budget_micros, mode, tolerance, random.Random(seed))
        if predicate(d):
            return seed, d
    raise AssertionError(f"no seed satisfying the predicate found in [0, {max_tries})")


async def load_plan(pool: Pool, plan_uuid: str) -> plans_module.StoredPlan:
    async with pool.connection() as conn:
        plan = await plans_module.load(conn, UUID(plan_uuid))
    assert plan is not None
    return plan


# --- candidates(): eligibility ----------------------------------------------------------------------


def test_operator_at_cap_is_ineligible_and_frees_on_release(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url, router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        # One unresolved dispatch for operator A, on a DIFFERENT plan/index than the one being routed --
        # that keeps this test about the concurrency cap, not "already tried on this task".
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(
            pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agents_files.a1
        )

        routed_uuid, _ = await seed_plan(pool)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        arm_ids = {a.agent_id for a in arms}
        assert arm_ids == {agents_files.b1, agents_files.c1}
        assert ineligible[agents_files.a1] == "operator at concurrency cap"
        assert ineligible[agents_files.a2] == "operator at concurrency cap"

        await release_task(pool, settings, noise_task, 1)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {
            agents_files.a1,
            agents_files.a2,
            agents_files.b1,
            agents_files.c1,
        }
        assert ineligible == {}

    run(database_url, body)


def test_errored_unsealed_job_does_not_count_toward_cap(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url, router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(
            pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agents_files.a1
        )
        await seed_error_job(pool, task_id=noise_task, plan_uuid=noise_uuid, agent_id=agents_files.a1)

        routed_uuid, _ = await seed_plan(pool)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {
            agents_files.a1,
            agents_files.a2,
            agents_files.b1,
            agents_files.c1,
        }
        assert ineligible == {}

    run(database_url, body)


def test_probation_excludes_whole_operator(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        category = rand_id("cat")
        _, _, falsified_task = await seed_task(pool, agent_id=agents_files.a1, category=category)
        await receive(
            pool,
            settings,
            "verdict.recorded",
            {"task_id": falsified_task, "verdict": "invalid", "tx": "0x" + "ab" * 32},
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, {agents_files.a1: agents_files.op_a})

        routed_uuid, _ = await seed_plan(pool, category=category)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}
        assert ineligible[agents_files.a1] == "operator in probation"
        assert ineligible[agents_files.a2] == "operator in probation"

    run(database_url, body)


def test_already_tried_agent_is_excluded_on_retry(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        plan_uuid, plan_id = await seed_plan(pool)
        await seed_dispatch(pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=agents_files.a1, attempt=1)
        await seed_dispatch(pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=agents_files.a2, attempt=2)
        plan = await load_plan(pool, plan_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}
        assert ineligible[agents_files.a1] == "already tried on this task"
        assert ineligible[agents_files.a2] == "already tried on this task"

    run(database_url, body)


# --- route(): the draw, the exploration cap, and the cross-task None-greedy constraint ---------------


def test_explore_cap_falls_back_to_greedy(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url, router_explore_cap_per_operator=2)
    capped_settings = _settings(agents_files, database_url, router_explore_cap_per_operator=1)

    async def body(pool: Pool) -> None:
        # One unresolved exploratory draw already on record for operator A -- on a different task, so it
        # does not touch "already tried" for the task actually being routed.
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(
            pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agents_files.a1
        )
        await seed_routing_draw(pool, task_id=noise_task, chosen_agent=agents_files.a1, exploratory=True)

        routed_uuid, _ = await seed_plan(pool, budget_usdc_units=1_000_000)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, _ = await routing.candidates(conn, plan, 0, settings)
        mode = Mode(explore=True, retry_tolerant=True)
        # All four agents share the same (never-observed) prior, so `greedy` is deterministic (whichever
        # of the four random agent ids sorts lowest -- not necessarily one of operator A's own agents, and
        # it does not need to be: the cap-redirect only cares that the *chosen* agent's operator is
        # capped, not what operator `greedy` itself belongs to). Search for a seed where the sampled pick
        # is exploratory and belongs to operator A.
        a1, a2 = agents_files.a1, agents_files.a2

        def _operator_a_exploratory(d: Draw) -> bool:
            return d.exploratory and d.chosen in (a1, a2) and d.greedy is not None

        seed_value, expected = _find_seed(
            _operator_a_exploratory, arms, 1_000_000, mode, settings.router_budget_tolerance
        )
        exploratory_agent, greedy_agent = expected.chosen, expected.greedy
        assert greedy_agent is not None

        async def route_with(s: Settings) -> routing.PendingDraw | None:
            original = routing.secrets
            routing.secrets = _FixedSecrets(seed_value)  # type: ignore[assignment]
            try:
                async with pool.connection() as conn:
                    return await routing.route(conn, plan, 0, 1, s)
            finally:
                routing.secrets = original

        # Control: under the *uncapped* operator, the natural exploratory pick goes through untouched.
        natural = await route_with(settings)
        assert natural is not None
        assert natural.draw.chosen == exploratory_agent
        assert natural.draw.exploratory is True
        assert natural.seed == str(seed_value)

        # With the operator already at its exploration cap, the same seed is redirected to greedy.
        capped = await route_with(capped_settings)
        assert capped is not None
        assert capped.draw.chosen == greedy_agent
        assert capped.draw.greedy == greedy_agent
        assert capped.draw.exploratory is False
        assert capped.seed == str(seed_value)

    run(database_url, body)


def test_explore_cap_hit_with_no_greedy_returns_none(database_url: str, single_agent_files: Roster) -> None:
    settings = _settings(single_agent_files, database_url, router_explore_cap_per_operator=2)
    capped_settings = _settings(single_agent_files, database_url, router_explore_cap_per_operator=1)
    agent = single_agent_files.a1

    async def body(pool: Pool) -> None:
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agent)
        await seed_routing_draw(pool, task_id=noise_task, chosen_agent=agent, exploratory=True)

        # A budget far below the agent's prior mean cost (200_000 micros, kappa=1): mean cost is always
        # infeasible (`greedy` is always None), but kappa=1 gives an exponential-shaped sampled-cost
        # distribution with enough mass near small values that a feasible *sample* is still findable.
        budget = 36_000
        routed_uuid, _ = await seed_plan(pool, budget_usdc_units=budget)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, _ = await routing.candidates(conn, plan, 0, settings)
        assert [a.agent_id for a in arms] == [agent]
        mode = Mode(explore=True, retry_tolerant=True)
        seed_value, expected = _find_seed(
            lambda d: d.chosen is not None and d.greedy is None,
            arms,
            budget,
            mode,
            settings.router_budget_tolerance,
        )
        assert expected.exploratory is True  # chosen is not None, greedy is None => always exploratory

        async def route_with(s: Settings) -> routing.PendingDraw | None:
            original = routing.secrets
            routing.secrets = _FixedSecrets(seed_value)  # type: ignore[assignment]
            try:
                async with pool.connection() as conn:
                    return await routing.route(conn, plan, 0, 1, s)
            finally:
                routing.secrets = original

        # Control: uncapped, a no-greedy exploratory pick still dispatches normally.
        natural = await route_with(settings)
        assert natural is not None
        assert natural.draw.chosen == agent
        assert natural.draw.greedy is None
        assert natural.draw.exploratory is True

        # Capped: nothing safe to dispatch, so route() must return None, never a PendingDraw with a
        # None-wrapped chosen agent.
        capped = await route_with(capped_settings)
        assert capped is None

    run(database_url, body)


def test_draw_is_recorded_with_seed_and_replays(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        plan_uuid, plan_id = await seed_plan(pool, budget_usdc_units=1_000_000)
        plan = await load_plan(pool, plan_uuid)

        async with pool.connection() as conn:
            pending = await routing.route(conn, plan, 0, 1, settings)
        assert pending is not None
        assert pending.draw.chosen is not None

        # Capture the arm set `route()` actually drew over *before* recording the dispatch: once a
        # dispatch row for this index exists, `candidates()` would (correctly) mark the chosen agent
        # "already tried" and exclude it, which would break the replay below for an unrelated reason.
        async with pool.connection() as conn:
            arms, _ = await routing.candidates(conn, plan, 0, settings)

        task_id = await seed_dispatch(
            pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=pending.draw.chosen
        )
        async with pool.connection() as conn, conn.transaction():
            await routing.record_draw(conn, task_id, pending)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT seed, chosen_agent, greedy_agent, exploratory, budget_micros, explore,"
                " retry_tolerant FROM routing_draws WHERE task_id = %s",
                (task_id,),
            )
            row = await cur.fetchone()
        assert row is not None
        stored_seed, chosen_agent, greedy_agent, exploratory, budget_micros, explore, retry_tolerant = row
        assert chosen_agent == pending.draw.chosen
        assert greedy_agent == pending.draw.greedy
        assert exploratory == pending.draw.exploratory
        assert budget_micros == pending.budget_micros
        assert explore == pending.mode.explore
        assert retry_tolerant == pending.mode.retry_tolerant

        replay = draw(
            arms,
            pending.budget_micros,
            pending.mode,
            settings.router_budget_tolerance,
            random.Random(int(stored_seed)),
        )
        assert replay.chosen == chosen_agent

    run(database_url, body)
