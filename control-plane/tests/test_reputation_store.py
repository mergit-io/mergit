"""Cost-adjusted reputation, SQL side: the observation log and the posteriors folded from it.
Run with `pytest -m postgres`.

This database is shared across the whole postgres test session (tests that don't use the `client` fixture
never truncate between tests -- see `tests/test_money.py`), so every seeding helper here takes a fresh,
random agent_id/category/requester/operator per test or hypothesis example, and every assertion is scoped
to those identifiers rather than to "the whole table". That is the same discipline `tests/test_money.py`
already uses (random `plan_uuid`/`task_id`), just extended to the aggregate `reputation_posteriors` rows,
which are keyed by (agent_id, category) rather than by a fresh id each time.
"""

from __future__ import annotations

import ast
import asyncio
import json
import random
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import mergit_receipt
import psycopg
import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hyp_settings
from hypothesis import strategies as st
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.reputation import Posterior, ReputationUpdater, in_probation, ingest_due, posterior, rebuild
from tests.test_api import phi
from tests.test_money import receive, run

pytestmark = pytest.mark.postgres

PACKAGE = Path(__file__).resolve().parents[1] / "mergit_cp"


def rand_hex_address() -> str:
    return "0x" + (uuid.uuid4().hex + uuid.uuid4().hex)[:40]


def rand_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def tx_n(i: int) -> str:
    return "0x" + format(i, "064x")


async def seed_task(
    pool: Pool,
    *,
    agent_id: str,
    category: str = "cat",
    requester: str | None = None,
    funding: str = "wallet",
    budget_usdc_units: int = 1_000_000,
) -> tuple[str, str, str]:
    """A funded plan with one task (index 0) and one dispatch, for one agent. Returns
    (plan_uuid, plan_id, task_id)."""
    requester = requester or rand_hex_address()
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    task_id = mergit_receipt.task_id(plan_id, 0, 1)
    task_phi = phi()
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
            " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
            " VALUES (%s, %s, %s, 'g', 'https://github.com/a/b', 'main', %s, %s, 'running', %s, %s,"
            " 'm', now())",
            (plan_uuid, plan_id, requester, category, budget_usdc_units, funding, budget_usdc_units),
        )
        await conn.execute(
            'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, phi_hash,'
            " budget_usdc_units, agents) VALUES (%s, 0, 't', 'do it', %s, %s, %s, %s)",
            (
                plan_uuid,
                Jsonb(task_phi),
                mergit_receipt.phi_hash(json.dumps(task_phi)),
                budget_usdc_units,
                [agent_id],
            ),
        )
        await conn.execute(
            'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
            " VALUES (%s, %s, 0, 1, %s)",
            (task_id, plan_uuid, agent_id),
        )
    return plan_uuid, plan_id, task_id


async def seed_cost(
    pool: Pool, *, task_id: str, plan_uuid: str, agent_id: str, cost_micros: int, receipt: bool = True
) -> None:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, phi_holds,'
            " receipt_root, cost_micros, finished_at)"
            " VALUES (%s, %s, 0, 1, %s, 'done', true, %s, %s, now())",
            (task_id, plan_uuid, agent_id, ("0x" + "a" * 64) if receipt else None, cost_micros),
        )


async def observations_for(pool: Pool, task_ids: list[str]) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute(
            "SELECT * FROM reputation_observations WHERE task_id = ANY(%s) ORDER BY id", (task_ids,)
        )
        return await cur.fetchall()


async def posteriors_for(pool: Pool, agent_ids: list[str]) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute(
            "SELECT * FROM reputation_posteriors WHERE agent_id = ANY(%s) ORDER BY agent_id, category",
            (agent_ids,),
        )
        return await cur.fetchall()


def test_pass_and_fail_update_the_category_and_agent_rows(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        category = rand_id("cat")
        requester = rand_hex_address()
        operators = {agent_id: rand_hex_address()}
        _, _, task1 = await seed_task(
            pool, agent_id=agent_id, category=category, requester=requester, budget_usdc_units=1_000_000
        )
        _, _, task2 = await seed_task(
            pool, agent_id=agent_id, category=category, requester=requester, budget_usdc_units=1_000_000
        )
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task1, "verdict": "pass", "tx": tx_n(1)}
        )
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task2, "verdict": "fail", "tx": tx_n(2)}
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        obs = await observations_for(pool, [task1, task2])
        assert [o["kind"] for o in obs] == ["outcome", "outcome"]
        assert [o["success"] for o in obs] == [True, False]
        assert obs[0]["weight"] == 1.0  # update_weight(1_000_000, 1_000_000, 0)
        assert obs[1]["weight"] == 0.5  # update_weight(1_000_000, 1_000_000, 1): same agent+requester

        # By hand: base_prior(200_000) = (1,1,1,200000); the category row pools from a still-fresh
        # agent-level row, which the floor binds to exactly base_prior too (test_pooled_prior_never_
        # narrower_than_base), so both rows start identical and track identically from here.
        p1 = Posterior(1, 1, 1, 200_000)
        p1 = Posterior(0.95 * p1.alpha + 1.0, 0.95 * p1.beta, p1.kappa, p1.tau)
        expected = Posterior(0.95 * p1.alpha, 0.95 * p1.beta + 0.5, p1.kappa, p1.tau)

        rows = await posteriors_for(pool, [agent_id])
        assert {(r["agent_id"], r["category"]) for r in rows} == {(agent_id, "*"), (agent_id, category)}
        for row in rows:
            assert row["alpha"] == pytest.approx(expected.alpha, abs=1e-9)
            assert row["beta"] == pytest.approx(expected.beta, abs=1e-9)
            assert row["kappa"] == pytest.approx(expected.kappa, abs=1e-9)
            assert row["tau"] == pytest.approx(expected.tau, abs=1e-9)
            assert row["outcomes"] == 2
            assert row["costs"] == 0

        async with pool.connection() as conn:
            got = await posterior(conn, agent_id, category, settings)
        assert got.alpha == pytest.approx(expected.alpha, abs=1e-9)
        assert got.beta == pytest.approx(expected.beta, abs=1e-9)

    run(database_url, body)


def test_credits_plan_produces_no_observation(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        _, _, pass_task = await seed_task(pool, agent_id=agent_id, funding="credits")
        cost_plan_uuid, _, cost_task = await seed_task(pool, agent_id=agent_id, funding="credits")
        _, _, invalid_task = await seed_task(pool, agent_id=agent_id, funding="credits")

        await receive(
            pool, settings, "verdict.recorded", {"task_id": pass_task, "verdict": "pass", "tx": tx_n(10)}
        )
        await seed_cost(
            pool, task_id=cost_task, plan_uuid=cost_plan_uuid, agent_id=agent_id, cost_micros=5000
        )
        await receive(
            pool,
            settings,
            "verdict.recorded",
            {"task_id": invalid_task, "verdict": "invalid", "tx": tx_n(11)},
        )

        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        assert await observations_for(pool, [pass_task, cost_task, invalid_task]) == []
        assert await posteriors_for(pool, [agent_id]) == []

    run(database_url, body)


def test_duplicate_verdict_is_one_observation(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        _, _, dup_task = await seed_task(pool, agent_id=agent_id)
        _, _, other_task = await seed_task(pool, agent_id=agent_id)

        await receive(
            pool, settings, "verdict.recorded", {"task_id": dup_task, "verdict": "pass", "tx": tx_n(20)}
        )
        await receive(
            pool, settings, "verdict.recorded", {"task_id": dup_task, "verdict": "pass", "tx": tx_n(21)}
        )
        await receive(
            pool, settings, "verdict.recorded", {"task_id": other_task, "verdict": "pass", "tx": tx_n(22)}
        )

        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        dup_obs = await observations_for(pool, [dup_task])
        other_obs = await observations_for(pool, [other_task])
        assert len(dup_obs) == 1
        assert len(other_obs) == 1

    run(database_url, body)


def test_verdict_for_unknown_task_is_skipped(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        plan_uuid, _, unknown_task = await seed_task(pool, agent_id=agent_id)
        # The task's own definition is gone (its dispatch and verdict remain): "unknown" from the
        # budget-join's point of view, the same way `money.py` treats an event naming a task this
        # service never dispatched at all.
        async with pool.connection() as conn, conn.transaction():
            await conn.execute('DELETE FROM tasks WHERE plan_uuid = %s AND "index" = 0', (plan_uuid,))
        _, _, known_task = await seed_task(pool, agent_id=agent_id)

        await receive(
            pool, settings, "verdict.recorded", {"task_id": unknown_task, "verdict": "pass", "tx": tx_n(30)}
        )
        await receive(
            pool, settings, "verdict.recorded", {"task_id": known_task, "verdict": "pass", "tx": tx_n(31)}
        )

        async with pool.connection() as conn, conn.transaction():
            n = await ingest_due(conn, settings, operators)
        assert n >= 1

        assert await observations_for(pool, [unknown_task]) == []
        assert len(await observations_for(pool, [known_task])) == 1

    run(database_url, body)


def test_invalid_is_falsification_not_failure(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        category = rand_id("cat")
        operator = rand_hex_address()
        operators = {agent_id: operator}
        _, _, task_id = await seed_task(pool, agent_id=agent_id, category=category)

        async with pool.connection() as conn:
            before = await posterior(conn, agent_id, category, settings)
        assert before == Posterior(1, 1, 1, settings.router_prior_cost_micros)

        observed_at = datetime.now(UTC)
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task_id, "verdict": "invalid", "tx": tx_n(40)}
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        obs = await observations_for(pool, [task_id])
        assert [o["kind"] for o in obs] == ["falsification"]

        async with pool.connection() as conn:
            after = await posterior(conn, agent_id, category, settings)
        assert after == before  # unchanged: no row was ever created in reputation_posteriors
        assert await posteriors_for(pool, [agent_id]) == []

        async with pool.connection() as conn:
            assert await in_probation(conn, operator, observed_at, int(settings.router_probation_s)) is True
            after_window = observed_at + timedelta(seconds=settings.router_probation_s + 1)
            assert await in_probation(conn, operator, after_window, int(settings.router_probation_s)) is False

    run(database_url, body)


def test_zero_cost_job_is_not_observed(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        plan_zero, _, zero_task = await seed_task(pool, agent_id=agent_id)
        plan_real, _, real_task = await seed_task(pool, agent_id=agent_id)

        await seed_cost(pool, task_id=zero_task, plan_uuid=plan_zero, agent_id=agent_id, cost_micros=0)
        await seed_cost(pool, task_id=real_task, plan_uuid=plan_real, agent_id=agent_id, cost_micros=5_000)

        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        assert await observations_for(pool, [zero_task]) == []
        real_obs = await observations_for(pool, [real_task])
        assert [o["kind"] for o in real_obs] == ["cost"]
        assert real_obs[0]["cost_micros"] == 5_000

    run(database_url, body)


async def _run_events(
    pool: Pool,
    settings: Settings,
    operators: dict[str, str],
    events: list[dict[str, Any]],
    tx_offset: int = 0,
) -> None:
    """Seed one task per event and feed it through ingest_due, one event at a time (so the test exercises
    the incremental apply path, not a single big batch)."""
    for i, ev in enumerate(events):
        plan_uuid, _, task_id = await seed_task(
            pool,
            agent_id=ev["agent"],
            category=ev["category"],
            requester=ev["requester"],
            budget_usdc_units=ev["budget"],
        )
        if ev["kind"] == "outcome":
            verdict = "pass" if ev["success"] else "fail"
            await receive(
                pool,
                settings,
                "verdict.recorded",
                {"task_id": task_id, "verdict": verdict, "tx": tx_n(tx_offset + i)},
            )
        elif ev["kind"] == "cost":
            await seed_cost(
                pool,
                task_id=task_id,
                plan_uuid=plan_uuid,
                agent_id=ev["agent"],
                cost_micros=ev["cost_micros"],
            )
        else:
            await receive(
                pool,
                settings,
                "verdict.recorded",
                {"task_id": task_id, "verdict": "invalid", "tx": tx_n(tx_offset + i)},
            )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators, limit=1000)


async def _assert_matches_rebuild(
    pool: Pool, settings: Settings, operators: dict[str, str], agents: list[str]
) -> None:
    async with pool.connection() as conn:
        rebuilt = await rebuild(conn, settings, operators)
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute(
            "SELECT agent_id, category, alpha, beta, kappa, tau FROM reputation_posteriors"
            " WHERE agent_id = ANY(%s)",
            (agents,),
        )
        stored = {
            (r["agent_id"], r["category"]): (r["alpha"], r["beta"], r["kappa"], r["tau"])
            for r in await cur.fetchall()
        }
    expected = {k: (p.alpha, p.beta, p.kappa, p.tau) for k, p in rebuilt.items() if k[0] in agents}
    assert stored.keys() == expected.keys()
    for key in expected:
        for got, want in zip(stored[key], expected[key], strict=True):
            assert got == pytest.approx(want, abs=1e-9)


_EVENT = st.fixed_dictionaries(
    {
        "kind": st.sampled_from(["outcome", "cost", "falsification"]),
        "agent": st.integers(0, 2),
        "category": st.integers(0, 1),
        "requester": st.integers(0, 1),
        "success": st.booleans(),
        "cost_micros": st.integers(1, 5_000_000),
        "budget": st.integers(1, 2_000_000),
    }
)


@given(st.lists(_EVENT, max_size=30))
@hyp_settings(deadline=None, max_examples=20, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_incremental_equals_rebuild(
    database_url: str, settings: Settings, events: list[dict[str, Any]]
) -> None:
    run_id = uuid.uuid4().hex[:10]
    agents = [f"ag-{run_id}-{i}" for i in range(3)]
    categories = [f"cat-{run_id}-{i}" for i in range(2)]
    requesters = ["0x" + (run_id + str(i)).rjust(40, "0") for i in range(2)]
    operators = {a: f"0x{run_id}{i:036x}" for i, a in enumerate(agents)}

    async def body(pool: Pool) -> None:
        resolved = [
            {
                "kind": ev["kind"],
                "agent": agents[ev["agent"]],
                "category": categories[ev["category"]],
                "requester": requesters[ev["requester"]],
                "success": ev["success"],
                "cost_micros": ev["cost_micros"],
                "budget": ev["budget"],
            }
            for ev in events
        ]
        await _run_events(pool, settings, operators, resolved)
        await _assert_matches_rebuild(pool, settings, operators, agents)

    run(database_url, body)


def test_concurrent_updaters_lose_nothing(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        run_id = uuid.uuid4().hex[:10]
        agents = [f"cc-{run_id}-{i}" for i in range(3)]
        categories = [f"cat-{run_id}-{i}" for i in range(2)]
        requester = "0x" + run_id.rjust(40, "0")
        operators = {a: f"0x{run_id}{i:036x}" for i, a in enumerate(agents)}
        rng = random.Random(f"concurrent-{run_id}")

        events: list[dict[str, Any]] = []
        for _ in range(40):
            kind = rng.choice(["outcome", "cost", "falsification"])
            events.append(
                {
                    "kind": kind,
                    "agent": rng.choice(agents),
                    "category": rng.choice(categories),
                    "requester": requester,
                    "success": rng.choice([True, False]),
                    "cost_micros": rng.randint(1, 5_000_000),
                    "budget": rng.randint(1, 2_000_000),
                }
            )
        # Create every underlying money_event/job row up front, unconsumed, then race two updaters over
        # the whole batch at once: ingest's ON CONFLICT DO NOTHING insert and the advisory-locked apply
        # step must leave exactly the same state a single-threaded run (or a full rebuild) would.
        for i, ev in enumerate(events):
            plan_uuid, _, task_id = await seed_task(
                pool,
                agent_id=ev["agent"],
                category=ev["category"],
                requester=ev["requester"],
                budget_usdc_units=ev["budget"],
            )
            if ev["kind"] == "outcome":
                verdict = "pass" if ev["success"] else "fail"
                await receive(
                    pool,
                    settings,
                    "verdict.recorded",
                    {"task_id": task_id, "verdict": verdict, "tx": tx_n(i)},
                )
            elif ev["kind"] == "cost":
                await seed_cost(
                    pool,
                    task_id=task_id,
                    plan_uuid=plan_uuid,
                    agent_id=ev["agent"],
                    cost_micros=ev["cost_micros"],
                )
            else:
                await receive(
                    pool,
                    settings,
                    "verdict.recorded",
                    {"task_id": task_id, "verdict": "invalid", "tx": tx_n(i)},
                )

        async def updater() -> None:
            async with pool.connection() as conn, conn.transaction():
                await ingest_due(conn, settings, operators, limit=200)

        await asyncio.gather(updater(), updater())
        await asyncio.gather(updater(), updater())  # a second round: nothing left to apply, must be a no-op

        await _assert_matches_rebuild(pool, settings, operators, agents)

    run(database_url, body)


def test_observation_log_is_append_only(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        _, _, task_id = await seed_task(pool, agent_id=agent_id)
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task_id, "verdict": "pass", "tx": tx_n(50)}
        )
        async with pool.connection() as conn, conn.transaction():
            await ingest_due(conn, settings, operators)

        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
                await conn.execute(
                    "UPDATE reputation_observations SET success = false WHERE task_id = %s", (task_id,)
                )
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
                await conn.execute("DELETE FROM reputation_observations WHERE task_id = %s", (task_id,))

        obs = await observations_for(pool, [task_id])
        assert obs[0]["success"] is True

    run(database_url, body)


def test_reputation_updater_ingests_through_the_pool(database_url: str, settings: Settings) -> None:
    async def body(pool: Pool) -> None:
        agent_id = rand_id("agent")
        operators = {agent_id: rand_hex_address()}
        _, _, task_id = await seed_task(pool, agent_id=agent_id)
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task_id, "verdict": "pass", "tx": tx_n(60)}
        )

        updater = ReputationUpdater(pool, settings, operators)
        n = await updater.ingest_due()
        assert n >= 1
        assert len(await observations_for(pool, [task_id])) == 1

    run(database_url, body)


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            names |= {node.module or ""} | {a.name for a in node.names}
        elif isinstance(node, ast.Import):
            names |= {a.name for a in node.names}
    return names


def test_reputation_writes_only_its_tables() -> None:
    source = (PACKAGE / "reputation.py").read_text()
    # "ON CONFLICT (...) DO UPDATE SET ..." makes the generic UPDATE-target regex capture "SET" as a
    # (bogus) table name; filter it out rather than write a regex that special-cases that clause.
    writes = {
        m.lower()
        for m in re.findall(r"(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(\w+)", source, re.I)
        if m.lower() != "set"
    }
    assert writes <= {"reputation_observations", "reputation_posteriors", "reputation_applied"}
    imported = {name.rsplit(".", 1)[-1] for name in _imports(PACKAGE / "reputation.py")}
    assert imported.isdisjoint({"money", "dispatch", "outcomes", "graph", "plans"})
