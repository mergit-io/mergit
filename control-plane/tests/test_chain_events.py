"""Chain events and dispatch (plan task O4). Run with `pytest -m postgres`.

Plans are set up by calling `plans.insert_draft`/`plans.approve` directly, the same functions plan task
O3's routes call, so these tests start from an approved plan without going through the LLM or SIWE.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import mergit_receipt
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import TupleRow
from pydantic import SecretStr

from mergit_cp import chain_events, dispatch, plans
from mergit_cp.config import Settings
from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.planner import TaskDraft

pytestmark = pytest.mark.postgres

VECTOR_PLAN_UUID = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b"


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


async def _approved_plan(
    conn: psycopg.AsyncConnection[TupleRow], tasks: list[TaskDraft], *, plan_uuid: str | None = None
) -> plans.StoredPlan:
    plan_uuid = plan_uuid or str(uuid.uuid4())
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
        picks={t.index: ["1"] for t in tasks},
        phi_hashes={t.index: mergit_receipt.phi_hash(plans.phi_json(t.phi)) for t in tasks},
        funding="wallet",
        total_budget_usdc_units=sum(t.budget_usdc_units for t in tasks),
    )
    loaded = await plans.load(conn, uuid.UUID(plan_uuid))
    assert loaded is not None
    return loaded


def funded(plan: plans.StoredPlan) -> dict[str, Any]:
    return {
        "event_id": str(uuid.uuid4()),
        "type": "plan.funded",
        "at": "2026-10-28T00:00:00.000Z",
        "payload": {
            "plan_id": plan.plan_id,
            "requester": plan.requester,
            "amount_usdc_units": str(plan.total_budget_usdc_units),
            "tier": "staked",
            "tx": "0x" + "a" * 64,
        },
    }


def escrowed(task_id: str) -> dict[str, Any]:
    return {
        "event_id": str(uuid.uuid4()),
        "type": "task.escrowed",
        "at": "2026-10-28T00:00:00.000Z",
        "payload": {"task_id": task_id, "tx": "0x" + "b" * 64},
    }


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


async def _counts(pool: Pool) -> tuple[int, int]:
    async with pool.connection() as conn:
        d = await (await conn.execute("SELECT count(*) FROM task_dispatches")).fetchone()
        j = await (await conn.execute("SELECT count(*) FROM jobs")).fetchone()
    assert d is not None and j is not None
    return int(d[0]), int(j[0])


def test_no_dispatch_before_plan_funded(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            await _approved_plan(conn, [task(0)])
        assert await _counts(pool) == (0, 0)

    run(database_url, body)


def test_independent_tasks_dispatch_in_parallel(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0), task(1)])
            is_new = await chain_events.receive(conn, funded(plan), SETTINGS)
        assert is_new
        assert await _counts(pool) == (2, 0)

    run(database_url, body)


def test_task_dispatched_only_after_dependencies_pass(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0), task(1, depends_on=[0])])
            await chain_events.receive(conn, funded(plan), SETTINGS)

        async with pool.connection() as conn:
            rows = await (await conn.execute('SELECT "index" FROM task_dispatches')).fetchall()
        assert [r[0] for r in rows] == [0]

        # Simulate what plan task O6 does once index 0 passes: write the job as done and passed, then
        # ask the graph what is ready now. Nothing here is O4's job beyond `dispatch_ready` itself.
        async with pool.connection() as conn, conn.transaction():
            task_id_0 = mergit_receipt.task_id(plan.plan_id, 0, 1)
            await conn.execute(
                'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, phi_holds)'
                " VALUES (%s, %s, 0, 1, '1', 'done', true)",
                (task_id_0, plan.plan_uuid),
            )
            dispatched = await dispatch.dispatch_ready(conn, plan, SETTINGS)
        assert dispatched == [mergit_receipt.task_id(plan.plan_id, 1, 1)]

    run(database_url, body)


def test_job_queued_only_after_task_escrowed(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0)])
            await chain_events.receive(conn, funded(plan), SETTINGS)
        assert await _counts(pool) == (1, 0)

        task_id = mergit_receipt.task_id(plan.plan_id, 0, 1)
        async with pool.connection() as conn, conn.transaction():
            is_new = await chain_events.receive(conn, escrowed(task_id), SETTINGS)
        assert is_new
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT status FROM jobs WHERE task_id = %s", (task_id,))
            row = await cur.fetchone()
        assert row == ("queued",)

    run(database_url, body)


def test_duplicate_chain_event_is_ignored(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0)])
            event = funded(plan)
            first = await chain_events.receive(conn, event, SETTINGS)
        assert first
        assert await _counts(pool) == (1, 0)

        # The exact same envelope again (a retried gateway delivery): no second dispatch.
        async with pool.connection() as conn, conn.transaction():
            second = await chain_events.receive(conn, event, SETTINGS)
        assert not second
        assert await _counts(pool) == (1, 0)

    run(database_url, body)


def test_task_id_matches_spec_vector(database_url: str) -> None:
    vectors = json.loads((Path(__file__).resolve().parents[2] / "spec" / "vectors" / "ids.json").read_text())
    by_index = {
        (v["index"], v["attempt"]): v["task_id"] for v in vectors if v["plan_uuid"] == VECTOR_PLAN_UUID
    }
    assert by_index  # the fixture file still has this vector

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0), task(1), task(2)], plan_uuid=VECTOR_PLAN_UUID)
            for index, attempt in by_index:
                got = await dispatch.dispatch_task(conn, plan, index, attempt, "1", SETTINGS)
                assert got == by_index[(index, attempt)]

    run(database_url, body)


def test_credits_denied_leaves_the_plan_where_the_requester_can_act_on_it(database_url: str) -> None:
    """``credits.denied`` only ever arrives before ``plan.funded`` (the gateway tries credits first, and
    only sends ``plan.funded`` once money actually landed), so the plan is already sitting exactly where
    issue #23 wants it: ``approved``, not yet funded, free to fund from a wallet (independent of this
    service) or close (`outcomes.abandon`, plan task O6). There is no state to move it to that it is not
    already in; the gap #23 flagged was that the reason went nowhere, which `runs.money_events` (O7) now
    carries, see `test_api.py`."""

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0)])
        for reason in ("no_credits", "rate_limited", "over_value_cap"):
            event = {
                "event_id": str(uuid.uuid4()),
                "type": "credits.denied",
                "at": "2026-10-29T00:00:00.000Z",
                "payload": {"plan_id": plan.plan_id, "reason": reason},
            }
            async with pool.connection() as conn, conn.transaction():
                is_new = await chain_events.receive(conn, event, SETTINGS)
            assert is_new

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            cur = await conn.execute(
                "SELECT payload ->> 'reason' FROM chain_events_seen"
                " WHERE type = 'credits.denied' ORDER BY received_at"
            )
            reasons = [r[0] for r in await cur.fetchall()]
        assert loaded is not None and loaded.state == "approved"
        assert reasons == ["no_credits", "rate_limited", "over_value_cap"]
        assert await _counts(pool) == (0, 0)  # never dispatched: credits.denied is not plan.funded

    run(database_url, body)


def test_duplicate_credits_denied_is_ignored(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _approved_plan(conn, [task(0)])
            event = {
                "event_id": str(uuid.uuid4()),
                "type": "credits.denied",
                "at": "2026-10-29T00:00:00.000Z",
                "payload": {"plan_id": plan.plan_id, "reason": "no_credits"},
            }
            first = await chain_events.receive(conn, event, SETTINGS)
        assert first

        async with pool.connection() as conn, conn.transaction():
            second = await chain_events.receive(conn, event, SETTINGS)
        assert not second

        async with pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) FROM chain_events_seen WHERE type = 'credits.denied'")
            n = await cur.fetchone()
        assert n is not None and n[0] == 1

    run(database_url, body)


def test_chain_event_endpoint_requires_the_shared_token(client: TestClient) -> None:
    body = {
        "event_id": str(uuid.uuid4()),
        "type": "credits.denied",
        "at": "2026-10-28T00:00:00.000Z",
        "payload": {"plan_id": "0x" + "0" * 64, "reason": "no_credits"},
    }
    assert client.post("/v0/chain-events", json=body).status_code == 401
    assert (
        client.post("/v0/chain-events", json=body, headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    ok = client.post(
        "/v0/chain-events", json=body, headers={"Authorization": "Bearer test-chain-events-token"}
    )
    assert ok.status_code == 200
    assert ok.json() == {"new": True}
