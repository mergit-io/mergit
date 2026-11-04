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


def _scans(plan: dict[str, Any]) -> list[tuple[str, str | None]]:
    """Every (relation, index) a JSON EXPLAIN plan reads, depth first."""
    found: list[tuple[str, str | None]] = []
    if "Relation Name" in plan:
        found.append((plan["Relation Name"], plan.get("Index Name")))
    for child in plan.get("Plans", []):
        found.extend(_scans(child))
    return found


@pytest.mark.parametrize(
    "query",
    [
        # record_missing_costs, every REPUTATION_POLL_S
        "SELECT task_id FROM task_outcomes WHERE cost_micros IS NULL ORDER BY position LIMIT 50",
        # the credit-only count behind the unauthenticated GET /v0/agents/reputation
        "SELECT agent_id, category, count(*) FROM task_outcomes WHERE funding = 'credits'"
        " GROUP BY agent_id, category",
    ],
)
def test_the_outcome_view_finds_each_tasks_ledger_rows_through_an_index(
    database_url: str, settings: Settings, query: str
):
    """Each of the view's per-task lookups into ``money_events`` must be an index lookup on the task, not a
    walk of the whole ledger: otherwise the view costs tasks x ledger (12 s at 4k tasks / 12k events)."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await verdict(pool, settings, tasks[0], "fail", "1")
        async with pool.connection() as conn, conn.transaction():
            await conn.execute("SET LOCAL enable_seqscan = off")  # the tables are tiny; ask for the shape
            cur = await conn.execute(f"EXPLAIN (FORMAT JSON) {query}")  # test-only constant SQL
            row = await cur.fetchone()
            assert row is not None
            scans = [index for relation, index in _scans(row[0][0]["Plan"]) if relation == "money_events"]
        assert scans, "the view no longer reads money_events?"
        assert set(scans) == {"money_events_task"}, scans

    run(database_url, body)


async def returned(pool: Pool, s: Settings, task: str, reason: str, t: str) -> None:
    await receive(
        pool,
        s,
        "task.returned",
        {"task_id": task, "amount_usdc_units": "500000", "reason": reason, "tx": tx(t)},
    )


def test_an_unaudited_release_that_a_challenge_overturns_is_an_adjudicated_failure(
    database_url: str, settings: Settings
):
    """Paper §8.2: validated is audited, *or challenged and adjudicated*. Released unaudited, then upheld."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await released(pool, settings, tasks[0], "1")
        assert await outcomes(pool, tasks) == {}  # unaudited and unchallenged: still not evidence
        await challenge(pool, settings, tasks[0], upheld=True, t="2")
        got = await outcomes(pool, tasks)
        assert list(got) == [tasks[0]]
        assert got[tasks[0]]["success"] is False
        # Nothing counted until the adjudication, so that is where it sits.
        assert got[tasks[0]]["position"] == await ledger_id(pool, tasks[0], "challenge.resolved")

    run(database_url, body)


def test_a_challenge_upheld_before_release_is_an_adjudicated_failure(database_url: str, settings: Settings):
    """No verdict and no release: the challenge is upheld inside the window and the escrow goes back."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await challenge(pool, settings, tasks[0], upheld=True, t="1")
        await returned(pool, settings, tasks[0], "challenge", "2")
        got = await outcomes(pool, tasks)
        assert list(got) == [tasks[0]]
        assert got[tasks[0]]["success"] is False
        assert got[tasks[0]]["position"] == await ledger_id(pool, tasks[0], "challenge.resolved")

    run(database_url, body)


def test_an_unaudited_release_that_survived_a_challenge_is_an_adjudicated_success(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await challenge(pool, settings, tasks[0], upheld=False, t="1")
        assert await outcomes(pool, tasks) == {}  # adjudicated, but not paid yet: wait for the release
        await released(pool, settings, tasks[0], "2")
        got = await outcomes(pool, tasks)
        assert list(got) == [tasks[0]]
        assert got[tasks[0]]["success"] is True
        assert got[tasks[0]]["position"] == await ledger_id(pool, tasks[0], "task.released")

    run(database_url, body)


def test_a_challenge_rejected_after_an_unaudited_release_counts_from_the_rejection(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40)
        await released(pool, settings, tasks[0], "1")
        await challenge(pool, settings, tasks[0], upheld=False, t="2")
        got = (await outcomes(pool, tasks))[tasks[0]]
        assert got["success"] is True
        # The later of the two events is the one that made it count.
        assert got["position"] == await ledger_id(pool, tasks[0], "challenge.resolved")

    run(database_url, body)


def test_the_audited_cases_keep_their_outcome_and_position(database_url: str, settings: Settings):
    """Regression for the adjudication cases above: every audited case reads exactly as before."""

    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "1" * 40, n_tasks=7)
        fail, invalid, passed, upheld, rejected, fail_upheld, pass_unreleased = tasks
        await verdict(pool, settings, fail, "fail", "1")
        await verdict(pool, settings, invalid, "invalid", "2")
        await verdict(pool, settings, passed, "pass", "3")
        await released(pool, settings, passed, "4")
        await verdict(pool, settings, upheld, "pass", "5")
        await released(pool, settings, upheld, "6")
        await challenge(pool, settings, upheld, upheld=True, t="7")
        await verdict(pool, settings, rejected, "pass", "8")
        await released(pool, settings, rejected, "9")
        await challenge(pool, settings, rejected, upheld=False, t="a")
        await verdict(pool, settings, fail_upheld, "fail", "e")
        await challenge(pool, settings, fail_upheld, upheld=True, t="c")
        await verdict(pool, settings, pass_unreleased, "pass", "d")  # a verdict with no release

        got = {t: (r["success"], r["position"]) for t, r in (await outcomes(pool, tasks)).items()}
        assert got == {
            fail: (False, await ledger_id(pool, fail, "verdict.recorded")),
            invalid: (False, await ledger_id(pool, invalid, "verdict.recorded")),
            passed: (True, await ledger_id(pool, passed, "task.released")),
            upheld: (False, await ledger_id(pool, upheld, "task.released")),
            rejected: (True, await ledger_id(pool, rejected, "task.released")),
            fail_upheld: (False, await ledger_id(pool, fail_upheld, "verdict.recorded")),
        }

    run(database_url, body)
