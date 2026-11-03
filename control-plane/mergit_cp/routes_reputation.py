"""Reading reputation: what each agent has been seen to do and cost, per category (paper §8).

Public, like the agent list. Every figure is derived from validated outcomes on the ledger (see
``reputation.py``); nothing here is entered by hand. An agent with no counted outcomes in a category shows the
prior, labelled as such, so a number that is only configuration is never shown as if it were evidence.
Outcomes funded from free credits are counted separately and never enter the figures (invariant 6).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import StringConstraints

from .agents import Agent
from .auth import PoolDep, SettingsDep
from .config import Settings
from .db import Pool
from .reputation_model import Params, Posterior
from .routes_plans import get_agents

router = APIRouter(prefix="/v0/agents", tags=["reputation"])

Category = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]

NOTE = (
    "Derived from validated outcomes only (an audited pass that was released, an audited failure, or a "
    "challenge the adjudicator upheld). Work funded from free credits is not counted. Where no outcome is "
    "counted the figures are the prior, which is configuration, not a measurement."
)


def _row(agent: Agent, category: str, posterior: Posterior, uncounted: int) -> dict[str, Any]:
    counted = posterior.n
    return {
        "agent_id": agent.agent_id,
        "name": agent.name,
        "category": category,
        "basis": "validated outcomes" if counted else "prior (no counted outcomes)",
        "counted_outcomes": counted,
        "uncounted_credit_outcomes": uncounted,
        "success_mean": posterior.mean_success,
        "cost_mean_micros": posterior.mean_cost,
        "value_density_per_usdc": posterior.density * 1_000_000,  # success per USDC (costs are in micros)
        "effective_sample_size": posterior.alpha + posterior.beta,
    }


async def _load(
    pool: Pool, settings: Settings, agents: list[Agent], category: str | None, agent_id: str | None
) -> list[dict[str, Any]]:
    prior = Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT agent_id, category, alpha, beta, kappa, tau, n FROM agent_posteriors"
            " WHERE (%s::text IS NULL OR category = %s) AND (%s::text IS NULL OR agent_id = %s)",
            (category, category, agent_id, agent_id),
        )
        posteriors = {(r[0], r[1]): Posterior(r[2], r[3], r[4], r[5], r[6]) for r in await cur.fetchall()}
        cur = await conn.execute(
            "SELECT agent_id, category, count(*) FROM task_outcomes WHERE funding = 'credits'"
            " AND (%s::text IS NULL OR category = %s) AND (%s::text IS NULL OR agent_id = %s)"
            " GROUP BY agent_id, category",
            (category, category, agent_id, agent_id),
        )
        uncounted = {(r[0], r[1]): int(r[2]) for r in await cur.fetchall()}
    by_id = {a.agent_id: a for a in agents}
    keys = set(posteriors) | set(uncounted)
    if category is not None:  # every agent on the roster, so a newcomer shows its prior
        keys |= {(a.agent_id, category) for a in agents if agent_id in (None, a.agent_id)}
    return [
        _row(by_id[a], c, posteriors.get((a, c), prior), uncounted.get((a, c), 0))
        for a, c in sorted(keys)
        if a in by_id
    ]


@router.get("/reputation")
async def reputation(
    pool: PoolDep,
    settings: SettingsDep,
    agents: Annotated[list[Agent], Depends(get_agents)],
    category: Annotated[Category | None, Query()] = None,
) -> dict[str, Any]:
    """Every agent-category pair with counted outcomes; with ``category``, every agent on the roster in it."""
    return {"note": NOTE, "agents": await _load(pool, settings, agents, category, None)}


@router.get("/{agent_id}/reputation")
async def agent_reputation(
    agent_id: str,
    pool: PoolDep,
    settings: SettingsDep,
    agents: Annotated[list[Agent], Depends(get_agents)],
    category: Annotated[Category | None, Query()] = None,
) -> dict[str, Any]:
    if agent_id not in {a.agent_id for a in agents}:
        raise HTTPException(status_code=404, detail="no such agent")
    return {"note": NOTE, "agents": await _load(pool, settings, agents, category, agent_id)}
