"""``GET /v0/plans/{plan_uuid}/suggestions``: the agents the posteriors favour for each task of a draft plan.

Advice only. Approval is unchanged: the requester still submits ``agents`` to ``/approve``, and may ignore
every suggestion. Free-credit work never shapes a suggestion, because it is not in the posteriors it ranks
from (invariant 6). See ``routing.py`` for the two modes.

Every roster agent not in a task's ``picks`` is in its ``ineligible`` list with one reason, the most
fundamental that applies: probation or the operator cap (``eligibility``, checked first, so such an agent is
never ranked), then the budget (``routing.OVER_BUDGET``, or ``OVER_BUDGET_IN_THIS_DRAW`` when exploring), then
the ``max_attempts`` cut. When ``picks`` is empty, ``reason`` also says whether the budget call rests on
evidence or only on the configured cost prior (``NO_FIT`` or ``NO_FIT_ON_PRIOR_ALONE``).
"""

import json
import random
import secrets
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import AsyncConnection
from psycopg.rows import TupleRow
from psycopg.types.json import Jsonb

from . import eligibility, plans
from .agents import Agent
from .auth import PoolDep, PrincipalDep, SettingsDep
from .reputation_model import Params, Posterior
from .routes_plans import get_agents
from .routing import BELOW_MAX_ATTEMPTS, Pick, rank

router = APIRouter(prefix="/v0/plans", tags=["routing"])

NOTE = (
    "A suggestion, not an assignment: you still choose the agents when you approve. It ranks agents by "
    "validated success per unit cost in this category, from outcomes the platform recorded; free-credit work "
    "is not counted. An agent with few counted outcomes is marked unproven, and the platform does not yet "
    "cover the cost of an unproven agent that fails, so choosing one can cost you."
)

# A task's ``reason`` when it has no picks. ``NO_FIT`` is the text this field always had; it now stands only
# when at least one agent left out on budget has a recorded cost behind that call.
NO_FIT = "no agent is expected to fit this budget; choose one yourself or raise the budget"
NO_FIT_ON_PRIOR_ALONE = (
    "no agent is expected to fit this budget, but that expectation is only the configured starting cost "
    "estimate, not evidence: none of the agents left out on budget has a recorded cost in this category yet. "
    "Choose one yourself or raise the budget"
)
ALL_LEFT_OUT = (
    "every agent is left out of suggestions for now (each is listed under ineligible with the reason); "
    "you can still choose one yourself"
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
    """Per task: the agents expected to fit its budget, best first (at most ``max_attempts``), and every
    other roster agent under ``ineligible`` with why (the agents cut by ``max_attempts`` first, in rank order,
    then the rest by agent id). With ``explore=true`` the ranking is a seeded Thompson draw over the agents
    probation and the cap leave in, and the draw is recorded so it can be replayed; since that writes,
    exploring calls are limited to ``suggestions_per_hour`` per requester (then 429)."""
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
        excluded = await eligibility.ineligible(conn, agents, settings, datetime.now(UTC))
    prior = Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))
    # Probation and the operator cap come first: an agent they exclude is never ranked, so it is listed with
    # that reason even when it would also be over budget.
    candidates = {a.agent_id: known.get(a.agent_id, prior) for a in agents if a.agent_id not in excluded}
    names = {a.agent_id: a.name for a in agents}

    seed = secrets.randbits(62) if explore else None
    tasks: list[dict[str, Any]] = []
    decisions: list[tuple[int, int, list[Pick]]] = []
    for task in plan.tasks:
        budget = task.draft.budget_usdc_units
        rng = random.Random(f"{seed}/{task.draft.index}")  # noqa: S311  (a replayable draw, not a secret)
        ranked, left_out = rank(
            candidates,
            float(budget),
            explore=explore,
            epsilon=settings.routing_epsilon,
            min_observations=settings.routing_min_observations,
            min_feasible_probability=settings.routing_min_feasible_probability,
            rng=rng,
        )
        picks, cut = ranked[: settings.max_attempts], ranked[settings.max_attempts :]
        decisions.append((task.draft.index, budget, picks))
        view: dict[str, Any] = {
            "index": task.draft.index,
            "budget_usdc_units": str(budget),
            "picks": [_pick_view(p, names[p.agent_id]) for p in picks],
            "ineligible": [
                {"agent_id": p.agent_id, "name": names[p.agent_id], "reason": BELOW_MAX_ATTEMPTS} for p in cut
            ]
            + [
                {"agent_id": agent_id, "name": names[agent_id], "reason": reason}
                for agent_id, reason in sorted((excluded | left_out).items())
            ],
        }
        if not picks:
            view["reason"] = _empty_reason(left_out, excluded, candidates, prior)
        tasks.append(view)

    if seed is not None:
        address = principal.address
        async with pool.connection() as conn, conn.transaction():
            # One lock per requester, so two concurrent calls cannot both pass the limit (as for plans).
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"suggestions:{address}",))
            if await _recent_explorations(conn, address) >= settings.suggestions_per_hour:
                raise HTTPException(
                    status_code=429, detail="too many exploring suggestions this hour; try again later"
                )
            await conn.execute("INSERT INTO suggestion_attempts (requester) VALUES (%s)", (address,))
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


def _empty_reason(
    left_out: dict[str, str], excluded: dict[str, str], candidates: dict[str, Posterior], prior: Posterior
) -> str:
    """Why a task has no picks. With none, every candidate ``rank`` saw is in ``left_out`` on budget, so the
    question is what that budget call rests on: if no agent it left out has a recorded cost, it is only the
    configured prior, and the answer says so rather than reading like evidence."""
    on_budget = [candidates[agent_id] for agent_id in left_out]
    if on_budget and all(_cost_is_the_prior(p, prior) for p in on_budget):
        return NO_FIT_ON_PRIOR_ALONE
    if not on_budget and excluded:
        return ALL_LEFT_OUT
    return NO_FIT


def _cost_is_the_prior(posterior: Posterior, prior: Posterior) -> bool:
    """No cost has been recorded for this agent in this category, so its cost posterior is still the prior.
    That includes an agent whose counted outcomes all metered 0: ``Posterior.observe`` leaves kappa and tau
    alone without a cost, and kappa only ever grows from the prior's once one arrives."""
    return posterior.n == 0 or posterior.kappa == prior.kappa


async def _recent_explorations(conn: AsyncConnection[TupleRow], requester: str) -> int:
    cur = await conn.execute(
        "SELECT count(*) FROM suggestion_attempts WHERE requester = %s AND at > now() - interval '1 hour'",
        (requester,),
    )
    row = await cur.fetchone()
    return int(row[0]) if row else 0


def _snapshot(candidates: dict[str, Posterior]) -> list[dict[str, Any]]:
    return [
        {"agent_id": a, "alpha": p.alpha, "beta": p.beta, "kappa": p.kappa, "tau": p.tau, "n": p.n}
        for a, p in sorted(candidates.items())
    ]


def _pick_record(pick: Pick) -> dict[str, Any]:
    return {"agent_id": pick.agent_id, "score": pick.score, "success": pick.success, "cost": pick.cost}
