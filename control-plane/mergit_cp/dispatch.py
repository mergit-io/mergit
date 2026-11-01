"""Turning a ready task index into a chain event, and a confirmed escrow into a worker job
(plan task O4).

Both functions run in the caller's transaction, the same discipline as ``plans.py``: the state change and
the event or job row it produces commit together or not at all.

``dispatch_task`` sends one attempt and is meant to be called directly too, not only through
``dispatch_ready``: plan task O6 calls it again, with the requester's next agent and ``attempt + 1``, when
a task fails or is inconclusive. ``dispatch_ready`` is only the "what just became dispatchable" rule
(the initial dispatch on ``plan.funded``, and again by O6 once an index passes and may unblock others).
"""

from __future__ import annotations

import logging
import time

import mergit_receipt
from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from .config import Settings
from .events import enqueue
from .graph import TaskState, ready_tasks
from .plans import StoredPlan, load

log = logging.getLogger(__name__)

DISPATCH_DEADLINE_S = 1800
"""How long a dispatched task has to be sealed before the plan may give up on it (spec/events-v0.md)."""


async def _task_states(conn: AsyncConnection[TupleRow], plan_uuid: str) -> list[TaskState]:
    cur = await conn.execute(
        """
        SELECT t."index", t.depends_on,
               EXISTS (SELECT 1 FROM jobs j
                       WHERE j.plan_uuid = t.plan_uuid AND j."index" = t."index" AND j.phi_holds = true),
               EXISTS (SELECT 1 FROM task_dispatches d
                       WHERE d.plan_uuid = t.plan_uuid AND d."index" = t."index")
        FROM tasks t WHERE t.plan_uuid = %s
        """,
        (plan_uuid,),
    )
    return [
        TaskState(index=index, depends_on=tuple(depends_on), passed=passed, in_flight=in_flight)
        for index, depends_on, passed, in_flight in await cur.fetchall()
    ]


async def dispatch_task(
    conn: AsyncConnection[TupleRow],
    plan: StoredPlan,
    index: int,
    attempt: int,
    agent_id: str,
    settings: Settings,
) -> str:
    """Send ``task.dispatch_requested`` for one attempt and remember what it asked for.

    The matching ``task.escrowed`` event carries only a ``task_id``; this is how ``record_escrowed``
    later finds which plan, index, attempt and agent that task_id was for.
    """
    task = next(t for t in plan.tasks if t.draft.index == index)
    if task.phi_hash is None:
        raise ValueError(f"task {index} of plan {plan.plan_id} has no phi_hash; the plan is not approved")
    task_id = mergit_receipt.task_id(plan.plan_id, index, attempt)
    await conn.execute(
        'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
        " VALUES (%s, %s, %s, %s, %s)",
        (task_id, plan.plan_uuid, index, attempt, agent_id),
    )
    await enqueue(
        conn,
        "task.dispatch_requested",
        {
            "task_id": task_id,
            "plan_id": plan.plan_id,
            "index": index,
            "attempt": attempt,
            "agent_id": agent_id,
            "amount_usdc_units": str(task.draft.budget_usdc_units),
            "category": plan.category,
            "phi_hash": task.phi_hash,
            "deadline_unix": int(time.time()) + DISPATCH_DEADLINE_S,
        },
        plan_id=plan.plan_id,
        retry_window_s=settings.event_retry_window_s,
    )
    return task_id


async def dispatch_ready(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> list[str]:
    """Dispatch attempt 1 for every index that just became ready: the requester's first-picked agent for a
    ``'pick'``-routing task, or `routing.route`'s chosen agent for an ``'auto'`` one. Returns the task ids
    sent.

    An auto index for which `routing.route` finds nothing eligible (every candidate's operator at its
    concurrency cap, say) is skipped silently -- not an error, just not dispatchable *yet*;
    `dispatch_waiting`'s periodic sweep is what retries it once capacity frees up.

    ``routing`` is imported locally, not at module scope: `routing.py` imports `DISPATCH_DEADLINE_S` from
    this module, so a module-level import here would be circular.
    """
    from . import routing

    states = await _task_states(conn, plan.plan_uuid)
    dispatched: list[str] = []
    for index in ready_tasks(states):
        task = next(t for t in plan.tasks if t.draft.index == index)
        if task.routing == "auto":
            pending = await routing.route(conn, plan, index, 1, settings)
            if pending is None:
                continue
            assert pending.draw.chosen is not None  # route()'s own contract: never a None-wrapped chosen
            task_id = await dispatch_task(conn, plan, index, 1, pending.draw.chosen, settings)
            await routing.record_draw(conn, task_id, pending)
            dispatched.append(task_id)
        else:
            if not task.agents:
                log.error("task %s of plan %s has no agent picks; cannot dispatch", index, plan.plan_id)
                continue
            dispatched.append(await dispatch_task(conn, plan, index, 1, task.agents[0], settings))
    return dispatched


_OWED_AUTO_RETRIES = """
SELECT t."index", pj.last_attempt
FROM tasks t
JOIN (
    SELECT "index", bool_or(phi_holds = true) AS passed, max(attempt) AS last_attempt
    FROM jobs WHERE plan_uuid = %(plan_uuid)s AND outcome_processed_at IS NOT NULL
    GROUP BY "index"
) pj ON pj."index" = t."index"
LEFT JOIN (
    SELECT "index", max(attempt) AS max_dispatched FROM task_dispatches
    WHERE plan_uuid = %(plan_uuid)s GROUP BY "index"
) td ON td."index" = t."index"
WHERE t.plan_uuid = %(plan_uuid)s AND t.routing = 'auto' AND pj.passed = false
  AND pj.last_attempt < %(max_attempts)s
  AND (td.max_dispatched IS NULL OR td.max_dispatched <= pj.last_attempt)
"""


async def _dispatch_owed_auto_retries(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings
) -> list[str]:
    """Auto-routing indexes whose latest *processed* attempt failed or was inconclusive, have attempts left
    under ``settings.max_attempts``, and for which nothing has been dispatched since that failure -- an
    "owed retry" that `outcomes.process_one` already tries once, right when the failure is processed, but
    may have left owed when `route()` found nothing eligible at that exact moment (every candidate's
    operator momentarily at its concurrency cap, say). This is the periodic safety-net sweep for exactly
    that case: capacity is transient, so an index `route()` could not serve a moment ago may be servable
    now.

    Safe to call every pass regardless of whether anything is actually owed: an index already mid-retry is
    excluded by the ``td.max_dispatched`` condition above (a later ``task_dispatches`` row already exists,
    resolved or not), and an index with nothing eligible right now simply draws `None` again and is left
    for the next sweep -- no double dispatch, no busy-looping into an error.
    """
    from . import routing

    cur = await conn.execute(
        _OWED_AUTO_RETRIES, {"plan_uuid": plan.plan_uuid, "max_attempts": settings.max_attempts}
    )
    dispatched: list[str] = []
    for index, last_attempt in await cur.fetchall():
        attempt = int(last_attempt) + 1
        pending = await routing.route(conn, plan, index, attempt, settings)
        if pending is None:
            continue
        assert pending.draw.chosen is not None  # route()'s own contract: never a None-wrapped chosen
        task_id = await dispatch_task(conn, plan, index, attempt, pending.draw.chosen, settings)
        await routing.record_draw(conn, task_id, pending)
        dispatched.append(task_id)
    return dispatched


async def dispatch_waiting(conn: AsyncConnection[TupleRow], settings: Settings) -> int:
    """The periodic sweep for every plan still `funded`/`running`: newly-unblocked ready indexes (the same
    question `dispatch_ready` always answers, including an auto index that was waiting on capacity and may
    now be eligible) plus any "owed" auto retry (`_dispatch_owed_auto_retries`). Returns the total number of
    task ids dispatched across every plan swept.

    A plan that was `funded` and had something newly dispatched here is moved to `running` (`mark_running`)
    -- the same transition ``on_plan_funded`` makes the moment its own `dispatch_ready` call succeeds,
    needed here too since an all-auto, all-capacity-blocked plan can enter `funded` and sit there with
    nothing dispatched until a later sweep like this one is what actually gets it moving.
    """
    cur = await conn.execute("SELECT plan_uuid FROM plans WHERE state IN ('funded', 'running')")
    plan_uuids = [row[0] for row in await cur.fetchall()]
    total = 0
    for plan_uuid in plan_uuids:
        plan = await load(conn, plan_uuid, for_update=True)
        if plan is None:
            continue
        was_funded = plan.state == "funded"
        dispatched = list(await dispatch_ready(conn, plan, settings))
        dispatched.extend(await _dispatch_owed_auto_retries(conn, plan, settings))
        total += len(dispatched)
        if dispatched and was_funded:
            await mark_running(conn, plan.plan_uuid)
    return total


async def mark_running(conn: AsyncConnection[TupleRow], plan_uuid: str) -> bool:
    """Flip a `funded` plan to `running` now that something has actually been dispatched for it. Idempotent:
    a second call once the plan is already `running` (or anything else) does nothing and returns `False`."""
    cur = await conn.execute(
        "UPDATE plans SET state = 'running', updated_at = now() WHERE plan_uuid = %s AND state = 'funded'"
        " RETURNING 1",
        (plan_uuid,),
    )
    return await cur.fetchone() is not None


async def record_escrowed(conn: AsyncConnection[TupleRow], task_id: str) -> bool:
    """``task.escrowed`` means the money for this attempt is locked: queue the job for a worker.

    Returns False when ``task_id`` matches no dispatch this service sent (a gateway bug, or an event for
    another orchestrator deployment sharing the chain); the caller logs that case.
    """
    cur = await conn.execute(
        'SELECT plan_uuid, "index", attempt, agent_id FROM task_dispatches WHERE task_id = %s', (task_id,)
    )
    row = await cur.fetchone()
    if row is None:
        return False
    plan_uuid, index, attempt, agent_id = row
    await conn.execute(
        'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status)'
        " VALUES (%s, %s, %s, %s, %s, 'queued') ON CONFLICT (task_id) DO NOTHING",
        (task_id, plan_uuid, index, attempt, agent_id),
    )
    return True
