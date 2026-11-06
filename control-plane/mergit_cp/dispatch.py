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
from .plans import StoredPlan

log = logging.getLogger(__name__)

DISPATCH_DEADLINE_S = 1800
"""How long a dispatched task has to be sealed before the plan may give up on it (spec/events-v0.md)."""

RETRY_WINDOW_S = DISPATCH_DEADLINE_S + 600
"""How long a retry's dispatch keeps being delivered. The gateway refuses to lock attempt n while attempt n-1
still holds its payment (503), and an attempt that ended without a receipt only gets it back once its deadline
passes and the keeper returns it. A shorter window gives the retry up before then, for good."""


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
        retry_window_s=(
            settings.event_retry_window_s
            if attempt == 1
            else max(settings.event_retry_window_s, RETRY_WINDOW_S)
        ),
    )
    return task_id


async def dispatch_ready(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> list[str]:
    """Dispatch attempt 1, with the requester's first-picked agent, for every index that just became
    ready. Returns the task ids sent."""
    states = await _task_states(conn, plan.plan_uuid)
    dispatched: list[str] = []
    for index in ready_tasks(states):
        task = next(t for t in plan.tasks if t.draft.index == index)
        if not task.agents:
            log.error("task %s of plan %s has no agent picks; cannot dispatch", index, plan.plan_id)
            continue
        dispatched.append(await dispatch_task(conn, plan, index, 1, task.agents[0], settings))
    return dispatched


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
