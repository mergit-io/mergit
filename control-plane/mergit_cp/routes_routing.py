"""``GET /v0/plans/{plan_uuid}/suggestions``: the agents the posteriors favour for each task of a draft plan.

Advice only. Approval is unchanged: the requester still submits ``agents`` to ``/approve``, and may ignore
every suggestion. Free-credit work never shapes a suggestion, because it is not in the posteriors it ranks
from (invariant 6). See ``routing.py`` for the two modes.

Every roster agent not in a task's ``picks`` is in its ``ineligible`` list with one reason, the most
fundamental that applies: probation or the operator cap (``eligibility``, checked first, so such an agent is
never ranked), then the budget (``routing.OVER_BUDGET``, or ``OVER_BUDGET_IN_THIS_DRAW`` when exploring), then
the ``max_attempts`` cut. When ``picks`` is empty, ``reason`` says only what is true of every agent left out:
whether one merely missed this draw (``NO_FIT_THIS_DRAW``), and otherwise whether the budget call rests on
evidence or only on the configured cost prior (``NO_FIT`` or ``NO_FIT_ON_PRIOR_ALONE``): ``_empty_reason``.
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
from .routing import BELOW_MAX_ATTEMPTS, OVER_BUDGET_IN_THIS_DRAW, Pick, rank

router = APIRouter(prefix="/v0/plans", tags=["routing"])

NOTE = (
    "A suggestion, not an assignment: you still choose the agents when you approve. It ranks agents by "
    "validated success per unit cost in this category, from outcomes the platform recorded; free-credit work "
    "is not counted. An agent with few counted outcomes is marked unproven, and the platform does not yet "
    "cover the cost of an unproven agent that fails, so choosing one can cost you."
)

# A task's ``reason`` when it has no picks (``_empty_reason`` chooses). ``NO_FIT`` is the text this field
# always had; it now stands only when every agent ranked was over budget on its posterior (not just in one
# draw) and at least one of them has a recorded cost behind that call.
NO_FIT = "no agent is expected to fit this budget; choose one yourself or raise the budget"
NO_FIT_ON_PRIOR_ALONE = (
    "no agent is expected to fit this budget, but that expectation is only the configured starting cost "
    "estimate, not evidence: none of the agents left out on budget has a recorded cost in this category yet. "
    "Choose one yourself or raise the budget"
)
NO_FIT_THIS_DRAW = (
    "no agent's drawn cost fit the budget this time, but at least one could have (each is listed under "
    "ineligible with the reason): this is one unlucky draw, not evidence that none can do it. Ask again, use "
    "the default ranking (without explore), or choose one yourself"
)
ALL_LEFT_OUT = (
    "every agent is left out of suggestions for now (each is listed under ineligible with the reason); "
    "you can still choose one yourself"
)
PARTLY_LEFT_OUT = (
    "some agents are left out for probation or the operator cap, whatever their cost (see ineligible); "
    "of the others, "
)
"""Put before any of the budget reasons when probation or the cap also left agents out, so the answer never
implies the budget is the only obstacle: an agent out for probation may well fit the budget."""


def _pick_view(pick: Pick, name: str, cost_is_prior: bool) -> dict[str, Any]:
    """``cost_is_prior`` (additive) is ``_cost_is_the_prior`` for this agent: no cost recorded in this
    category yet, even if it has counted outcomes (all metered 0). A client then must not show
    ``assumed_cost_micros`` as a measured cost; it is only the configured starting estimate."""
    return {
        "agent_id": pick.agent_id,
        "name": name,
        "score_per_usdc": pick.score * 1_000_000,  # success per USDC; costs are in micros
        "assumed_success": pick.success,
        "assumed_cost_micros": pick.cost,
        "counted_outcomes": pick.counted_outcomes,
        "unproven": pick.unproven,
        "cost_is_prior": cost_is_prior,
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
            "picks": [
                _pick_view(p, names[p.agent_id], _cost_is_the_prior(candidates[p.agent_id], prior))
                for p in picks
            ],
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
    """Why a task has no picks. With none, every candidate ``rank`` saw is in ``left_out`` on budget; the
    answer says only what is true of all of them:

    * If any of them only missed this draw (``OVER_BUDGET_IN_THIS_DRAW``), that agent could fit, so "no agent
      is expected to fit" is false: ``NO_FIT_THIS_DRAW``, whatever the others' reasons.
    * Otherwise every one is over budget on its posterior. If none of those has a recorded cost, that call is
      only the configured prior (``NO_FIT_ON_PRIOR_ALONE``); else it rests on evidence (``NO_FIT``).
    * With nobody ranked at all, probation and the cap left out the whole roster (``ALL_LEFT_OUT``).

    When probation or the cap also left agents out, a budget reason is prefixed with ``PARTLY_LEFT_OUT``,
    since those agents' cost was never the question."""
    if not left_out:
        return ALL_LEFT_OUT if excluded else NO_FIT
    if OVER_BUDGET_IN_THIS_DRAW in left_out.values():
        budget = NO_FIT_THIS_DRAW
    elif all(_cost_is_the_prior(candidates[agent_id], prior) for agent_id in left_out):
        budget = NO_FIT_ON_PRIOR_ALONE
    else:
        budget = NO_FIT
    return PARTLY_LEFT_OUT + budget if excluded else budget


def _cost_is_the_prior(posterior: Posterior, prior: Posterior) -> bool:
    """No cost has been recorded for this agent in this category, so its cost posterior is still the prior.
    Kappa alone tells: ``Posterior.observe`` leaves kappa and tau alone for an outcome without a cost (one
    that metered 0), and moves kappa to ``0.95 kappa + 1`` with one, which from the prior's 1 only grows and
    never returns. So this also covers an agent with no counted outcome (it is the prior) and one whose
    counted outcomes all metered 0, which is why it does not test ``n``. It relies on the prior's kappa being
    below 20, the fixed point of that update; the route's prior has 1."""
    return posterior.kappa == prior.kappa


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
