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
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import mergit_receipt
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import SecretStr

from mergit_cp import plans as plans_module
from mergit_cp import routing
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.dispatch import DISPATCH_DEADLINE_S
from mergit_cp.reputation import Posterior, ingest_due
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
    pool: Pool,
    *,
    plan_uuid: str,
    plan_id: str,
    agent_id: str,
    index: int = 0,
    attempt: int = 1,
    dispatched_at: datetime | None = None,
) -> str:
    """One extra `task_dispatches` row, for a plan/task already seeded (by `seed_plan` or `seed_task`).
    Returns the task_id. `dispatched_at` overrides the default `now()`, for testing the staleness
    carve-out against `dispatch.DISPATCH_DEADLINE_S`."""
    task_id = mergit_receipt.task_id(plan_id, index, attempt)
    async with pool.connection() as conn, conn.transaction():
        if dispatched_at is None:
            await conn.execute(
                'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
                " VALUES (%s, %s, %s, %s, %s)",
                (task_id, plan_uuid, index, attempt, agent_id),
            )
        else:
            await conn.execute(
                'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id,'
                " dispatched_at) VALUES (%s, %s, %s, %s, %s, %s)",
                (task_id, plan_uuid, index, attempt, agent_id, dispatched_at),
            )
    return task_id


async def seed_error_job(
    pool: Pool, *, task_id: str, plan_uuid: str, agent_id: str, receipt_root: str | None = None
) -> None:
    """A job that errored. With `receipt_root=None` (the default), nothing was ever sealed and it must
    not count toward either cap; with a `receipt_root` given, something *was* sealed before the attempt
    ended in error, and it must still count (that's exactly the forgery-relevant case the exclusion is
    meant to carve around, not a blanket "errored jobs never count" rule)."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, receipt_root,'
            " finished_at) VALUES (%s, %s, 0, 1, %s, 'error', %s, now())",
            (task_id, plan_uuid, agent_id, receipt_root),
        )


async def seed_routing_draw(pool: Pool, *, task_id: str, chosen_agent: str, exploratory: bool) -> None:
    samples: dict[str, object] = {"arms": [], "original_chosen": None}
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO routing_draws (task_id, seed, explore, retry_tolerant, budget_micros, samples,"
            " ineligible, chosen_agent, greedy_agent, exploratory)"
            " VALUES (%s, '1', true, true, 1000000, %s, %s, %s, %s, %s)",
            (task_id, Jsonb(samples), Jsonb({}), chosen_agent, chosen_agent, exploratory),
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


def test_errored_sealed_job_still_counts_toward_cap(database_url: str, agents_files: Roster) -> None:
    settings = _settings(agents_files, database_url, router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(
            pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agents_files.a1
        )
        # Something WAS sealed before this attempt ended in error -- unlike the unsealed case above, this
        # still counts: there is a receipt that could in principle be forged/disputed, so the operator is
        # not free to take on more concurrent work until it is resolved by a real money event.
        await seed_error_job(
            pool,
            task_id=noise_task,
            plan_uuid=noise_uuid,
            agent_id=agents_files.a1,
            receipt_root="0x" + "ab" * 32,
        )

        routed_uuid, _ = await seed_plan(pool)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}
        assert ineligible[agents_files.a1] == "operator at concurrency cap"
        assert ineligible[agents_files.a2] == "operator at concurrency cap"

    run(database_url, body)


def test_stale_unescrowed_dispatch_does_not_count_toward_cap(database_url: str, agents_files: Roster) -> None:
    """Fix round 1, Finding 1: a dispatch that never escrows (no `jobs` row ever arrives) must stop
    counting against its operator once it is older than `dispatch.DISPATCH_DEADLINE_S` -- otherwise a
    handful of rejected/expired dispatches would permanently exclude an operator with no error anywhere."""

    settings = _settings(agents_files, database_url, router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        stale_uuid, stale_id = await seed_plan(pool)
        stale_at = datetime.now(UTC) - timedelta(seconds=DISPATCH_DEADLINE_S + 60)
        await seed_dispatch(
            pool,
            plan_uuid=stale_uuid,
            plan_id=stale_id,
            agent_id=agents_files.a1,
            dispatched_at=stale_at,
        )

        routed_uuid, _ = await seed_plan(pool)
        plan = await load_plan(pool, routed_uuid)

        # The stale, never-escrowed dispatch alone does not trip the cap.
        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {
            agents_files.a1,
            agents_files.a2,
            agents_files.b1,
            agents_files.c1,
        }
        assert ineligible == {}

        # A second, FRESH never-escrowed dispatch for the same operator -- still within its deadline --
        # does still count, and alone trips cap=1.
        fresh_uuid, fresh_id = await seed_plan(pool)
        await seed_dispatch(pool, plan_uuid=fresh_uuid, plan_id=fresh_id, agent_id=agents_files.a1)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}
        assert ineligible[agents_files.a1] == "operator at concurrency cap"
        assert ineligible[agents_files.a2] == "operator at concurrency cap"

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
    """Only the agent actually dispatched on this index is excluded -- its operator's OTHER agent stays
    eligible. (Marking both of the operator's agents as already-tried, as an earlier version of this test
    did, could not tell a correct per-agent rule apart from a wrong per-operator one.)"""

    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        plan_uuid, plan_id = await seed_plan(pool)
        await seed_dispatch(pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=agents_files.a1, attempt=1)
        plan = await load_plan(pool, plan_uuid)

        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert {a.agent_id for a in arms} == {agents_files.a2, agents_files.b1, agents_files.c1}
        assert ineligible == {agents_files.a1: "already tried on this task"}

    run(database_url, body)


# --- route(): the draw, the exploration cap, and the cross-task None-greedy constraint ---------------


def test_explore_cap_falls_back_to_greedy(
    database_url: str, agents_files: Roster, monkeypatch: pytest.MonkeyPatch
) -> None:
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

        monkeypatch.setattr(routing, "secrets", _FixedSecrets(seed_value))

        async def route_with(s: Settings) -> routing.PendingDraw | None:
            async with pool.connection() as conn:
                return await routing.route(conn, plan, 0, 1, s)

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


def test_explore_cap_hit_with_no_greedy_returns_none(
    database_url: str, single_agent_files: Roster, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(single_agent_files, database_url, router_explore_cap_per_operator=2)
    capped_settings = _settings(single_agent_files, database_url, router_explore_cap_per_operator=1)
    agent = single_agent_files.a1

    async def body(pool: Pool) -> None:
        noise_uuid, noise_id = await seed_plan(pool)
        noise_task = await seed_dispatch(pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agent)
        await seed_routing_draw(pool, task_id=noise_task, chosen_agent=agent, exploratory=True)

        # A budget well below the agent's prior mean cost (200_000 micros, kappa=1): mean cost is always
        # infeasible (`greedy` is always None), but kappa=1 gives an exponential-shaped sampled-cost
        # distribution with enough mass near small values that a feasible *sample* is still findable. It
        # must stay above `router_min_feasible_probability` (final review C1): this budget gives
        # exp(-200_000 / 66_000), about 0.048 per draw, so the agent is still eligible, not "over budget for
        # this task" (36_000, this test's old budget, gives about 0.0064 and would now be excluded).
        budget = 60_000
        routed_uuid, _ = await seed_plan(pool, budget_usdc_units=budget)
        plan = await load_plan(pool, routed_uuid)

        async with pool.connection() as conn:
            arms, _ = await routing.candidates(conn, plan, 0, settings)
            assert not await routing.budget_infeasible(conn, plan, 0, settings)
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

        monkeypatch.setattr(routing, "secrets", _FixedSecrets(seed_value))

        async def route_with(s: Settings) -> routing.PendingDraw | None:
            async with pool.connection() as conn:
                return await routing.route(conn, plan, 0, 1, s)

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


def test_draw_is_recorded_with_seed_and_replays(
    database_url: str, agents_files: Roster, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fix round 1, Finding 3: a `routing_draws` row must be able to replay its own draw from the STORED
    row alone -- `reputation_posteriors` mutates in place over time, so a fresh `candidates()`/`posterior()`
    call against the live database would not actually prove anything about the stored record once those
    posteriors have moved on. This reconstructs `Arm`s purely from `samples.arms`' stored
    alpha/beta/kappa/tau, never touching `candidates()`/`posterior()` again."""

    # A non-default tolerance (final review m6): the replay below must read it from the row, not from the
    # settings. 0.37 is what `route` drew with; the replay deliberately has no other way to know that.
    settings = _settings(agents_files, database_url, router_budget_tolerance=0.37)

    async def body(pool: Pool) -> None:
        plan_uuid, plan_id = await seed_plan(pool, budget_usdc_units=1_000_000)
        plan = await load_plan(pool, plan_uuid)

        # Pick a seed whose draw the tolerance actually decides: some arm's sampled cost lies between
        # 1.1x and 1.37x the budget, so replaying with the default 0.1 instead of the stored 0.37 would
        # give a different feasibility picture. Without that, this test could not tell the two apart.
        async with pool.connection() as conn:
            arms, _ = await routing.candidates(conn, plan, 0, settings)
        mode = Mode(explore=True, retry_tolerant=True)

        def _feasibility(seed: int, tolerance: float) -> list[bool]:
            return [s.feasible for s in draw(arms, 1_000_000, mode, tolerance, random.Random(seed)).samples]

        seed_value = next(
            seed
            for seed in range(5000)
            if draw(arms, 1_000_000, mode, 0.37, random.Random(seed)).chosen is not None
            and _feasibility(seed, 0.37) != _feasibility(seed, 0.1)
        )
        monkeypatch.setattr(routing, "secrets", _FixedSecrets(seed_value))

        async with pool.connection() as conn:
            pending = await routing.route(conn, plan, 0, 1, settings)
        assert pending is not None
        assert pending.draw.chosen is not None

        task_id = await seed_dispatch(
            pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=pending.draw.chosen
        )
        async with pool.connection() as conn, conn.transaction():
            await routing.record_draw(conn, task_id, pending)

        async with pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT seed, chosen_agent, greedy_agent, exploratory, budget_micros, explore,"
                " retry_tolerant, samples FROM routing_draws WHERE task_id = %s",
                (task_id,),
            )
            row = await cur.fetchone()
        assert row is not None
        assert row["chosen_agent"] == pending.draw.chosen
        assert row["greedy_agent"] == pending.draw.greedy
        assert row["exploratory"] == pending.draw.exploratory
        assert row["budget_micros"] == pending.budget_micros
        assert row["explore"] == pending.mode.explore
        assert row["retry_tolerant"] == pending.mode.retry_tolerant
        assert row["samples"]["original_chosen"] == pending.original_chosen

        # Reconstruct the exact Arms `route()` drew over purely from the stored posterior parameters --
        # never a fresh `candidates()`/`posterior()` call against the live database, which is the whole
        # point: this must prove the row is self-sufficient, independent of whatever the live posteriors
        # have since moved on to.
        stored_arms = [
            Arm(
                agent_id=a["agent_id"],
                posterior=Posterior(alpha=a["alpha"], beta=a["beta"], kappa=a["kappa"], tau=a["tau"]),
            )
            for a in row["samples"]["arms"]
        ]
        assert {a.agent_id for a in stored_arms} == {a.agent_id for a in pending.arms}
        stored_mode = Mode(explore=row["explore"], retry_tolerant=row["retry_tolerant"])

        assert row["samples"]["budget_tolerance"] == 0.37
        replay = draw(
            stored_arms,
            row["budget_micros"],
            stored_mode,
            row["samples"]["budget_tolerance"],
            random.Random(int(row["seed"])),
        )
        assert replay.chosen == row["chosen_agent"]
        assert replay.greedy == row["greedy_agent"]
        # Every arm's sampled feasibility replays too, which is the part the tolerance actually decides --
        # and replaying with the setting's default instead of the stored value would not reproduce it.
        assert [s.feasible for s in replay.samples] == [a["feasible"] for a in row["samples"]["arms"]]
        wrong = draw(stored_arms, row["budget_micros"], stored_mode, 0.1, random.Random(int(row["seed"])))
        assert [s.feasible for s in wrong.samples] != [a["feasible"] for a in row["samples"]["arms"]]

    run(database_url, body)


# --- final review C1/m1: over budget is structural, and told apart from waiting -----------------------


async def seed_cost_posterior(
    pool: Pool, *, agent_id: str, category: str, cost_mean_micros: float, kappa: float = 20.0
) -> None:
    """A learned cost: a `reputation_posteriors` row for `(agent_id, category)` whose mean cost is
    `cost_mean_micros`, with `kappa` worth of evidence behind it (20: the steady state under gamma 0.95)."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO reputation_posteriors (agent_id, category, alpha, beta, kappa, tau, outcomes, costs)"
            " VALUES (%s, %s, 5, 5, %s, %s, 10, 20)",
            (agent_id, category, kappa, kappa * cost_mean_micros),
        )


def test_over_budget_agent_is_excluded_ahead_of_transient_reasons(
    database_url: str, agents_files: Roster
) -> None:
    """An agent no draw will realistically pick for this budget is left out with the real reason
    `routing.OVER_BUDGET` (the string the run screen shows), checked before probation and the cap, so a
    transient reason always means "would be drawable once it clears". An agent merely over budget *by mean*
    stays eligible: exploration may still sample it under budget."""
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        category = rand_id("cat")
        # Operator A goes into probation (a1 and a2 both run under it).
        _, _, falsified_task = await seed_task(pool, agent_id=agents_files.a2, category=category)
        await receive(
            pool,
            settings,
            "verdict.recorded",
            {
                "task_id": falsified_task,
                "verdict": "invalid",
                "tx": "0x" + format(random.getrandbits(250), "064x"),
            },
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, {agents_files.a2: agents_files.op_a})

        # a1: learned $1.00 against a $0.50 budget, about 0.0012 per draw -- over budget, and that must win
        # over its operator's probation. b1: learned $0.80, about 0.04 per draw -- over by mean only.
        await seed_cost_posterior(
            pool, agent_id=agents_files.a1, category=category, cost_mean_micros=1_000_000
        )
        await seed_cost_posterior(pool, agent_id=agents_files.b1, category=category, cost_mean_micros=800_000)

        plan_uuid, _ = await seed_plan(pool, category=category, budget_usdc_units=500_000)
        plan = await load_plan(pool, plan_uuid)
        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
        assert ineligible == {agents_files.a1: routing.OVER_BUDGET, agents_files.a2: routing.IN_PROBATION}
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}

    run(database_url, body)


def test_budget_infeasible_tells_structural_from_transient(database_url: str, agents_files: Roster) -> None:
    """Final review C1: `route` returns None for two different reasons; `budget_infeasible` must say which.
    Cold roster throughout (every agent's mean cost is the $0.20 prior)."""
    settings = _settings(agents_files, database_url, router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        async def check(budget: int, explore: bool) -> tuple[bool, routing.PendingDraw | None]:
            plan_uuid, _ = await seed_plan(pool, budget_usdc_units=budget, explore=explore)
            plan = await load_plan(pool, plan_uuid)
            async with pool.connection() as conn:
                infeasible = await routing.budget_infeasible(conn, plan, 0, settings)
                pending = await routing.route(conn, plan, 0, 1, settings)
            return infeasible, pending

        # Structural, exploring off: $0.10 is under every agent's $0.20 mean, so greedy (= chosen) is None.
        infeasible, pending = await check(100_000, explore=False)
        assert infeasible is True
        assert pending is None

        # Same budget, exploring on: each draw has about a 16% chance per agent of sampling under budget,
        # so this is slow, not stuck -- the classification must not call it structural.
        infeasible, _ = await check(100_000, explore=True)
        assert infeasible is False

        # Exploring on, $0.01: about 1e-8 per draw. Every agent is over budget; nothing can be drawn.
        infeasible, pending = await check(10_000, explore=True)
        assert infeasible is True
        assert pending is None

        # Transient: a budget every agent fits, but every operator at its cap of 1. route() is None here
        # too, and that must NOT read as structural.
        for agent in (agents_files.a1, agents_files.b1, agents_files.c1):
            noise_uuid, noise_id = await seed_plan(pool)
            await seed_dispatch(pool, plan_uuid=noise_uuid, plan_id=noise_id, agent_id=agent)
        infeasible, pending = await check(1_000_000, explore=False)
        assert pending is None
        assert infeasible is False

    run(database_url, body)


def test_budget_infeasible_once_the_only_fitting_agent_was_tried(
    database_url: str, agents_files: Roster
) -> None:
    """The retry shape of C1: every agent but c1 has a learned cost over the budget, so once c1 has been
    tried on the index there is nothing left that fits -- even though three roster agents are untried."""
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        category = rand_id("cat")
        for agent in (agents_files.a1, agents_files.a2, agents_files.b1):
            await seed_cost_posterior(pool, agent_id=agent, category=category, cost_mean_micros=1_000_000)
        plan_uuid, plan_id = await seed_plan(
            pool, category=category, budget_usdc_units=500_000, explore=False
        )
        plan = await load_plan(pool, plan_uuid)

        async with pool.connection() as conn:
            assert await routing.budget_infeasible(conn, plan, 0, settings) is False
        await seed_dispatch(pool, plan_uuid=plan_uuid, plan_id=plan_id, agent_id=agents_files.c1)
        async with pool.connection() as conn:
            assert await routing.budget_infeasible(conn, plan, 0, settings) is True
            assert await routing.route(conn, plan, 0, 2, settings) is None

    run(database_url, body)


def test_credits_plan_falsification_puts_the_operator_in_probation_for_wallet_routing(
    database_url: str, agents_files: Roster
) -> None:
    """Final review M3: operator A's only history is one forged receipt on a CREDITS-funded plan -- no
    wallet-plan observation of any kind. Invariant 6 keeps credits work from earning reputation, but a
    proven falsification is not reputation earned: it must still put the operator in probation, so it is
    not drawn for wallet-funded work. Before the fix, the falsification was filtered out with the rest of
    the credits plan's observations, and the forger stayed fully routable."""
    settings = _settings(agents_files, database_url)

    async def body(pool: Pool) -> None:
        category = rand_id("cat")
        _, _, forged = await seed_task(pool, agent_id=agents_files.a1, category=category, funding="credits")
        await receive(
            pool,
            settings,
            "verdict.recorded",
            {"task_id": forged, "verdict": "invalid", "tx": "0x" + format(random.getrandbits(250), "064x")},
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, {agents_files.a1: agents_files.op_a})

        routed_uuid, _ = await seed_plan(pool, category=category)  # wallet-funded
        plan = await load_plan(pool, routed_uuid)
        async with pool.connection() as conn:
            arms, ineligible = await routing.candidates(conn, plan, 0, settings)
            posteriors = await (
                await conn.execute(
                    "SELECT count(*) FROM reputation_posteriors WHERE agent_id = %s", (agents_files.a1,)
                )
            ).fetchone()
        assert ineligible == {
            agents_files.a1: routing.IN_PROBATION,
            agents_files.a2: routing.IN_PROBATION,
        }
        assert {a.agent_id for a in arms} == {agents_files.b1, agents_files.c1}
        assert posteriors == (0,)  # still no reputation from the credits plan, only the probation

    run(database_url, body)
