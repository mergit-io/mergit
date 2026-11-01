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

from . import dispatch, routing
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

_PROCESSED_INDEXES = """
SELECT "index", bool_or(phi_holds = true) AS passed, max(attempt) AS last_attempt
FROM jobs
WHERE plan_uuid = %s AND outcome_processed_at IS NOT NULL
GROUP BY "index"
"""

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

    if job.holds is not True:
        if task.routing == "auto":
            # Mirrors `_next_agent`'s own attempt-cap guard: `route()` itself does not know about
            # `max_attempts` (it only ever asks "what is eligible right now"), so the cap has to be
            # enforced here, same as the pick-mode branch below.
            if job.attempt < settings.max_attempts:
                pending = await routing.route(conn, plan, job.index, job.attempt + 1, settings)
                if pending is not None:
                    assert pending.draw.chosen is not None  # route()'s contract: never None-wrapped
                    task_id = await dispatch.dispatch_task(
                        conn, plan, job.index, job.attempt + 1, pending.draw.chosen, settings
                    )
                    await routing.record_draw(conn, task_id, pending)
                # `pending is None` means nothing is eligible right now (every candidate's operator at its
                # concurrency cap, say) -- an "owed retry" left for `dispatch.dispatch_waiting`'s periodic
                # sweep, not an error.
        else:
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
    """Process every job finished and not yet reacted to, up to ``limit``, then sweep every plan still
    `funded`/`running` for anything an auto-routing task left waiting on capacity
    (`dispatch.dispatch_waiting`) -- the only way a waiting auto task ever gets picked up again once nothing
    else happens to fail or a new chain event doesn't arrive to trigger it. Both run in whatever transaction
    the caller already opened (`OutcomeProcessor.process_due` wraps one around this whole call), the same
    one-transaction discipline `route`'s advisory lock depends on. Returns how many jobs were processed
    (not how many were (re)dispatched by the sweep)."""
    jobs = await _claim_finished(conn, limit)
    for job in jobs:
        await process_one(conn, job, settings)
    await dispatch.dispatch_waiting(conn, settings)
    return len(jobs)


async def _auto_exhausted(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, task: StoredTask, last_attempt: int, settings: Settings
) -> bool:
    """An auto-routing index is stuck only when it will structurally never be retried again: the attempt
    cap is reached, or every agent in the roster has already been dispatched at some attempt for this index
    (so `routing.candidates`' "already tried" exclusion rules out every one of them, forever -- unlike the
    concurrency cap or probation, which are transient and must never make an index permanently
    `needs_requester`)."""
    if last_attempt >= settings.max_attempts:
        return True
    cur = await conn.execute(
        'SELECT DISTINCT agent_id FROM task_dispatches WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, task.draft.index),
    )
    tried = {row[0] for row in await cur.fetchall()}
    roster_ids = {a.agent_id for a in routing.roster(settings)}
    return bool(roster_ids) and roster_ids.issubset(tried)


async def stuck_indexes(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> list[int]:
    """Indexes whose latest processed attempt did not pass and will never be retried automatically again:
    for a ``'pick'``-routing task, the attempt cap or the requester's own agent list is exhausted (unchanged
    from before Task 6); for an ``'auto'``-routing task, see `_auto_exhausted`. ``needs_requester`` in plan
    task O6's own words, computed on demand from ``jobs``/``tasks.agents``/``task_dispatches`` rather than
    stored, since it is exactly what ``dispatch_ready``/``dispatch_waiting`` already would not find ready."""
    cur = await conn.execute(_PROCESSED_INDEXES, (plan.plan_uuid,))
    by_index = {index: (passed, last_attempt) for index, passed, last_attempt in await cur.fetchall()}
    stuck: list[int] = []
    for task in plan.tasks:
        state = by_index.get(task.draft.index)
        if state is None:
            continue  # never dispatched, or still in flight
        passed, last_attempt = state
        if passed:
            continue
        if task.routing == "auto":
            if await _auto_exhausted(conn, plan, task, int(last_attempt), settings):
                stuck.append(task.draft.index)
        elif _next_agent(task, int(last_attempt), settings.max_attempts) is None:
            stuck.append(task.draft.index)
    return stuck


async def abandon(conn: AsyncConnection[TupleRow], plan: StoredPlan, settings: Settings) -> None:
    """The requester gives up on this plan. A plan may be abandoned at any point past ``draft`` (not only
    once every live index is ``needs_requester``: the requester may have other reasons), and this is
    idempotent against a plan that is already ``closed`` or ``done``."""
    await conn.execute(
        "UPDATE plans SET state = 'closed', updated_at = now() WHERE plan_uuid = %s"
        " AND state NOT IN ('closed', 'done')",
        (plan.plan_uuid,),
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
