"""Outcomes, retries and escalation (plan task O6): what a finished job means for the task graph.

The worker writes a job's result straight to its row over the shared database (``jobs.status``,
``jobs.phi_holds``; see ``mergit_worker/jobs.py``) — it never calls back into this service. This module is
this service's side of that handoff: ``process_due`` finds jobs the worker finished that nothing has
reacted to yet, and for each one applies the one rule plan task O3's approval already fixed into
``tasks.agents`` (the requester's pick plus up to ``max_attempts - 1`` retries, in order):

- ``holds = True``: the index passed. Nothing else to write; ``jobs.phi_holds = true`` *is* "passed" as
  far as the rest of this service is concerned (``mergit_cp/graph.py``).
- ``holds = False`` or ``None`` (Φ could not run at all: a timeout or a missing command): dispatch the
  requester's next agent for this index, one attempt higher, if the list and the attempt cap both allow
  it; otherwise the index is stuck until the requester does something about it (``needs_requester``, which
  this module computes on demand rather than stores — see ``stuck_indexes``).

Either way, ``dispatch.dispatch_ready`` is asked what just became dispatchable, the same question plan
task O4 asks on ``plan.funded`` and never a second copy of that rule. A plan whose every index has passed
moves to ``done`` here, since nothing else is watching for that moment.

``verdict.recorded``, ``task.released``, ``task.returned`` and the rest are the money half of plan task O6:
``mergit_cp/money.py`` records them in its own ledger table and, by design (Review Focus item 1: only
``phi_eval`` moves the graph), nothing here reads that ledger or reacts to those events.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from . import dispatch
from .config import Settings
from .db import Pool
from .events import enqueue
from .plans import StoredPlan, StoredTask, load

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class FinishedJob:
    task_id: str
    plan_uuid: str
    index: int
    attempt: int
    holds: bool | None


_CLAIM_FINISHED = """
SELECT task_id, plan_uuid, "index", attempt, phi_holds FROM jobs
WHERE status IN ('done', 'error') AND outcome_processed_at IS NULL
ORDER BY finished_at
FOR UPDATE SKIP LOCKED
LIMIT %s
"""

_DISPATCHES = """
SELECT d."index", d.attempt,
       j.task_id IS NOT NULL,
       j.outcome_processed_at IS NOT NULL,
       coalesce(j.phi_holds, false),
       EXISTS (SELECT 1 FROM outbox o
               WHERE o.type = 'task.dispatch_requested' AND o.body->'payload'->>'task_id' = d.task_id
                 AND o.failed_at IS NOT NULL)
FROM task_dispatches d LEFT JOIN jobs j ON j.task_id = d.task_id
WHERE d.plan_uuid = %s
"""


@dataclass(frozen=True, slots=True)
class _Dispatch:
    attempt: int
    has_job: bool
    processed: bool
    holds: bool
    given_up: bool
    """Its `task.dispatch_requested` was never delivered: the gateway never locked it, so no job will come."""


_ALL_PASSED = """
SELECT NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.plan_uuid = %s AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.plan_uuid = t.plan_uuid AND j."index" = t."index" AND j.phi_holds = true
    )
)
"""


async def _claim_finished(conn: AsyncConnection[TupleRow], limit: int) -> list[FinishedJob]:
    cur = await conn.execute(_CLAIM_FINISHED, (limit,))
    return [
        FinishedJob(task_id=t, plan_uuid=str(p), index=i, attempt=a, holds=h)
        for t, p, i, a, h in await cur.fetchall()
    ]


async def _mark_processed(conn: AsyncConnection[TupleRow], task_id: str) -> None:
    await conn.execute("UPDATE jobs SET outcome_processed_at = now() WHERE task_id = %s", (task_id,))


async def _all_passed(conn: AsyncConnection[TupleRow], plan_uuid: str) -> bool:
    cur = await conn.execute(_ALL_PASSED, (plan_uuid,))
    row = await cur.fetchone()
    return bool(row and row[0])


def _next_agent(task: StoredTask, attempt: int, max_attempts: int) -> str | None:
    """The requester's pick for the attempt after ``attempt``, or None when the list or the attempt cap
    is exhausted. ``task.agents[0]`` was attempt 1, so attempt ``n``'s retry is ``task.agents[n]``."""
    if attempt >= max_attempts or task.agents is None or attempt >= len(task.agents):
        return None
    return task.agents[attempt]


async def process_one(conn: AsyncConnection[TupleRow], job: FinishedJob, settings: Settings) -> None:
    """React to one finished job, then mark it processed in the same transaction as whatever that
    reaction was, so a crash between the two can never happen."""
    plan = await load(conn, UUID(job.plan_uuid), for_update=True)
    if plan is None:
        log.error("outcome for job %s: plan %s no longer exists", job.task_id, job.plan_uuid)
        await _mark_processed(conn, job.task_id)
        return
    task = next((t for t in plan.tasks if t.draft.index == job.index), None)
    if task is None:
        log.error("outcome for job %s: task index %d no longer exists", job.task_id, job.index)
        await _mark_processed(conn, job.task_id)
        return

    if job.holds is True:
        # Nothing still on its way to the gateway for this index may lock more money once it passed
        # (a requester retry sent while this attempt's own dispatch looked given up, say).
        await conn.execute(
            "UPDATE outbox SET failed_at = now(), last_error = 'the task already passed'"
            " WHERE plan_id = %s AND type = 'task.dispatch_requested'"
            " AND (body->'payload'->>'index')::int = %s"
            " AND delivered_at IS NULL AND failed_at IS NULL",
            (plan.plan_id, job.index),
        )
    elif job.attempt == await next_attempt(conn, plan, job.index) - 1:
        # Only the newest attempt retries on its own: an older one finishing late (its dispatch looked
        # given up and the requester already sent a newer one) must not reuse a taken attempt number.
        next_agent = _next_agent(task, job.attempt, settings.max_attempts)
        if next_agent is not None:
            await dispatch.dispatch_task(conn, plan, job.index, job.attempt + 1, next_agent, settings)
    await _mark_processed(conn, job.task_id)

    dispatched = await dispatch.dispatch_ready(conn, plan, settings)
    if not dispatched and plan.state in ("funded", "running") and await _all_passed(conn, plan.plan_uuid):
        cur = await conn.execute(
            "UPDATE plans SET state = 'done', updated_at = now()"
            " WHERE plan_uuid = %s AND state IN ('funded', 'running') RETURNING 1",
            (plan.plan_uuid,),
        )
        # The unspent part of the plan's escrow only returns to the requester when the gateway closes the
        # plan. Only the call that moved the plan to `done` sends it, so a repeat cannot send a second.
        if await cur.fetchone() is not None:
            await enqueue(
                conn,
                "plan.closed",
                {"plan_id": plan.plan_id},
                plan_id=plan.plan_id,
                retry_window_s=settings.event_retry_window_s,
            )


async def process_due(conn: AsyncConnection[TupleRow], settings: Settings, limit: int = 20) -> int:
    """Process every job finished and not yet reacted to, up to ``limit``. Returns how many."""
    jobs = await _claim_finished(conn, limit)
    for job in jobs:
        await process_one(conn, job, settings)
    return len(jobs)


async def stuck_indexes(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> list[int]:
    """Indexes nothing will move on without the requester (``needs_requester`` in plan task O6's own
    words): the newest attempt did not pass and no retry follows it (the attempt cap or the requester's
    agent list is exhausted), or the newest attempt's dispatch was given up before the gateway locked it.
    Computed on demand from ``task_dispatches``, ``jobs``, the outbox and ``tasks.agents`` rather than stored.
    An attempt still being delivered, waiting on its escrow, or running is in flight, not stuck."""
    cur = await conn.execute(_DISPATCHES, (plan.plan_uuid,))
    by_index: dict[int, list[_Dispatch]] = {}
    for index, attempt, has_job, processed, holds, given_up in await cur.fetchall():
        by_index.setdefault(index, []).append(_Dispatch(attempt, has_job, processed, holds, given_up))
    stuck: list[int] = []
    for task in plan.tasks:
        sent = by_index.get(task.draft.index)
        if not sent or any(d.holds for d in sent):
            continue  # never dispatched, or passed
        newest = max(sent, key=lambda d: d.attempt)
        if not newest.has_job:
            if newest.given_up:
                stuck.append(task.draft.index)
            continue
        if newest.processed and _next_agent(task, newest.attempt, settings.max_attempts) is None:
            stuck.append(task.draft.index)
    return stuck


async def next_attempt(conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int) -> int:
    cur = await conn.execute(
        'SELECT coalesce(max(attempt), 0) + 1 FROM task_dispatches WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, index),
    )
    row = await cur.fetchone()
    assert row is not None
    return int(row[0])


async def retry(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, agent_id: str, settings: Settings
) -> str:
    """The requester sends a stuck index to one more agent. The agent takes slot ``attempt`` of
    ``tasks.agents`` (any later pick a given-up dispatch never reached is dropped), so attempt ``n`` keeps
    naming ``agents[n - 1]`` as everywhere else. It is paid from the plan's escrow once the failed attempt's
    payment is back in it (the gateway holds the dispatch until then). The caller checks the index is stuck,
    that no earlier attempt still holds money (``money.holding_attempt``), and that the agent exists."""
    attempt = await next_attempt(conn, plan, index)
    await conn.execute(
        "UPDATE tasks SET agents = coalesce(agents[1:%s], ARRAY[]::text[]) || ARRAY[%s::text]"
        ' WHERE plan_uuid = %s AND "index" = %s',
        (attempt - 1, agent_id, plan.plan_uuid, index),
    )
    return await dispatch.dispatch_task(conn, plan, index, attempt, agent_id, settings)


async def abandon(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> None:
    """The requester gives up on this plan. A plan may be abandoned at any point past ``draft`` (not only
    once every live index is ``needs_requester``: the requester may have other reasons), and this is
    idempotent against a plan that is already ``closed`` or ``done``."""
    await conn.execute(
        "UPDATE plans SET state = 'closed', updated_at = now() WHERE plan_uuid = %s"
        " AND state NOT IN ('closed', 'done')",
        (plan.plan_uuid,),
    )
    # An attempt not yet sent to the gateway must not lock money after the requester gave up, and a retry
    # waiting on its escrow would otherwise hold `plan.closed` back for up to half an hour.
    await conn.execute(
        "UPDATE outbox SET failed_at = now(), last_error = 'the requester closed the plan first'"
        " WHERE plan_id = %s AND type = 'task.dispatch_requested'"
        " AND delivered_at IS NULL AND failed_at IS NULL",
        (plan.plan_id,),
    )
    await enqueue(
        conn,
        "plan.closed",
        {"plan_id": plan.plan_id},
        plan_id=plan.plan_id,
        retry_window_s=settings.event_retry_window_s,
    )


class OutcomeProcessor:
    """Runs ``process_due`` on a timer, the same shape as ``EventDeliverer``: a failing pass is logged and
    retried, never fatal, and ``run`` returns as soon as ``stop`` is set rather than waiting out a full
    poll interval."""

    def __init__(self, pool: Pool, settings: Settings) -> None:
        self._pool = pool
        self._settings = settings

    async def process_due(self, limit: int = 20) -> int:
        async with self._pool.connection() as conn, conn.transaction():
            return await process_due(conn, self._settings, limit)

    async def run(self, poll_s: float, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.process_due()
            except Exception:
                log.exception("outcome processing pass failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_s)
