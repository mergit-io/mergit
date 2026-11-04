"""Which roster agents a suggestion leaves out, and why: probation after a proven falsification, and the
operator concurrency cap. Both are derived from ``money_events``, ``task_dispatches`` and ``jobs``.

Run with `pytest -m postgres`. Every test uses its own fresh agent ids, so the shared database's other rows
never count toward a test's operator.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

import mergit_receipt
import pytest
from psycopg.types.json import Jsonb

from mergit_cp.agents import Agent
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.dispatch import DISPATCH_DEADLINE_S
from mergit_cp.eligibility import AT_CAP, IN_PROBATION, ineligible
from tests.test_money import run

pytestmark = pytest.mark.postgres

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
REQUESTER = "0x" + "1" * 40
OPERATOR_A = "0x" + "a" * 40
OPERATOR_B = "0x" + "b" * 40


def agent(operator: str) -> Agent:
    """A roster agent with an id no other test uses."""
    agent_id = str(secrets.randbelow(10**15) + 10**15)
    return Agent(
        agent_id=agent_id,
        name=f"agent-{agent_id}",
        operator=operator,
        runtime_key="0x" + "2" * 40,
        provider="anthropic",
        model="claude-sonnet-5",
        system_prompt="You fix failing tests.",
    )


async def plan(pool: Pool, funding: str = "wallet") -> str:
    plan_uuid = str(uuid.uuid4())
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
            " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
            " VALUES (%s, %s, %s, 'fix it', 'https://github.com/acme/widgets', 'main', 'test-repair',"
            " 1000000, 'running', %s, 1000000, 'claude-opus-5', now())",
            (plan_uuid, mergit_receipt.plan_id(plan_uuid), REQUESTER, funding),
        )
    return plan_uuid


async def dispatch(
    pool: Pool,
    a: Agent,
    *,
    funding: str = "wallet",
    at: datetime = NOW,
    job: str | None = "running",
    receipt: bool = False,
) -> tuple[str, str]:
    """One dispatch of ``a`` on a plan of its own, ``at`` this time; with a ``jobs`` row in status ``job``
    unless ``job`` is None (the escrow never confirmed). Returns (plan_uuid, task_id)."""
    plan_uuid = await plan(pool, funding)
    task_id = "0x" + secrets.token_hex(32)
    async with pool.connection() as conn:
        await conn.execute(
            'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id, dispatched_at)'
            " VALUES (%s, %s, 0, 1, %s, %s)",
            (task_id, plan_uuid, a.agent_id, at),
        )
        if job is not None:
            await conn.execute(
                'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, receipt_root,'
                " created_at) VALUES (%s, %s, 0, 1, %s, %s, %s, %s)",
                (task_id, plan_uuid, a.agent_id, job, ("0x" + "e" * 64) if receipt else None, at),
            )
    return plan_uuid, task_id


async def ledger(pool: Pool, plan_uuid: str, task_id: str, kind: str, at: datetime, **cols: object) -> None:
    """A ``money_events`` row received at ``at``. Written directly rather than through
    ``chain_events.receive`` because the ledger is append-only and ``received_at`` is otherwise always now."""
    event_id = str(uuid.uuid4())
    names = ["event_id", "kind", "plan_uuid", "task_id", "tx", "received_at", *cols]
    values = [event_id, kind, plan_uuid, task_id, "0x" + secrets.token_hex(32), at, *cols.values()]
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO chain_events_seen (event_id, type, payload, received_at) VALUES (%s, %s, %s, %s)",
            (event_id, kind, Jsonb({"task_id": task_id}), at),
        )
        await conn.execute(
            f"INSERT INTO money_events ({', '.join(names)}) VALUES ({', '.join(['%s'] * len(names))})",
            values,
        )


async def invalid_verdict(pool: Pool, plan_uuid: str, task_id: str, at: datetime) -> None:
    await ledger(pool, plan_uuid, task_id, "verdict.recorded", at, verdict="invalid")


async def challenge_resolved(pool: Pool, plan_uuid: str, task_id: str, at: datetime, upheld: bool) -> None:
    await ledger(pool, plan_uuid, task_id, "challenge.resolved", at, challenge_id=7, upheld=upheld)


async def released(pool: Pool, plan_uuid: str, task_id: str, at: datetime = NOW) -> None:
    await ledger(pool, plan_uuid, task_id, "task.released", at, payee="0x" + "c" * 40, amount_usdc_units=1)


async def returned(pool: Pool, plan_uuid: str, task_id: str, at: datetime = NOW) -> None:
    await ledger(pool, plan_uuid, task_id, "task.returned", at, amount_usdc_units=1, reason="deadline")


async def excluded(
    pool: Pool, agents: list[Agent], settings: Settings, now: datetime = NOW
) -> dict[str, str]:
    async with pool.connection() as conn:
        return await ineligible(conn, agents, settings, now)


# Probation.


def test_wallet_falsification_puts_operator_in_probation(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, at=NOW - timedelta(days=1), receipt=True)
        await released(pool, plan_uuid, task_id, NOW - timedelta(days=1))
        await invalid_verdict(pool, plan_uuid, task_id, NOW - timedelta(hours=1))
        assert await excluded(pool, [a], settings) == {a.agent_id: IN_PROBATION}

    run(database_url, body)


def test_credits_falsification_puts_operator_in_probation(database_url: str, settings: Settings):
    """Invariant 6 keeps free-credit work out of the posteriors, not out of probation: a proven false
    receipt is evidence of fraud, so forging where the stakes are lowest still costs wallet-funded work."""

    async def body(pool: Pool) -> None:
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, funding="credits", at=NOW - timedelta(days=1))
        await invalid_verdict(pool, plan_uuid, task_id, NOW - timedelta(hours=1))
        assert await excluded(pool, [a], settings) == {a.agent_id: IN_PROBATION}

    run(database_url, body)


def test_upheld_challenge_puts_operator_in_probation(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        a, b = agent(OPERATOR_A), agent(OPERATOR_B)
        plan_a, task_a = await dispatch(pool, a, at=NOW - timedelta(days=1))
        plan_b, task_b = await dispatch(pool, b, at=NOW - timedelta(days=1))
        for plan_uuid, task_id, upheld in ((plan_a, task_a, True), (plan_b, task_b, False)):
            await challenge_resolved(pool, plan_uuid, task_id, NOW - timedelta(hours=1), upheld)
        # A rejected challenge proves nothing against b.
        assert await excluded(pool, [a, b], settings) == {a.agent_id: IN_PROBATION}

    run(database_url, body)


def test_a_failing_verdict_is_not_a_falsification(database_url: str, settings: Settings):
    """A validated failure is a capability signal for the posteriors (paper §7.5 iii), not fraud."""

    async def body(pool: Pool) -> None:
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, at=NOW - timedelta(days=1))
        await ledger(pool, plan_uuid, task_id, "verdict.recorded", NOW - timedelta(hours=1), verdict="fail")
        await returned(pool, plan_uuid, task_id, NOW - timedelta(hours=1))
        assert await excluded(pool, [a], settings) == {}

    run(database_url, body)


def test_probation_expires_after_window(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, at=NOW - timedelta(days=30))
        await returned(pool, plan_uuid, task_id, NOW - timedelta(days=30))
        proven = NOW - timedelta(days=10)
        await invalid_verdict(pool, plan_uuid, task_id, proven)
        window = timedelta(seconds=settings.routing_probation_s)
        assert await excluded(pool, [a], settings, now=proven + window - timedelta(seconds=1)) == {
            a.agent_id: IN_PROBATION
        }
        assert await excluded(pool, [a], settings, now=proven + window) == {}
        assert await excluded(pool, [a], settings) == {}  # NOW is ten days on, past the seven-day default

    run(database_url, body)


def test_a_second_falsification_of_the_same_task_does_not_restart_probation(
    database_url: str, settings: Settings
):
    """One false receipt is one falsification, timed when it was first proven: a later upheld challenge on a
    task already ruled invalid is the same fraud, not a new one."""

    async def body(pool: Pool) -> None:
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, at=NOW - timedelta(days=30))
        await invalid_verdict(pool, plan_uuid, task_id, NOW - timedelta(days=10))
        await challenge_resolved(pool, plan_uuid, task_id, NOW - timedelta(hours=1), upheld=True)
        await returned(pool, plan_uuid, task_id, NOW - timedelta(days=10))
        assert await excluded(pool, [a], settings) == {}

    run(database_url, body)


def test_probation_covers_every_agent_of_the_operator(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        forger, sibling, other = agent(OPERATOR_A), agent(OPERATOR_A), agent(OPERATOR_B)
        plan_uuid, task_id = await dispatch(pool, forger, at=NOW - timedelta(days=1))
        await invalid_verdict(pool, plan_uuid, task_id, NOW - timedelta(hours=1))
        # The sibling has never been dispatched at all; the other operator's agent is untouched.
        assert await excluded(pool, [forger, sibling, other], settings) == {
            forger.agent_id: IN_PROBATION,
            sibling.agent_id: IN_PROBATION,
        }

    run(database_url, body)


# The operator concurrency cap.


def test_operator_at_cap_is_ineligible(database_url: str, settings: Settings):
    """The cap is operator-wide (paper §7.5 ii): two agents' dispatches add up, and the bound is inclusive."""

    async def body(pool: Pool) -> None:
        cap = settings.routing_operator_concurrency_cap
        busy, idle, other = agent(OPERATOR_A), agent(OPERATOR_A), agent(OPERATOR_B)
        for _ in range(cap - 1):
            await dispatch(pool, busy)
        await dispatch(pool, other)
        assert await excluded(pool, [busy, idle, other], settings) == {}  # one below the cap
        await dispatch(pool, idle, job=None)  # mid-escrow, within its deadline: a real commitment
        assert await excluded(pool, [busy, idle, other], settings) == {
            busy.agent_id: AT_CAP,
            idle.agent_id: AT_CAP,
        }

    run(database_url, body)


def test_free_credit_dispatches_do_not_count_toward_the_cap(database_url: str, settings: Settings):
    """Invariant 6: free-credit work must not influence routing. Otherwise anyone with a credits grant could
    send a few cheap plans to a rival operator's agents and have its whole roster shown as "at cap" to
    everyone. Only wallet-funded dispatches, where someone has paid to hold the operator's capacity, count."""

    async def body(pool: Pool) -> None:
        s = settings.model_copy(update={"routing_operator_concurrency_cap": 2})
        a = agent(OPERATOR_A)
        for _ in range(5):
            await dispatch(pool, a, funding="credits")
        assert await excluded(pool, [a], s) == {}
        await dispatch(pool, a, funding="wallet")
        assert await excluded(pool, [a], s) == {}  # one paid dispatch, still under the cap of 2
        await dispatch(pool, a, funding="wallet")
        assert await excluded(pool, [a], s) == {a.agent_id: AT_CAP}

    run(database_url, body)


def test_released_and_returned_dispatches_are_resolved(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        s = settings.model_copy(update={"routing_operator_concurrency_cap": 2})
        a = agent(OPERATOR_A)
        first = await dispatch(pool, a, job="done", receipt=True)
        second = await dispatch(pool, a, job="done", receipt=True)
        assert await excluded(pool, [a], s) == {a.agent_id: AT_CAP}
        await released(pool, *first)
        assert await excluded(pool, [a], s) == {}
        await dispatch(pool, a)
        assert await excluded(pool, [a], s) == {a.agent_id: AT_CAP}
        await returned(pool, *second)
        assert await excluded(pool, [a], s) == {}

    run(database_url, body)


def test_stale_dispatch_without_job_does_not_count(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        s = settings.model_copy(update={"routing_operator_concurrency_cap": 1})
        a = agent(OPERATOR_A)
        await dispatch(pool, a, job=None, at=NOW - timedelta(seconds=DISPATCH_DEADLINE_S + 1))
        assert await excluded(pool, [a], s) == {}  # never escrowed, and never will
        b = agent(OPERATOR_B)
        await dispatch(pool, b, job=None, at=NOW - timedelta(seconds=DISPATCH_DEADLINE_S - 1))
        assert await excluded(pool, [b], s) == {b.agent_id: AT_CAP}  # still within its deadline
        c = agent("0x" + "c" * 40)
        await dispatch(pool, c, job="running", at=NOW - timedelta(seconds=DISPATCH_DEADLINE_S + 1))
        assert await excluded(pool, [c], s) == {c.agent_id: AT_CAP}  # escrowed: age alone never resolves it

    run(database_url, body)


def test_an_errored_job_with_no_receipt_does_not_count(database_url: str, settings: Settings):
    """Nothing was sealed for that attempt, so there is nothing to forge and nothing in flight; its escrow
    comes back on the chain's own deadline, which may be long after the worker gave up."""

    async def body(pool: Pool) -> None:
        s = settings.model_copy(update={"routing_operator_concurrency_cap": 1})
        a, b = agent(OPERATOR_A), agent(OPERATOR_B)
        await dispatch(pool, a, job="error")
        await dispatch(pool, b, job="error", receipt=True)
        assert await excluded(pool, [a, b], s) == {b.agent_id: AT_CAP}

    run(database_url, body)


def test_probation_reason_wins_over_cap(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        s = settings.model_copy(update={"routing_operator_concurrency_cap": 1})
        a = agent(OPERATOR_A)
        plan_uuid, task_id = await dispatch(pool, a, at=NOW - timedelta(minutes=5))  # unresolved
        await invalid_verdict(pool, plan_uuid, task_id, NOW - timedelta(minutes=1))
        assert await excluded(pool, [a], s) == {a.agent_id: IN_PROBATION}

    run(database_url, body)


# Everyone else.


def test_an_ordinary_agent_is_not_in_the_result(database_url: str, settings: Settings):
    """Present means excluded; an agent that may be suggested is absent, never mapped to an empty reason."""

    async def body(pool: Pool) -> None:
        a, fresh = agent(OPERATOR_A), agent(OPERATOR_B)
        done = await dispatch(pool, a, at=NOW - timedelta(days=1), job="done", receipt=True)
        await ledger(pool, *done, "verdict.recorded", NOW - timedelta(days=1), verdict="pass")
        await released(pool, *done, NOW - timedelta(days=1))
        await dispatch(pool, a)  # one in flight, well under the cap
        assert await excluded(pool, [a, fresh], settings) == {}

    run(database_url, body)


def test_an_empty_roster_excludes_nobody(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        assert await excluded(pool, [], settings) == {}

    run(database_url, body)


def test_the_default_settings():
    fields = Settings.model_fields
    assert fields["routing_probation_s"].default == 7 * 24 * 3600
    assert fields["routing_operator_concurrency_cap"].default == 5
