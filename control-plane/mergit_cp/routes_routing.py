"""``GET /v0/plans/{plan_uuid}/suggestions``: the agents the posteriors favour for each task of a draft plan.

Advice only. Approval is unchanged: the requester still submits ``agents`` to ``/approve``, and may ignore
every suggestion. Free-credit work never shapes a suggestion, because it is not in the posteriors it ranks
from (invariant 6). See ``routing.py`` for the two modes.
"""

import json
import random
import secrets
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.types.json import Jsonb

from . import plans
from .agents import Agent
from .auth import PoolDep, PrincipalDep, SettingsDep
from .reputation_model import Params, Posterior
from .routes_plans import get_agents
from .routing import Pick, rank

router = APIRouter(prefix="/v0/plans", tags=["routing"])

NOTE = (
    "A suggestion, not an assignment: you still choose the agents when you approve. It ranks agents by "
    "validated success per unit cost in this category, from outcomes the platform recorded; free-credit work "
    "is not counted. An agent with few counted outcomes is marked unproven, and the platform does not yet "
    "cover the cost of an unproven agent that fails, so choosing one can cost you."
)


def _pick_view(pick: Pick, name: str) -> dict[str, Any]:
    return {
        "agent_id": pick.agent_id,
        "name": name,
        "score_per_usdc": pick.score * 1_000_000,  # success per USDC; costs are in micros
        "assumed_success": pick.success,
        "assumed_cost_micros": pick.cost,
        "counted_outcomes": pick.counted_outcomes,
        "unproven": pick.unproven,
    }


@router.get("/{plan_uuid}/suggestions")
async def suggestions(
    plan_uuid: UUID,
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    agents: Annotated[list[Agent], Depends(get_agents)],
    explore: Annotated[bool, Query()] = False,
) -> dict[str, Any]:
    """Per task: the agents expected to fit its budget, best first (at most ``max_attempts``). With
    ``explore=true`` the ranking is a seeded Thompson draw, and the draw is recorded so it can be replayed."""
    async with pool.connection() as conn:
        plan = await plans.load(conn, plan_uuid)
        if plan is None:
            raise HTTPException(status_code=404, detail="no such plan")
        if not principal.owns(plan.requester):
            raise HTTPException(
                status_code=403, detail="only the requester may see suggestions for this plan"
            )
        if plan.state != "draft":
            raise HTTPException(
                status_code=409, detail=f"the plan is {plan.state}; suggestions are for drafts"
            )
        cur = await conn.execute(
            "SELECT agent_id, alpha, beta, kappa, tau, n FROM agent_posteriors WHERE category = %s",
            (plan.category,),
        )
        known = {r[0]: Posterior(r[1], r[2], r[3], r[4], r[5]) for r in await cur.fetchall()}
    prior = Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))
    candidates = {a.agent_id: known.get(a.agent_id, prior) for a in agents}
    names = {a.agent_id: a.name for a in agents}

    seed = secrets.randbits(62) if explore else None
    tasks: list[dict[str, Any]] = []
    decisions: list[tuple[int, int, list[Pick]]] = []
    for task in plan.tasks:
        budget = task.draft.budget_usdc_units
        rng = random.Random(f"{seed}/{task.draft.index}")  # noqa: S311  (a replayable draw, not a secret)
        picks = rank(
            candidates,
            float(budget),
            explore=explore,
            epsilon=settings.routing_epsilon,
            min_observations=settings.routing_min_observations,
            rng=rng,
        )[: settings.max_attempts]
        decisions.append((task.draft.index, budget, picks))
        view: dict[str, Any] = {
            "index": task.draft.index,
            "budget_usdc_units": str(budget),
            "picks": [_pick_view(p, names[p.agent_id]) for p in picks],
        }
        if not picks:
            view["reason"] = (
                "no agent is expected to fit this budget; choose one yourself or raise the budget"
            )
        tasks.append(view)

    if seed is not None:
        async with pool.connection() as conn, conn.transaction():
            for index, budget, picks in decisions:
                await conn.execute(
                    "INSERT INTO routing_decisions (plan_uuid, task_index, category, seed, budget_micros,"
                    " candidates, picks) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (
                        plan.plan_uuid,
                        index,
                        plan.category,
                        seed,
                        budget,
                        Jsonb(_snapshot(candidates)),
                        Jsonb(json.loads(json.dumps([_pick_record(p) for p in picks]))),
                    ),
                )
    return {
        "plan_id": plan.plan_id,
        "mode": "explore" if explore else "greedy",
        "seed": seed,
        "note": NOTE,
        "tasks": tasks,
    }


def _snapshot(candidates: dict[str, Posterior]) -> list[dict[str, Any]]:
    return [
        {"agent_id": a, "alpha": p.alpha, "beta": p.beta, "kappa": p.kappa, "tau": p.tau, "n": p.n}
        for a, p in sorted(candidates.items())
    ]


def _pick_record(pick: Pick) -> dict[str, Any]:
    return {"agent_id": pick.agent_id, "score": pick.score, "success": pick.success, "cost": pick.cost}
