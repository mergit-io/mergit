"""Ranking agents for a task (paper §9.3 and §9.4): suggestions only, never an assignment.

Two modes, both over the same posteriors (``reputation_model``):

* **greedy** (the default): each candidate is scored by its posterior-mean value density, mean success over
  mean cost. Nothing is random. This is the paper's exploration suppression (§9.4), and it is what a requester
  gets unless they ask to explore. A candidate whose mean cost exceeds the task budget (with ``epsilon`` of
  slack) is left out as ``OVER_BUDGET``.
* **explore**: Thompson sampling. A candidate whose chance of drawing a cost within the budget
  (``feasible_probability``) is below ``min_feasible_probability`` is left out as ``OVER_BUDGET`` before the
  draw, and takes no draw. Each other candidate draws a success probability from its Beta and a cost from its
  Gamma; one whose drawn cost exceeds the budget is left out of this draw only (``OVER_BUDGET_IN_THIS_DRAW``),
  and the rest rank by drawn success over drawn cost. A draw is reproducible from the seed.

Every candidate ``rank`` does not return is reported with its reason; nothing is dropped silently. What else
leaves an agent out (probation, the operator cap: ``eligibility``) is decided before ``rank`` is called, and
the ``max_attempts`` cut after; ``rank`` knows about neither.

A candidate with fewer than ``min_observations`` counted outcomes is marked unproven. The platform does not
yet absorb the cost of a failed exploratory draw (paper §9.5: the subsidy ledger is not built), so an unproven
pick can cost the requester, and the caller must say so.

``budget_limit``, ``mean_feasible``, ``_upper_regularized_gamma`` and ``feasible_probability`` are ported from
the reviewed ``router.py`` on ``archive/auto-dispatch-routing``.
"""

import math
import random
from dataclasses import dataclass

from .reputation_model import Posterior, draw

OVER_BUDGET = "over budget for this task"
"""The posterior says this agent will not fit the budget: its mean cost is over it (greedy), or its chance of
drawing a cost within it is below ``min_feasible_probability`` (explore)."""
OVER_BUDGET_IN_THIS_DRAW = "over budget in this draw"
"""Explore only: this agent could fit, but the cost it drew this time did not. Another draw may include it."""
BELOW_MAX_ATTEMPTS = "ranked below the first max_attempts"
"""Fits the budget, but ranked after the ``max_attempts`` agents a task can list (applied by the caller)."""


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


def budget_limit(budget_micros: float, epsilon: float) -> float:
    """The most a cost may be and still fit ``budget_micros``: the one budget rule ``rank``,
    ``mean_feasible`` and ``feasible_probability`` all share."""
    return budget_micros * (1.0 + epsilon)


def mean_feasible(posterior: Posterior, budget_micros: float, epsilon: float) -> bool:
    """Whether the posterior *mean* cost fits the budget: the test greedy ranking applies."""
    return posterior.mean_cost <= budget_limit(budget_micros, epsilon)


def _upper_regularized_gamma(a: float, x: float) -> float:
    """Q(a, x) = Gamma(a, x) / Gamma(a), the upper regularized incomplete gamma function, for a > 0.

    The standard pair of evaluations (Numerical Recipes 6.2): the power series for P = 1 - Q when
    x < a + 1, where it converges fast, and the modified-Lentz continued fraction for Q itself otherwise.
    Both run to double precision; the result is clamped into [0, 1] against rounding."""
    if x <= 0:
        return 1.0
    log_prefactor = -x + a * math.log(x) - math.lgamma(a)
    if x < a + 1:
        term = 1.0 / a
        total = term
        n = a
        for _ in range(10_000):
            n += 1
            term *= x / n
            total += term
            if abs(term) < abs(total) * 1e-16:
                break
        return min(1.0, max(0.0, 1.0 - total * math.exp(log_prefactor)))
    tiny = 1e-300
    b = x + 1 - a
    c = 1 / tiny
    d = 1 / b
    h = d
    for i in range(1, 10_000):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-16:
            break
    return min(1.0, max(0.0, math.exp(log_prefactor) * h))


def feasible_probability(posterior: Posterior, budget_micros: float, epsilon: float) -> float:
    """The probability that one Thompson draw of this agent's cost fits the budget: P(cost <= limit).

    The drawn cost is ``1 / r`` with ``r ~ Gamma(shape=kappa, rate=tau)`` (``reputation_model.draw``), so
    ``cost <= limit`` is ``r >= 1 / limit``, whose probability is the upper regularized incomplete gamma
    function ``Q(kappa, tau / limit)``. Closed form for the cold prior (``kappa = 1``): ``exp(-tau / limit)``.

    An agent whose mean cost fits has ``tau / limit <= kappa``, so this is at least ``Q(kappa, kappa)``: 1/e
    at ``kappa = 1``, rising toward 1/2. Every posterior here has ``kappa >= 1`` (the prior's is 1, and an
    observed cost moves it to ``0.95 kappa + 1``), which is why ``routing_min_feasible_probability`` is capped
    at 0.25: exploring never leaves out an agent that greedy ranking would suggest.
    """
    limit = budget_limit(budget_micros, epsilon)
    if limit <= 0:
        return 0.0
    return _upper_regularized_gamma(posterior.kappa, posterior.tau / limit)


def rank(
    candidates: dict[str, Posterior],
    budget_micros: float,
    *,
    explore: bool,
    epsilon: float,
    min_observations: int,
    min_feasible_probability: float,
    rng: random.Random,
) -> tuple[list[Pick], dict[str, str]]:
    """The feasible candidates, best first (ties by agent id, so the order never depends on dict order), and
    every other candidate mapped to why it is left out (``OVER_BUDGET`` or ``OVER_BUDGET_IN_THIS_DRAW``).
    Each candidate is in exactly one of the two. ``rng`` is only used when exploring, in agent-id order, and
    only by candidates not already left out by ``min_feasible_probability``."""
    limit = budget_limit(budget_micros, epsilon)
    picks: list[Pick] = []
    left_out: dict[str, str] = {}
    for agent_id in sorted(candidates):
        posterior = candidates[agent_id]
        if explore:
            if feasible_probability(posterior, budget_micros, epsilon) < min_feasible_probability:
                left_out[agent_id] = OVER_BUDGET
                continue
            success, cost = draw(posterior, rng)
            if not cost <= limit:  # also an infinite or undefined drawn cost
                left_out[agent_id] = OVER_BUDGET_IN_THIS_DRAW
                continue
        else:
            if not mean_feasible(posterior, budget_micros, epsilon):
                left_out[agent_id] = OVER_BUDGET
                continue
            success, cost = posterior.mean_success, posterior.mean_cost
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
    return picks, left_out
