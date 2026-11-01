"""Outcomes, retries and escalation (plan task O6). Run with `pytest -m postgres`.

Follows the same style as `test_chain_events.py`: plans are set up by calling `plans.insert_draft` /
`plans.approve` directly, and a finished job is simulated the way plan task O5's worker leaves one — an
`UPDATE jobs SET status = ..., phi_holds = ...` — since the worker never calls back into this service.
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
from psycopg.rows import TupleRow, dict_row
from pydantic import SecretStr

from mergit_cp import chain_events, dispatch, outcomes, plans, routing
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

OPERATOR = "0x" + "9" * 40


def routed_settings(
    tmp_path: Path, database_url: str, agent_ids: list[str], operator: str = OPERATOR, **overrides: object
) -> Settings:
    """A roster of ``agent_ids``, all under one ``operator`` unless overridden, for the auto-routing (O6 +
    routing) tests below -- the plain module-level ``SETTINGS`` above (``agents_file="unused"``) is for
    pick-mode tests, which never call ``routing.route``/``routing.roster`` and so never read it."""
    unique = uuid.uuid4().hex
    chain = tmp_path / f"agents-{unique}.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": a,
                        "name": f"agent-{a}",
                        "operator": operator,
                        "runtime_key": "0x" + "2" * 40,
                    }
                    for a in agent_ids
                ]
            }
        )
    )
    config = tmp_path / f"agents-{unique}.toml"
    agent_table = 'provider = "anthropic"\nmodel = "m"\nsystem_prompt = "s"\n'
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        + "".join(f"[agents.agent-{a}]\n{agent_table}" for a in agent_ids)
    )
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


def funded_event(plan: plans.StoredPlan) -> dict[str, Any]:
    return {
        "event_id": str(uuid.uuid4()),
        "type": "plan.funded",
        "at": "2026-10-29T00:00:00.000Z",
        "payload": {
            "plan_id": plan.plan_id,
            "requester": plan.requester,
            "amount_usdc_units": str(plan.total_budget_usdc_units),
            "tier": "staked",
            "tx": "0x" + "a" * 64,
        },
    }


async def release(pool: Pool, task_id: str, n: int) -> None:
    """``task.released`` for ``task_id``: frees whatever operator concurrency cap it was holding."""
    async with pool.connection() as conn, conn.transaction():
        await chain_events.receive(
            conn,
            {
                "event_id": str(uuid.uuid4()),
                "type": "task.released",
                "at": "2026-10-29T00:00:00.000Z",
                "payload": {
                    "task_id": task_id,
                    "to": "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
                    "amount_usdc_units": "500000",
                    "tx": "0x" + format(n, "064x"),
                },
            },
            SETTINGS,
        )


async def dispatch_requested_agent(pool: Pool, task_id: str) -> str:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute("SELECT body FROM outbox WHERE type = 'task.dispatch_requested'")
        rows = await cur.fetchall()
    [body] = [r["body"] for r in rows if r["body"]["payload"]["task_id"] == task_id]
    return str(body["payload"]["agent_id"])


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
    conn: psycopg.AsyncConnection[TupleRow],
    tasks: list[TaskDraft],
    agents: dict[int, list[str] | None],
    *,
    routing: dict[int, tuple[str, bool, bool]] | None = None,
    category: str = "test-repair",
) -> plans.StoredPlan:
    """``agents[index] = None`` approves that index as auto-routed (``routing`` defaults to ``'pick'`` for
    every index when omitted, so every existing caller -- all of them pick-mode -- is unaffected)."""
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
        category=category,
        budget_usdc_units=sum(t.budget_usdc_units for t in tasks),
        planner_model="claude-opus-5",
        tasks=tasks,
    )
    await plans.approve(
        conn,
        plan_uuid,
        picks=agents,
        phi_hashes={t.index: mergit_receipt.phi_hash(plans.phi_json(t.phi)) for t in tasks},
        routing=routing or {i: ("pick", True, True) for i in agents},
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


async def _process(pool: Pool, settings: Settings = SETTINGS) -> int:
    """The real production wiring (`OutcomeProcessor.process_due`): claim and process due jobs one per
    transaction (fix round 2), then `dispatch.dispatch_waiting`'s capacity sweep in its own, separate
    per-plan transactions (fix round 1)."""
    return await outcomes.OutcomeProcessor(pool, settings).process_due()


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


# --- auto-routing wired into dispatch (Task 6) -----------------------------------------------------


def test_auto_index_dispatches_routed_agent(database_url: str, tmp_path: Path) -> None:
    # explore=False everywhere in this section's tests, deliberately: with `explore=True` a single-agent
    # (or even two-agent) roster's Thompson *sample* can come back infeasible purely by chance (`router.py`
    # samples cost from a wide, uninformative Gamma(kappa=1, ...) prior), making `route()` return `None` on
    # an unlucky draw even though the deterministic `greedy` pick is comfortably feasible -- that is a real,
    # already-handled case (`dispatch_waiting`'s whole job), but it would make these specific dispatch-level
    # wiring tests flaky for a reason that has nothing to do with what they are checking. `explore=False`
    # makes `chosen == greedy` always, so these tests stay deterministic without weakening the coverage:
    # Task 6 wires `route`/`record_draw`/`dispatch_waiting` into dispatch, not the Thompson draw itself,
    # which `tests/test_routing.py` already covers thoroughly under `explore=True`.
    settings = routed_settings(tmp_path, database_url, ["501"])

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            is_new = await chain_events.receive(conn, funded_event(plan), settings)
        assert is_new

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            row = await cur.fetchone()
        assert row is not None
        task_id = row[0]

        async with pool.connection() as conn:
            cur = await conn.execute("SELECT chosen_agent FROM routing_draws WHERE task_id = %s", (task_id,))
            drawn = await cur.fetchone()
        assert drawn is not None
        chosen_agent = drawn[0]
        assert chosen_agent == "501"  # single-agent roster: deterministic

        agent_in_event = await dispatch_requested_agent(pool, task_id)
        assert agent_in_event == chosen_agent

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert loaded is not None and loaded.state == "running"

    run(database_url, body)


def test_auto_index_waits_at_cap_then_dispatches(
    database_url: str, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings = routed_settings(tmp_path, database_url, ["601"], router_operator_concurrency_cap=1)
    caplog.set_level("INFO")

    async def body(pool: Pool) -> None:
        # A noise plan's unresolved dispatch to the only agent in the roster occupies the one concurrency
        # slot its operator has -- the auto plan below has nothing eligible to route to until it is freed.
        async with pool.connection() as conn, conn.transaction():
            noise = await _plan(conn, [task(0)], {0: ["601"]})
            noise_task_id = await outcomes.dispatch.dispatch_task(conn, noise, 0, 1, "601", settings)

        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            is_new = await chain_events.receive(conn, funded_event(plan), settings)
        assert is_new
        # The spec is explicit that this is NOT an error: every ready index being auto-routed with its
        # only candidate's operator at the concurrency cap is a legitimate, expected wait.
        assert not any(r.levelname == "ERROR" for r in caplog.records)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            n = await cur.fetchone()
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert n is not None and n[0] == 0  # nothing dispatched: the operator is at its concurrency cap
        assert loaded is not None and loaded.state == "funded"  # never moved to running

        await release(pool, noise_task_id, 1)  # frees the operator's only slot

        dispatched = await dispatch.dispatch_waiting(pool, settings)
        assert dispatched == 1
        assert not any(r.levelname == "ERROR" for r in caplog.records)

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
        assert loaded is not None and loaded.state == "running"

    run(database_url, body)


def test_dispatch_waiting_dispatches_an_owed_auto_retry(database_url: str, tmp_path: Path) -> None:
    """Distinct from `test_auto_index_waits_at_cap_then_dispatches` above, which blocks ATTEMPT 1 -- caught
    by `dispatch_ready`'s own inline auto-routing branch. This blocks the RETRY (attempt 2) after attempt 1
    has already failed and been processed: the index already has a `task_dispatches` row, so
    `graph.ready_tasks` no longer considers it "ready" at all, and only `_dispatch_owed_auto_retries` --
    never `dispatch_ready` -- can pick it back up. (Fix round 1: the reviewer flagged that no test exercised
    this path directly, which is exactly how Finding 1's NULL-outcome bug slipped through.)"""
    settings = routed_settings(tmp_path, database_url, ["1001", "1002"], router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            await chain_events.receive(conn, funded_event(plan), settings)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, agent_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            task_id_1, agent_1 = await cur.fetchone()

        # Fail attempt 1 (unsealed, so it stops counting toward the operator's cap once processed), then
        # occupy the operator's only slot with unrelated noise BEFORE the retry is ever attempted.
        async with pool.connection() as conn, conn.transaction():
            assert await outcomes.dispatch.record_escrowed(conn, task_id_1)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )
        async with pool.connection() as conn, conn.transaction():
            noise = await _plan(conn, [task(0)], {0: [agent_1]})
            noise_task_id = await outcomes.dispatch.dispatch_task(conn, noise, 0, 1, agent_1, settings)

        processed = await _process(pool, settings)
        assert processed == 1

        async with pool.connection() as conn:
            n = await (
                await conn.execute(
                    'SELECT count(*) FROM task_dispatches WHERE plan_uuid = %s AND "index" = 0',
                    (plan.plan_uuid,),
                )
            ).fetchone()
        assert n is not None and n[0] == 1  # the retry is owed, not dispatched: the operator is still capped

        await release(pool, noise_task_id, 1)

        dispatched = await dispatch.dispatch_waiting(pool, settings)
        assert dispatched == 1

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT attempt, agent_id FROM task_dispatches WHERE plan_uuid = %s ORDER BY attempt",
                (plan.plan_uuid,),
            )
            rows = await cur.fetchall()
        assert [r[0] for r in rows] == [1, 2]
        assert rows[1][1] != agent_1  # the only other roster agent

    run(database_url, body)


def test_auto_retry_after_inconclusive_outcome_at_cap(database_url: str, tmp_path: Path) -> None:
    """Fix round 1, Finding 1 (Critical): `phi_holds = NULL` ("inconclusive" -- `mergit_worker/jobs.py`'s
    `fail()` standard error path, not just an explicit `false`) must be retried exactly like an explicit
    failure. Before the fix, `_OWED_AUTO_RETRIES`'s `pj.passed = false` filter silently dropped an
    all-NULL group from the result (`NULL = false` is SQL NULL, which a `WHERE` clause never matches), so
    an auto index whose every attempt came back inconclusive was retried never and reported `needs_requester`
    never either -- the plan just hung in `running` forever."""
    settings = routed_settings(tmp_path, database_url, ["1101", "1102"], router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            await chain_events.receive(conn, funded_event(plan), settings)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, agent_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            task_id_1, agent_1 = await cur.fetchone()

        # phi_holds NULL: inconclusive, not an explicit failure -- the exact shape the bug mishandled.
        async with pool.connection() as conn, conn.transaction():
            assert await outcomes.dispatch.record_escrowed(conn, task_id_1)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = NULL, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )
        async with pool.connection() as conn, conn.transaction():
            noise = await _plan(conn, [task(0)], {0: [agent_1]})
            noise_task_id = await outcomes.dispatch.dispatch_task(conn, noise, 0, 1, agent_1, settings)

        first_pass_processed = await _process(pool, settings)
        assert first_pass_processed == 1

        async with pool.connection() as conn:
            n = await (
                await conn.execute(
                    'SELECT count(*) FROM task_dispatches WHERE plan_uuid = %s AND "index" = 0',
                    (plan.plan_uuid,),
                )
            ).fetchone()
        assert n is not None and n[0] == 1  # owed, not dispatched yet -- the operator is still capped

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert loaded is not None
            # Pre-fix, this NULL-outcome index would never show up here either: permanently invisible to
            # both the retry sweep AND needs_requester reporting. Confirm it's correctly "not yet stuck"
            # (attempts remain, and it's only waiting on capacity, not structurally exhausted).
            stuck = await outcomes.stuck_indexes(conn, loaded, settings)
        assert stuck == []

        await release(pool, noise_task_id, 1)

        second_pass_processed = await _process(pool, settings)  # a `process_due` pass, per the fix's ask
        assert second_pass_processed == 0  # no freshly-finished job this pass -- the dispatch is the sweep's

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT attempt, agent_id FROM task_dispatches WHERE plan_uuid = %s ORDER BY attempt",
                (plan.plan_uuid,),
            )
            rows = await cur.fetchall()
        assert [r[0] for r in rows] == [1, 2]
        assert rows[1][1] != agent_1

    run(database_url, body)


def test_in_flight_retry_does_not_count_toward_roster_exhaustion(database_url: str, tmp_path: Path) -> None:
    """Fix round 1, Finding 2: an attempt beyond the latest *processed* one must never count toward roster
    exhaustion merely because it has been dispatched -- it might still pass. With a 2-agent roster, attempt 1
    (agent A) fails and is processed, which dispatches attempt 2 (agent B) automatically; while attempt 2 is
    still in flight (no outcome yet), the index must NOT be reported stuck, even though both roster agents
    now have a `task_dispatches` row."""
    settings = routed_settings(tmp_path, database_url, ["1201", "1202"])

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            await chain_events.receive(conn, funded_event(plan), settings)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            (task_id_1,) = await cur.fetchone()

        async with pool.connection() as conn, conn.transaction():
            assert await outcomes.dispatch.record_escrowed(conn, task_id_1)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )

        processed = await _process(pool, settings)
        assert processed == 1

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT attempt FROM task_dispatches WHERE plan_uuid = %s ORDER BY attempt",
                (plan.plan_uuid,),
            )
            attempts = [r[0] for r in await cur.fetchall()]
        assert attempts == [1, 2]  # the retry dispatched automatically -- still unresolved, in flight

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert loaded is not None
            stuck = await outcomes.stuck_indexes(conn, loaded, settings)
        assert stuck == []  # attempt 2 is in flight, not processed -- must not count toward exhaustion

    run(database_url, body)


def test_auto_retry_draws_a_different_agent(database_url: str, tmp_path: Path) -> None:
    """With exactly two roster agents under one operator, "already tried" leaves only one eligible arm for
    the retry -- so the retry's chosen agent is not just *a* new `routing_draws` row, it is deterministically
    the OTHER agent."""
    settings = routed_settings(tmp_path, database_url, ["701", "702"])

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            await chain_events.receive(conn, funded_event(plan), settings)

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, agent_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            task_id_1, agent_1 = await cur.fetchone()

        async with pool.connection() as conn, conn.transaction():
            assert await outcomes.dispatch.record_escrowed(conn, task_id_1)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )

        processed = await _process(pool, settings)
        assert processed == 1

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, attempt, agent_id FROM task_dispatches WHERE plan_uuid = %s"
                " ORDER BY attempt",
                (plan.plan_uuid,),
            )
            rows = await cur.fetchall()
        assert [r[1] for r in rows] == [1, 2]
        task_id_2, agent_2 = rows[1][0], rows[1][2]
        assert {agent_1, agent_2} == {"701", "702"}
        assert agent_2 != agent_1

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) FROM routing_draws WHERE task_id = ANY(%s)", ([task_id_1, task_id_2],)
            )
            n = await cur.fetchone()
        assert n is not None and n[0] == 2  # a fresh routing_draws row for the retry, not a reused one

    run(database_url, body)


def test_auto_index_stuck_after_all_agents_tried(database_url: str, tmp_path: Path) -> None:
    """Every roster agent dispatched and failed for an auto index: structurally stuck, even though
    `settings.max_attempts` (3, the default) was never reached -- there is nothing left in the roster for
    `routing.candidates` to ever offer `route()` again."""
    settings = routed_settings(tmp_path, database_url, ["801", "802"])

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            await chain_events.receive(conn, funded_event(plan), settings)

        for _ in range(2):  # both roster agents, one attempt each
            async with pool.connection() as conn:
                cur = await conn.execute(
                    "SELECT task_id FROM task_dispatches WHERE plan_uuid = %s"
                    " AND task_id NOT IN (SELECT task_id FROM jobs) ",
                    (plan.plan_uuid,),
                )
                row = await cur.fetchone()
            assert row is not None
            task_id = row[0]
            async with pool.connection() as conn, conn.transaction():
                assert await outcomes.dispatch.record_escrowed(conn, task_id)
                await conn.execute(
                    "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now()"
                    " WHERE task_id = %s",
                    (task_id,),
                )
            await _process(pool, settings)

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert loaded is not None
            stuck = await outcomes.stuck_indexes(conn, loaded, settings)
        assert stuck == [0]

    run(database_url, body)


def test_waiting_index_is_not_stuck(database_url: str, tmp_path: Path) -> None:
    """An auto index with attempts remaining AND a roster agent still untried is not stuck even while the
    operator currently sits at its concurrency cap -- capacity is transient and must never read as
    `needs_requester`."""
    settings = routed_settings(tmp_path, database_url, ["901", "902"], router_operator_concurrency_cap=1)

    async def body(pool: Pool) -> None:
        # Occupy the operator's one slot with an unrelated, unresolved dispatch to agent "901".
        async with pool.connection() as conn, conn.transaction():
            noise = await _plan(conn, [task(0)], {0: ["901"]})
            await outcomes.dispatch.dispatch_task(conn, noise, 0, 1, "901", settings)

        # The routed plan's only processed attempt (also "901", now failed) leaves "902" untried.
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: None}, routing={0: ("auto", False, True)})
            task_id = await outcomes.dispatch.dispatch_task(conn, plan, 0, 1, "901", settings)
            assert await outcomes.dispatch.record_escrowed(conn, task_id)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id,),
            )
            await outcomes._mark_processed(conn, task_id)

        async with pool.connection() as conn:
            loaded = await plans.load(conn, uuid.UUID(plan.plan_uuid))
            assert loaded is not None
            # Confirm this really is "waiting on capacity" right now, not just a scenario that happens not
            # to affect `stuck_indexes`: a route() call at this exact moment has nothing eligible either.
            arms, ineligible = await routing.candidates(conn, loaded, 0, settings)
            stuck = await outcomes.stuck_indexes(conn, loaded, settings)
        assert arms == []
        assert ineligible == {"901": "already tried on this task", "902": "operator at concurrency cap"}
        assert stuck == []  # "902" is still untried, and only 1 of 3 default attempts has been used

    run(database_url, body)


def test_process_due_commits_each_job_independently(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fix round 2: `process_due` must process each due job in its own transaction, never bundle several
    due jobs -- possibly across different plans -- into one shared, not-yet-committed transaction the way
    it used to. That bundling is exactly what let a transaction end up holding one plan's row lock while
    also wanting `route`'s global advisory lock for a DIFFERENT plan it had already claimed in the same
    breath, the re-derived deadlock cycle fix round 2 closes.

    This proves the structural property directly, no real concurrency or literal deadlock needed: with two
    due jobs on two different plans, make the SECOND job's processing raise. If both jobs were still
    sharing one transaction (the pre-fix-round-2 behavior), the whole thing would roll back and NEITHER
    job's outcome would be committed. With one transaction per job, the FIRST job's transaction has already
    committed by the time the second one raises -- so its outcome must be durably visible even though the
    overall `process_due` call failed.
    """
    calls = 0
    real_process_one = outcomes.process_one

    async def flaky_process_one(conn: Any, job: Any, settings: Settings) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("boom")
        await real_process_one(conn, job, settings)

    monkeypatch.setattr(outcomes, "process_one", flaky_process_one)

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan_a = await _plan(conn, [task(0)], {0: ["1"]})
            task_id_a = await outcomes.dispatch.dispatch_task(conn, plan_a, 0, 1, "1", SETTINGS)
            assert await outcomes.dispatch.record_escrowed(conn, task_id_a)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false,"
                " finished_at = now() - interval '2 seconds' WHERE task_id = %s",
                (task_id_a,),
            )
            plan_b = await _plan(conn, [task(0)], {0: ["1"]})
            task_id_b = await outcomes.dispatch.dispatch_task(conn, plan_b, 0, 1, "1", SETTINGS)
            assert await outcomes.dispatch.record_escrowed(conn, task_id_b)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false,"
                " finished_at = now() - interval '1 second' WHERE task_id = %s",
                (task_id_b,),
            )

        with pytest.raises(RuntimeError, match="boom"):
            await outcomes.process_due(pool, SETTINGS, limit=10)
        assert calls == 2  # claimed and attempted both -- the second is what raised

        async with pool.connection() as conn:
            row_a = await (
                await conn.execute(
                    "SELECT outcome_processed_at IS NOT NULL FROM jobs WHERE task_id = %s", (task_id_a,)
                )
            ).fetchone()
            row_b = await (
                await conn.execute(
                    "SELECT outcome_processed_at IS NOT NULL FROM jobs WHERE task_id = %s", (task_id_b,)
                )
            ).fetchone()
        assert row_a == (True,)  # earliest-finished job: its own transaction already committed
        assert row_b == (False,)  # second job: its transaction never committed -- the exception aborted it

    run(database_url, body)


def test_pick_mode_unchanged(database_url: str) -> None:
    """A representative pick-mode O6 scenario (retry on failure, through the real `plan.funded` dispatch
    path this time, not the direct `dispatch_task` calls the older tests above use) must behave exactly as
    before Task 6: the requester's next listed agent, dispatched directly, with no `routing_draws` row at
    all -- `routing.route` must never be consulted for a `'pick'`-routing task."""

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            plan = await _plan(conn, [task(0)], {0: ["1", "2"]})
            is_new = await chain_events.receive(conn, funded_event(plan), SETTINGS)
        assert is_new

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, agent_id FROM task_dispatches WHERE plan_uuid = %s", (plan.plan_uuid,)
            )
            task_id_1, agent_1 = await cur.fetchone()
        assert agent_1 == "1"

        async with pool.connection() as conn, conn.transaction():
            assert await outcomes.dispatch.record_escrowed(conn, task_id_1)
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_id_1,),
            )

        processed = await _process(pool)
        assert processed == 1

        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT attempt, agent_id FROM task_dispatches WHERE plan_uuid = %s ORDER BY attempt",
                (plan.plan_uuid,),
            )
            rows = await cur.fetchall()
            n = await (await conn.execute("SELECT count(*) FROM routing_draws")).fetchone()
        assert rows == [(1, "1"), (2, "2")]
        assert n is not None and n[0] == 0  # never routed: this is a pick-mode task

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
