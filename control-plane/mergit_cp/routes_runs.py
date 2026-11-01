"""The run API and live stream (plan task O7): a requester's own plans, one plan's full detail, the
agent roster, and Server-Sent Events as a run moves. The worker reports live steps to
`POST /v0/internal/progress`; everything else streamed here is read straight from the database on a
short timer, since it is written by other requests, not by that endpoint.

Verdicts and money are read from the `money_events` ledger (`mergit_cp/money.py`, plan task O6), the
structured record of the gateway's verdict and payment events, not from the raw `chain_events_seen` log.
"""

from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from . import money, outcomes, plans, reputation, routing, runs
from .agents import Agent
from .auth import PoolDep, Principal, PrincipalDep, SettingsDep
from .config import Settings
from .db import Pool
from .router import mean_feasible
from .routes_plans import get_agents
from .stream import PlanBroadcaster, sse

router = APIRouter(prefix="/v0/plans", tags=["runs"])
agents_router = APIRouter(prefix="/v0/agents", tags=["agents"])
internal_router = APIRouter(prefix="/v0/internal", tags=["internal"])


def get_broadcaster(request: Request) -> PlanBroadcaster:
    return request.app.state.broadcaster


BroadcasterDep = Annotated[PlanBroadcaster, Depends(get_broadcaster)]


async def _owned_plan(conn: Any, plan_uuid: UUID, principal: Principal) -> plans.StoredPlan:
    plan = await plans.load(conn, plan_uuid)
    if plan is None:
        raise HTTPException(status_code=404, detail="no such plan")
    if not principal.owns(plan.requester):
        raise HTTPException(status_code=403, detail="only the requester may view this plan")
    return plan


@router.get("")
async def list_plans(principal: PrincipalDep, pool: PoolDep) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        summaries = await runs.list_for_requester(conn, principal.owned)
    return [runs.plan_summary_view(s) for s in summaries]


def _needs_requester_view(stuck: dict[int, outcomes.StuckReason]) -> list[dict[str, Any]]:
    return [{"index": index, "reason": reason} for index, reason in sorted(stuck.items())]


@router.get("/{plan_uuid}")
async def plan_detail(
    plan_uuid: UUID, principal: PrincipalDep, pool: PoolDep, settings: SettingsDep
) -> dict[str, Any]:
    """The plan, its attempts and its ledger, plus `needs_requester`: every task index that will never be
    dispatched automatically again, with why (`outcomes.stuck_reasons`, final review M1). The run screen
    reads that instead of re-deriving it, since for an auto-routed task it cannot: there is no pick list to
    run out, and whether a failed attempt is being retried depends on the roster, posteriors and budget."""
    async with pool.connection() as conn:
        plan = await _owned_plan(conn, plan_uuid, principal)
        attempts = await runs.attempts(conn, plan_uuid)
        draws = await runs.routing_draws_for_tasks(conn, [a.task_id for a in attempts])
        ledger = await money.list_for_plan(conn, plan_uuid)
        stuck = await outcomes.stuck_reasons(conn, plan, settings)
    view = plans.view(plan)
    view["attempts"] = [{**runs.attempt_view(a), "routing": draws.get(a.task_id)} for a in attempts]
    view["money_events"] = [money.view(m) for m in ledger]
    view["needs_requester"] = _needs_requester_view(stuck)
    return view


@router.get("/{plan_uuid}/candidates")
async def plan_candidates(
    plan_uuid: UUID, principal: PrincipalDep, pool: PoolDep, settings: SettingsDep
) -> dict[str, Any]:
    """A presentation of every roster agent's posterior for each of this plan's tasks -- eligible or not,
    with a human-readable reason for the ones that aren't -- sorted the way a reader would expect to scan
    them: eligible first, then those whose mean cost fits the task's budget, then by the same metric
    `routing.route`'s draw would actually rank on (`density`, or `theta_mean` when `retry_tolerant` is
    false; see `Posterior.density`'s own docstring). That is the order the deterministic `greedy` pick
    ranks them in.

    Budget feasibility comes from the same rules `route` applies (final review m1). An agent no draw will
    realistically pick for this budget is ineligible with reason `routing.OVER_BUDGET`, whatever the mode.
    `within_budget` is `router.mean_feasible`: false means only an exploratory draw can pick the agent,
    and with exploring off it never will. It is mode-independent on purpose, since the requester can still
    switch exploring on or off on a draft plan after this is fetched.

    This never calls `route()` and never mutates anything -- it only reads `routing.candidates` and
    `reputation.posterior`/`observation_counts`."""
    async with pool.connection() as conn:
        plan = await _owned_plan(conn, plan_uuid, principal)
        agents_by_id = {a.agent_id: a for a in routing.roster(settings)}
        task_views: list[dict[str, Any]] = []
        for task in plan.tasks:
            arms, ineligible = await routing.candidates(conn, plan, task.draft.index, settings)
            posterior_by_agent = {arm.agent_id: arm.posterior for arm in arms}
            for agent_id in ineligible:
                posterior_by_agent[agent_id] = await reputation.posterior(
                    conn, agent_id, plan.category, settings
                )
            candidates: list[dict[str, Any]] = []
            for agent_id, post in posterior_by_agent.items():
                agent = agents_by_id[agent_id]
                outcomes, costs = await reputation.observation_counts(conn, agent_id, plan.category)
                candidates.append(
                    {
                        "agent_id": agent.agent_id,
                        "name": agent.name,
                        "model": agent.model,
                        "provider": agent.provider,
                        "operator": agent.operator,
                        "theta_mean": post.theta_mean,
                        "cost_mean_micros": post.cost_mean_micros,
                        "density": post.density,
                        "outcomes": outcomes,
                        "costs": costs,
                        "eligible": agent_id not in ineligible,
                        "reason": ineligible.get(agent_id),
                        "within_budget": mean_feasible(
                            post, task.draft.budget_usdc_units, settings.router_budget_tolerance
                        ),
                    }
                )
            metric = "theta_mean" if not task.retry_tolerant else "density"
            candidates.sort(key=lambda c: (not c["eligible"], not c["within_budget"], -c[metric]))
            task_views.append(
                {
                    "index": task.draft.index,
                    "routing": task.routing,
                    "explore": task.explore,
                    "retry_tolerant": task.retry_tolerant,
                    "candidates": candidates,
                }
            )
    return {"tasks": task_views}


@agents_router.get("")
async def list_agents(
    agents: Annotated[list[Agent], Depends(get_agents)], pool: PoolDep
) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        views: list[dict[str, Any]] = []
        for a in agents:
            views.append(
                {
                    "agent_id": a.agent_id,
                    "name": a.name,
                    "model": a.model,
                    "provider": a.provider,
                    "reputation": await reputation.stored_posteriors(conn, a.agent_id),
                }
            )
        return views


class ProgressStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    seq: int
    type: str
    cost: dict[str, Any]


@internal_router.post("/progress", status_code=202)
async def internal_progress(
    body: ProgressStep,
    settings: SettingsDep,
    pool: PoolDep,
    broadcaster: BroadcasterDep,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    expected = f"Bearer {settings.worker_token.get_secret_value()}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="bad or missing token")
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT plan_uuid FROM jobs WHERE task_id = %s", (body.task_id,))
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown task_id")
    broadcaster.publish(
        str(row[0]),
        {"task_id": body.task_id, "seq": body.seq, "type": body.type, "cost": body.cost},
    )
    return {"status": "accepted"}


@router.get("/{plan_uuid}/events")
async def plan_events(
    plan_uuid: UUID,
    request: Request,
    principal: PrincipalDep,
    pool: PoolDep,
    settings: SettingsDep,
    broadcaster: BroadcasterDep,
) -> StreamingResponse:
    async with pool.connection() as conn:
        await _owned_plan(conn, plan_uuid, principal)
    return StreamingResponse(
        _stream(pool, broadcaster, plan_uuid, request, settings),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _stream(
    pool: Pool, broadcaster: PlanBroadcaster, plan_uuid: UUID, request: Request, settings: Settings
) -> AsyncIterator[str]:
    """Steps posted to `/v0/internal/progress` are relayed as soon as they arrive; `plan.state`,
    `task.state`, `needs_requester`, `verdict` and `money` are polled from the database at most every
    `settings.sse_poll_s` and only sent when something changed since the last poll. The first poll always
    sends: a client that just connected gets the full current state, not only what changes after it.

    `needs_requester` carries the same list as plan detail's field of that name, as
    `{"needs_requester": [...]}`, sent whole whenever it changes: an auto task's stuck state can change
    with no `jobs` row changing at all (a retry dispatched, or a budget that no longer fits after a
    posterior moved), so it cannot ride along on `task.state`.
    """
    poll_s = settings.sse_poll_s
    key = str(plan_uuid)
    queue = broadcaster.subscribe(key)
    last_state: str | None = None
    last_tasks: dict[int, tuple[str, bool | None]] = {}
    last_stuck: list[dict[str, Any]] | None = None
    sent_money: set[int] = set()
    try:
        while True:
            if await request.is_disconnected():
                return
            try:
                step = await asyncio.wait_for(queue.get(), timeout=poll_s)
            except TimeoutError:
                step = None
            if step is not None:
                yield sse("step.recorded", step)
                continue

            async with pool.connection() as conn:
                plan = await plans.load(conn, plan_uuid)
                if plan is None:
                    return
                attempts = await runs.attempts(conn, plan_uuid)
                ledger = await money.list_for_plan(conn, plan_uuid)
                stuck = _needs_requester_view(await outcomes.stuck_reasons(conn, plan, settings))

            if plan.state != last_state:
                yield sse("plan.state", {"state": plan.state})
                last_state = plan.state
            for a in attempts:
                current = (a.status, a.phi_holds)
                if last_tasks.get(a.index) != current:
                    yield sse("task.state", runs.attempt_view(a))
                    last_tasks[a.index] = current
            if stuck != last_stuck:
                yield sse("needs_requester", {"needs_requester": stuck})
                last_stuck = stuck
            for m in ledger:
                # Track ledger row ids, not a time cursor: a row from a transaction that started earlier
                # but committed after the last poll has an older timestamp (and possibly a lower id)
                # than rows already sent, and must still be sent once.
                if m.id in sent_money:
                    continue
                sent_money.add(m.id)
                yield sse("verdict" if m.kind == "verdict.recorded" else "money", money.view(m))
    finally:
        broadcaster.unsubscribe(key, queue)
