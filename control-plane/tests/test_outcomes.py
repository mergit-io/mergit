"""Outcomes, retries and escalation (plan task O6). Run with `pytest -m postgres`.

Follows the same style as `test_chain_events.py`: plans are set up by calling `plans.insert_draft` /
`plans.approve` directly, and a finished job is simulated the way plan task O5's worker leaves one — an
`UPDATE jobs SET status = ..., phi_holds = ...` — since the worker never calls back into this service.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import mergit_receipt
import psycopg
import pytest
from psycopg.rows import TupleRow
from pydantic import SecretStr

from mergit_cp import chain_events, outcomes, plans
from mergit_cp.config import Settings
from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.planner import TaskDraft

pytestmark = pytest.mark.postgres

SETTINGS = Settings(
    database_url="unused",
    app_domain="app.mergit.test",
    session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
    gateway_url="http://gateway.invalid",
    store_url="http://store.invalid",
    agents_file="unused",
    planner_model="claude-opus-5",
    planner_provider="anthropic",
    events_token=SecretStr("test-events-token"),
    chain_events_token=SecretStr("test-chain-events-token"),
    worker_token=SecretStr("test-worker-token"),
)


def phi(**over: Any) -> dict[str, Any]:
    return {
        "kind": "exec/0",
        "command": ["pytest", "tests/test_refund.py", "-q"],
        "expected_exit": 0,
        "workdir": ".",
        "allowed_paths": ["payments/**"],
        "artifact_hashes": None,
        "timeout_s": 600,
    } | over


def task(index: int, depends_on: list[int] | None = None, budget: int = 500_000) -> TaskDraft:
    return TaskDraft(index, f"task {index}", "do it", phi(), budget, depends_on or [])


async def _plan(
    conn: psycopg.AsyncConnection[TupleRow], tasks: list[TaskDraft], agents: dict[int, list[str]]
) -> plans.StoredPlan:
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    await plans.insert_draft(
        conn,
        plan_uuid=plan_uuid,
        plan_id=plan_id,
        requester="0x" + "1" * 40,
        goal="fix it",
        repo_url="https://github.com/mergit-io/demo-repo",
        ref="main",
        category="test-repair",
        budget_usdc_units=sum(t.budget_usdc_units for t in tasks),
        planner_model="claude-opus-5",
        tasks=tasks,
    )
    await plans.approve(
        conn,
        plan_uuid,
        picks=agents,
        phi_hashes={t.index: mergit_receipt.phi_hash(plans.phi_json(t.phi)) for t in tasks},
        funding="wallet",
        total_budget_usdc_units=sum(t.budget_usdc_units for t in tasks),
    )
    loaded = await plans.load(conn, uuid.UUID(plan_uuid))
    assert loaded is not None
    return loaded


def run(database_url: str, body: Any) -> Any:
    async def go() -> Any:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
                await conn.execute(
                    "TRUNCATE plans, chain_events_seen, outbox, planning_attempts RESTART IDENTITY CASCADE"
                )
            return await body(pool)
        finally:
            await pool.close()

    return asyncio.run(go())


async def _process(pool: Pool) -> int:
    async with pool.connection() as conn, conn.transaction():
        return await outcomes.process_due(conn, SETTINGS)


async def _dispatch_and_escrow(
    conn: psycopg.AsyncConnection[TupleRow], plan: plans.StoredPlan, index: int, attempt: int, agent: str
) -> str:
    """A dispatched attempt only gets a `jobs` row once the gateway reports `task.escrowed`
    (`dispatch.record_escrowed`); the worker then claims and finishes that row, never `task_dispatches`."""
    task_id = await outcomes.dispatch.dispatch_task(conn, plan, index, attempt, agent, SETTINGS)
    assert await outcomes.dispatch.record_escrowed(conn, task_id)
    return task_id


def test_retry_uses_new_task_id_and_new_agent(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1", "2"]})
            task_id_1 = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )

        processed = await _process(pool)
        assert processed == 1

        async with pool.connection() as conn:
            rows = await (
                await conn.execute("SELECT task_id, attempt, agent_id FROM task_dispatches ORDER BY attempt")
            ).fetchall()
        assert [a for _, a, _ in rows] == [1, 2]
        assert rows[1][2] == "2"
        assert rows[1][0] != task_id_1  # a fresh task_id, not the failed attempt's

    run(database_url, body)


def test_no_retry_without_another_requester_picked_agent(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})  # only one pick: no retry possible
            task_id_1 = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )

        await _process(pool)

        async with pool.connection() as conn:
            n = await (await conn.execute("SELECT count(*) FROM task_dispatches")).fetchone()
            plan_loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert n is not None and n[0] == 1  # no second dispatch
        assert plan_loaded is not None and plan_loaded.state == "approved"  # never funded in this test

        async with pool.connection() as conn:
            stuck = await outcomes.stuck_indexes(conn, plan, SETTINGS)
        assert stuck == [0]

    run(database_url, body)


def test_max_three_attempts_then_needs_requester(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1", "2", "3"]})
            task_id = await _dispatch_and_escrow(conn, plan, 0, 1, "1")

        for attempt in (1, 2, 3):
            async with pool.connection() as conn, conn.transaction():
                await conn.execute(
                    "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now()"
                    " WHERE task_id = %s",
                    (task_id,),
                )
            await _process(pool)
            if attempt < 3:
                # The retry this just dispatched has a task_dispatches row, but no jobs row until the
                # gateway reports it escrowed too — same as any other dispatch.
                async with pool.connection() as conn, conn.transaction():
                    cur = await conn.execute(
                        'SELECT task_id FROM task_dispatches WHERE "index" = 0 AND attempt = %s',
                        (attempt + 1,),
                    )
                    row = await cur.fetchone()
                    assert row is not None
                    task_id = row[0]
                    assert await outcomes.dispatch.record_escrowed(conn, task_id)

        async with pool.connection() as conn:
            n = await (await conn.execute("SELECT count(*) FROM task_dispatches")).fetchone()
            stuck = await outcomes.stuck_indexes(conn, plan, SETTINGS)
        assert n is not None and n[0] == 3  # attempts 1, 2, 3 — no fourth
        assert stuck == [0]

    run(database_url, body)


def test_inconclusive_escalates_without_retry_when_exhausted(database_url: str) -> None:
    """holds=None (Φ could not run) is treated exactly like holds=False: a retry if the requester left
    one, otherwise `needs_requester` — never a silent pass."""

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            task_id = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = NULL, finished_at = now() WHERE task_id = %s",
                (task_id,),
            )

        await _process(pool)

        async with pool.connection() as conn:
            n = await (await conn.execute("SELECT count(*) FROM task_dispatches")).fetchone()
            stuck = await outcomes.stuck_indexes(conn, plan, SETTINGS)
        assert n is not None and n[0] == 1
        assert stuck == [0]

    run(database_url, body)


def test_agent_finish_alone_does_not_complete_task(database_url: str) -> None:
    """A job can reach `status = 'done'` with `phi_holds` false or null (the agent called `finish`, but Φ
    did not hold, or could not run); that must never be read as the index having passed."""

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            task_id = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute(
                "UPDATE jobs SET status = 'done', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id,),
            )

        await _process(pool)

        async with pool.connection() as conn:
            plan_loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert plan_loaded is not None and plan_loaded.state != "done"

    run(database_url, body)


def test_passing_both_tasks_marks_the_plan_done(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0), task(1)], {0: ["1"], 1: ["1"]})
            t0 = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            t1 = await _dispatch_and_escrow(conn, plan, 1, 1, "1")
            await conn.execute("UPDATE plans SET state = 'running' WHERE plan_uuid = %s", (plan.plan_uuid,))
            for t in (t0, t1):
                await conn.execute(
                    "UPDATE jobs SET status = 'done', phi_holds = true, finished_at = now()"
                    " WHERE task_id = %s",
                    (t,),
                )

        await _process(pool)

        async with pool.connection() as conn:
            plan_loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert plan_loaded is not None and plan_loaded.state == "done"

    run(database_url, body)


def test_a_finished_plan_is_closed_in_escrow_exactly_once(database_url: str) -> None:
    """The unspent part of a plan's escrow only comes back when the gateway receives `plan.closed`. A plan
    that finishes normally must send it, the same as one the requester abandons, and once only."""

    async def closed_events(pool: Pool, plan_id: str) -> list[tuple[str, str]]:
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT type, plan_id FROM outbox WHERE plan_id = %s AND type = 'plan.closed'", (plan_id,)
            )
            return [(str(r[0]), str(r[1])) for r in await cur.fetchall()]

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            t0 = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute("UPDATE plans SET state = 'running' WHERE plan_uuid = %s", (plan.plan_uuid,))
            await conn.execute(
                "UPDATE jobs SET status = 'done', phi_holds = true, finished_at = now() WHERE task_id = %s",
                (t0,),
            )
        assert await closed_events(pool, plan.plan_id) == []

        await _process(pool)
        assert await closed_events(pool, plan.plan_id) == [("plan.closed", plan.plan_id)]

        await _process(pool)  # nothing left to react to; still exactly one
        assert await closed_events(pool, plan.plan_id) == [("plan.closed", plan.plan_id)]

    run(database_url, body)


def test_a_pass_unblocks_a_dependent_task(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0), task(1, depends_on=[0])], {0: ["1"], 1: ["1"]})
            t0 = await _dispatch_and_escrow(conn, plan, 0, 1, "1")
            await conn.execute("UPDATE plans SET state = 'running' WHERE plan_uuid = %s", (plan.plan_uuid,))
            await conn.execute(
                "UPDATE jobs SET status = 'done', phi_holds = true, finished_at = now() WHERE task_id = %s",
                (t0,),
            )

        await _process(pool)

        async with pool.connection() as conn:
            cur = await conn.execute('SELECT "index" FROM task_dispatches ORDER BY "index"')
            rows = await cur.fetchall()
        assert [r[0] for r in rows] == [0, 1]

    run(database_url, body)


def test_verdict_does_not_move_graph(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            task_id = await _dispatch_and_escrow(conn, plan, 0, 1, "1")

        async with pool.connection() as conn, conn.transaction():
            await chain_events.receive(
                conn,
                {
                    "event_id": str(uuid.uuid4()),
                    "type": "verdict.recorded",
                    "at": "2026-10-29T00:00:00.000Z",
                    "payload": {"task_id": task_id, "verdict": "pass", "tx": "0x" + "a" * 64},
                },
                SETTINGS,
            )

        async with pool.connection() as conn:
            row = await (
                await conn.execute("SELECT status, phi_holds FROM jobs WHERE task_id = %s", (task_id,))
            ).fetchone()
            plan_loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert row == ("queued", None)  # untouched by the verdict
        assert plan_loaded is not None and plan_loaded.state == "approved"

    run(database_url, body)


def test_abandon_sends_plan_closed(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            await conn.execute("UPDATE plans SET state = 'running' WHERE plan_uuid = %s", (plan.plan_uuid,))
            plan = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert plan is not None
            await outcomes.abandon(conn, plan, SETTINGS)

        async with pool.connection() as conn:
            plan_loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            event = await (
                await conn.execute("SELECT type, plan_id FROM outbox WHERE plan_id = %s", (plan.plan_id,))
            ).fetchone()
        assert plan_loaded is not None and plan_loaded.state == "closed"
        assert event == ("plan.closed", plan.plan_id)

    run(database_url, body)


def test_abandon_twice_is_idempotent(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1"]})
            await conn.execute("UPDATE plans SET state = 'running' WHERE plan_uuid = %s", (plan.plan_uuid,))
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert loaded is not None
            await outcomes.abandon(conn, loaded, SETTINGS)
            await outcomes.abandon(conn, loaded, SETTINGS)  # a second click, or a retried request

        async with pool.connection() as conn:
            n = await (
                await conn.execute("SELECT count(*) FROM outbox WHERE plan_id = %s", (plan.plan_id,))
            ).fetchone()
        assert n is not None and n[0] == 2  # both events still sent; the state change was the idempotent part

    run(database_url, body)
