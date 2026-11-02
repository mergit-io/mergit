"""Which tasks count as validated outcomes (invariant 4) and which work is faucet-tier (invariant 6).

The view ``task_outcomes`` is the only place the rule lives; the posteriors are folded from it.
Run with `pytest -m postgres`.
"""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from mergit_cp.config import Settings
from mergit_cp.db import Pool
from tests.test_api import seed_plan
from tests.test_money import ADDR, receive, run, tx

pytestmark = pytest.mark.postgres


async def verdict(pool: Pool, s: Settings, task: str, v: str, t: str) -> None:
    await receive(pool, s, "verdict.recorded", {"task_id": task, "verdict": v, "tx": tx(t)})


async def released(pool: Pool, s: Settings, task: str, t: str) -> None:
    await receive(
        pool,
        s,
        "task.released",
        {"task_id": task, "to": ADDR, "amount_usdc_units": "500000", "tx": tx(t)},
    )


async def challenge(pool: Pool, s: Settings, task: str, upheld: bool, t: str) -> None:
    await receive(
        pool,
        s,
        "challenge.opened",
        {
            "task_id": task,
            "challenge_id": "7",
            "challenger": ADDR,
            "bond_usdc_units": "100000",
            "tx": tx(t),
        },
    )
    await receive(
        pool,
        s,
        "challenge.resolved",
        {"task_id": task, "challenge_id": "7", "upheld": upheld, "tx": tx("f")},
    )


async def outcomes(pool: Pool, tasks: list[str]) -> dict[str, dict[str, Any]]:
    """The view's rows for these tasks only (the tests share one database)."""
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute("SELECT * FROM task_outcomes WHERE task_id = ANY(%s)", (tasks,))
        return {r["task_id"]: r for r in await cur.fetchall()}


async def ledger_id(pool: Pool, task: str, kind: str) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT id FROM money_events WHERE task_id = %s AND kind = %s", (task, kind))
        row = await cur.fetchone()
        assert row is not None
        return int(row[0])


@pytest.mark.parametrize("bad", ["fail", "invalid"])
def test_a_failing_verdict_is_a_failure(database_url: str, settings: Settings, bad: str):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], bad, "1")
        got = (await outcomes(pool, tasks))[tasks[0]]
        assert got["success"] is False
        assert (got["agent_id"], got["category"], got["funding"]) == ("1", "test-repair", "wallet")

    run(database_url, body)


def test_a_pass_that_was_released_is_a_success(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        got = (await outcomes(pool, tasks))[tasks[0]]
        assert got["success"] is True
        assert got["position"] == await ledger_id(pool, tasks[0], "task.released")

    run(database_url, body)


def test_a_challenge_that_is_upheld_turns_a_passed_task_into_one_failure(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await challenge(pool, settings, tasks[0], upheld=True, t="3")
        got = await outcomes(pool, tasks)
        assert len(got) == 1  # counted once, as the adjudicated outcome, not a success and then a failure
        assert got[tasks[0]]["success"] is False
        # It keeps the position of the release, so replaying the ledger is deterministic.
        assert got[tasks[0]]["position"] == await ledger_id(pool, tasks[0], "task.released")

    run(database_url, body)


def test_a_challenge_that_is_rejected_leaves_the_success(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], "pass", "1")
        await released(pool, settings, tasks[0], "2")
        await challenge(pool, settings, tasks[0], upheld=False, t="3")
        assert (await outcomes(pool, tasks))[tasks[0]]["success"] is True

    run(database_url, body)


def test_work_nobody_validated_is_not_evidence(database_url: str, settings: Settings):
    """A release with no verdict (unaudited), a deadline return, a verdict with no release, a bare receipt."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40, n_tasks=4)
        await released(pool, settings, tasks[0], "1")
        await receive(
            pool,
            settings,
            "task.returned",
            {"task_id": tasks[1], "amount_usdc_units": "500000", "reason": "deadline", "tx": tx("2")},
        )
        await verdict(pool, settings, tasks[2], "pass", "3")
        await receive(pool, settings, "receipt.committed", {"task_id": tasks[3], "tx": tx("4")})
        assert await outcomes(pool, tasks) == {}

    run(database_url, body)


def test_faucet_tier_work_is_carried_with_its_funding(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (plan_uuid,))
        await verdict(pool, settings, tasks[0], "fail", "1")
        assert (await outcomes(pool, tasks))[tasks[0]]["funding"] == "credits"

    run(database_url, body)


def test_cost_comes_from_the_recorded_commitment_and_is_empty_until_then(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], "fail", "1")
        assert (await outcomes(pool, tasks))[tasks[0]]["cost_micros"] is None
        async with pool.connection() as conn:
            await conn.execute(
                "INSERT INTO task_costs (task_id, cost_micros) VALUES (%s, 123456)", (tasks[0],)
            )
        assert (await outcomes(pool, tasks))[tasks[0]]["cost_micros"] == 123456

    run(database_url, body)


def test_a_recorded_cost_cannot_be_changed_or_removed(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        async with pool.connection() as conn:
            await conn.execute("INSERT INTO task_costs (task_id, cost_micros) VALUES (%s, 5)", (tasks[0],))
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="write-once"):
                await conn.execute("UPDATE task_costs SET cost_micros = 1 WHERE task_id = %s", (tasks[0],))
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="write-once"):
                await conn.execute("DELETE FROM task_costs WHERE task_id = %s", (tasks[0],))

    run(database_url, body)
