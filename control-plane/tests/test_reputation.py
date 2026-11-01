"""Costs are read from the gateway, posteriors are folded from counted outcomes, and a rebuild always agrees.

Run with `pytest -m postgres`.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import pytest
from psycopg.rows import dict_row

from mergit_cp.config import Settings
from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.reputation import GatewayCosts, record_missing_costs, refresh_posteriors
from mergit_cp.reputation_model import Params, Posterior
from tests.test_api import seed_plan
from tests.test_money import receive, tx
from tests.test_reputation_outcomes import challenge, released, verdict

pytestmark = pytest.mark.postgres
REQUESTER = "0x" + "1" * 40


def run(database_url: str, body: Callable[[Pool], Awaitable[None]]) -> None:
    """Like the other ledger tests, but on an emptied database: the posteriors are global, so a neighbour's
    outcomes would otherwise be in them."""

    async def go() -> None:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
                cur = await conn.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                    " AND tablename <> 'schema_migrations'"
                )
                tables = [r[0] for r in await cur.fetchall()]
                await conn.execute("TRUNCATE " + ", ".join(tables) + " CASCADE")
            await body(pool)
        finally:
            await pool.close()

    asyncio.run(go())


def gateway(costs: dict[str, str] | None = None, status: int = 200, raw: Any = None) -> GatewayCosts:
    """A gateway that answers ``?task_id=`` from ``costs`` (task id -> cost_micros)."""

    def handle(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status)
        if raw is not None:
            return httpx.Response(200, json=raw)
        known = costs or {}
        task_id = request.url.params["task_id"]
        if task_id not in known:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"task_id": task_id, "cost_micros": known[task_id]}])

    return GatewayCosts(
        "http://gateway.test", client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )


async def posteriors(pool: Pool) -> dict[tuple[str, str], dict[str, Any]]:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute("SELECT * FROM agent_posteriors")
        return {(r["agent_id"], r["category"]): r for r in await cur.fetchall()}


def prior(settings: Settings) -> Posterior:
    return Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))


def test_posteriors_are_the_decayed_fold_of_counted_outcomes_in_order(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await verdict(pool, settings, tasks[1], "fail", "3")
        costs = gateway({tasks[0]: "400000", tasks[1]: "600000"})
        assert await record_missing_costs(pool, costs) == 2
        assert await refresh_posteriors(pool, settings) == 1

        expected = prior(settings).observe(True, 400000.0).observe(False, 600000.0)
        got = (await posteriors(pool))[("1", "test-repair")]
        for name in ("alpha", "beta", "kappa", "tau"):
            assert got[name] == pytest.approx(getattr(expected, name))
        assert got["n"] == 2

    run(database_url, body)


def test_an_outcome_whose_cost_is_not_known_yet_waits_and_is_never_taken_as_free(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        # The gateway has not seen the commitment (empty list), is down, or answers nonsense.
        for costs in (gateway({}), gateway(status=503), gateway(raw={"not": "a list"}), gateway(raw=[{}])):
            assert await record_missing_costs(pool, costs) == 0
        await refresh_posteriors(pool, settings)
        assert await posteriors(pool) == {}
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) FROM task_costs WHERE task_id = %s", (tasks[0],))
            row = await cur.fetchone()
            assert row is not None and row[0] == 0

        assert await record_missing_costs(pool, gateway({tasks[0]: "250000"})) == 1
        await refresh_posteriors(pool, settings)
        assert ("1", "test-repair") in await posteriors(pool)

    run(database_url, body)


def test_a_gateway_answer_for_another_task_or_a_negative_cost_is_refused(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        other = [{"task_id": "0x" + "9" * 64, "cost_micros": "1"}]
        assert await record_missing_costs(pool, gateway(raw=other)) == 0
        assert await record_missing_costs(pool, gateway({tasks[0]: "-5"})) == 0

    run(database_url, body)


def test_work_funded_from_free_credits_never_moves_a_posterior(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, tasks = await seed_plan(pool, requester=REQUESTER)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (plan_uuid,))
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await verdict(pool, settings, tasks[1], "fail", "3")
        await record_missing_costs(pool, gateway({tasks[0]: "1", tasks[1]: "1"}))
        assert await refresh_posteriors(pool, settings) == 0
        assert await posteriors(pool) == {}
        async with pool.connection() as conn:  # the outcomes are recorded and visible, just not counted
            cur = await conn.execute("SELECT count(*) FROM task_outcomes WHERE funding = 'credits'")
            row = await cur.fetchone()
            assert row is not None and row[0] == 2

    run(database_url, body)


def test_an_upheld_challenge_changes_the_posterior_the_same_way_a_rebuild_would(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await record_missing_costs(pool, gateway({tasks[0]: "400000"}))
        await refresh_posteriors(pool, settings)
        before = (await posteriors(pool))[("1", "test-repair")]
        assert before["alpha"] == pytest.approx(prior(settings).observe(True, 400000.0).alpha)

        await challenge(pool, settings, tasks[0], upheld=True, t="3")
        await refresh_posteriors(pool, settings)
        after = (await posteriors(pool))[("1", "test-repair")]
        expected = prior(settings).observe(False, 400000.0)  # one outcome, now a failure, not two
        assert (after["alpha"], after["beta"], after["n"]) == (
            pytest.approx(expected.alpha),
            pytest.approx(expected.beta),
            1,
        )

    run(database_url, body)


def test_a_rebuild_agrees_with_the_incremental_refreshes(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER, n_tasks=3)
        costs = gateway({t: str(100000 * (i + 1)) for i, t in enumerate(tasks)})
        for i, task in enumerate(tasks):
            await verdict(pool, settings, task, "fail" if i == 1 else "pass", str(i))
            if i != 1:
                await released(pool, settings, task, "abc"[i])
            await record_missing_costs(pool, costs)
            await refresh_posteriors(pool, settings)  # one refresh after every outcome
        incremental = await posteriors(pool)
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM agent_posteriors")
        await refresh_posteriors(pool, settings)
        rebuilt = await posteriors(pool)
        assert rebuilt.keys() == incremental.keys()
        for key, row in rebuilt.items():
            for name in ("alpha", "beta", "kappa", "tau", "n"):
                assert row[name] == pytest.approx(incremental[key][name])

    run(database_url, body)


def test_a_refresh_does_not_touch_the_task_graph(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, tasks[0], "fail", "1")
        await receive(pool, settings, "receipt.committed", {"task_id": tasks[1], "tx": tx("2")})

        async def snapshot() -> list[Any]:
            async with pool.connection() as conn:
                out: list[Any] = []
                for table in ("plans", "tasks", "task_dispatches", "jobs"):
                    cur = await conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")
                    out.append(await cur.fetchall())
                return out

        before = await snapshot()
        await record_missing_costs(pool, gateway({tasks[0]: "1"}))
        await refresh_posteriors(pool, settings)
        assert await snapshot() == before

    run(database_url, body)
