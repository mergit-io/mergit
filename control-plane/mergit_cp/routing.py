"""Ranking agents for a task (paper §9.3 and §9.4): suggestions only, never an assignment.

Two modes, both over the same posteriors (``reputation_model``):

* **greedy** (the default): each candidate is scored by its posterior-mean value density, mean success over
  mean cost. Nothing is random. This is the paper's exploration suppression (§9.4), and it is what a requester
  gets unless they ask to explore.
* **explore**: Thompson sampling. Each candidate draws a success probability from its Beta and a cost from
  its Gamma. A candidate whose drawn cost exceeds the task budget (with ``epsilon`` of slack) is skipped, and
  the rest rank by drawn success over drawn cost. A draw is reproducible from the seed.

A candidate with fewer than ``min_observations`` counted outcomes is marked unproven. The platform does not
yet absorb the cost of a failed exploratory draw (paper §9.5: the subsidy ledger is not built), so an unproven
pick can cost the requester, and the caller must say so.
"""

import random
from dataclasses import dataclass

from .reputation_model import Posterior, draw


@dataclass(frozen=True, slots=True)
class Pick:
    agent_id: str
    score: float
    """Success over cost, per micro of cost: what the ranking is by."""
    success: float
    """The success probability the score used (the posterior mean, or the draw)."""
    cost: float
    """The cost, in micros, the score used (the posterior mean, or the draw)."""
    counted_outcomes: int
    unproven: bool


def rank(
    candidates: dict[str, Posterior],
    budget_micros: float,
    *,
    explore: bool,
    epsilon: float,
    min_observations: int,
    rng: random.Random,
) -> list[Pick]:
    """The feasible candidates, best first (ties by agent id, so the order never depends on dict order).
    Empty when none is expected to fit the budget. ``rng`` is only used when exploring, in agent-id order."""
    limit = budget_micros * (1.0 + epsilon)
    picks: list[Pick] = []
    for agent_id in sorted(candidates):
        posterior = candidates[agent_id]
        success, cost = draw(posterior, rng) if explore else (posterior.mean_success, posterior.mean_cost)
        if not cost <= limit:  # also skips an infinite or undefined cost
            continue
        picks.append(
            Pick(
                agent_id=agent_id,
                score=success / cost if cost > 0 else float("inf"),
                success=success,
                cost=cost,
                counted_outcomes=posterior.n,
                unproven=posterior.n < min_observations,
            )
        )
    picks.sort(key=lambda p: (-p.score, p.agent_id))
    return picks
