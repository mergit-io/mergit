"""Thompson sampling over value density: the routing policy itself (paper sections 9.3-9.4).

Pure math only, no database, no I/O: `draw` is a total function of its arguments and the given `rng`. It
consumes `Posterior` from `reputation.py` (Task 2) and nothing else from this package; the database side
that turns this into eligibility, concurrency caps and a recorded draw is a later task's job.

The draw (paper 8.8, Global Constraints): `theta_tilde ~ Beta(alpha, beta)` is the sampled success
probability. `rate_tilde ~ Gamma(shape=kappa, rate=tau)` is the sampled cost *rate*; `cost_tilde =
1/rate_tilde` is the sampled cost. Python's `random.gammavariate(alpha, beta)` takes `alpha` as the shape
and `beta` as the *scale* (mean = alpha * beta), not the rate -- so `rng.gammavariate(kappa, 1/tau)` samples
from Gamma(shape=kappa, scale=1/tau), which is exactly Gamma(shape=kappa, rate=tau): its mean is
`kappa * (1/tau) = kappa/tau`, matching `E[rate] = kappa/tau` for a rate-tau Gamma. That sample *is*
`rate_tilde`; `cost_tilde = 1/rate_tilde` follows directly. No double reciprocal, no shape/rate/scale bug --
confirmed against both Python's own documented `gammavariate` semantics
(https://docs.python.org/3/library/random.html#random.gammavariate: "alpha is the shape, beta is the
scale") and the plan's Global Constraints line (`r_tilde ~ Gamma(shape kappa, rate tau),
c_tilde = 1/r_tilde`).

An arm is feasible only if its *sampled* cost fits the budget with tolerance: `cost_tilde <= budget_micros *
(1 + tolerance)`. With `retry_tolerant=True` (the common case, failure is retryable so cost efficiency is
what matters), the feasible arm with the highest sampled *density* `theta_tilde / cost_tilde` wins. With
`retry_tolerant=False` (failure is expensive or irreversible), cost no longer matters once an arm is
feasible at all -- the feasible arm with the highest sampled `theta_tilde` wins. `explore=False` skips the
random draw entirely and picks by the same objective computed on the posterior *means* instead.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .reputation import Posterior


@dataclass(frozen=True)
class Arm:
    agent_id: str
    posterior: Posterior


@dataclass(frozen=True)
class Mode:
    explore: bool = True
    retry_tolerant: bool = True


@dataclass(frozen=True)
class ArmSample:
    agent_id: str
    theta: float
    cost_micros: float
    density: float
    feasible: bool


@dataclass(frozen=True)
class Draw:
    chosen: str | None
    greedy: str | None
    exploratory: bool
    samples: list[ArmSample]


def _sample_arm(arm: Arm, explore: bool, rng: random.Random) -> ArmSample:
    """One arm's (theta, cost_micros) -- sampled from its posterior when `explore`, else its posterior
    means. `density` is always `theta / cost_micros` for *this* theta/cost pair (sampled or mean), not
    `Posterior.density` (which is always the mean) -- so a greedy pick computed from a `samples` entry here
    is consistent with one computed directly from the posterior means."""
    if explore:
        theta = rng.betavariate(arm.posterior.alpha, arm.posterior.beta)
        # `Posterior.__post_init__` requires kappa > 0, but nothing stops 0 < kappa < 1 (unreachable through
        # base_prior/with_cost/pooled_prior today, all of which only ever grow kappa from 1, but not
        # structurally prevented by Posterior itself). A sampled rate_tilde of exactly 0 here would make
        # this division a ZeroDivisionError -- ruled out in practice (gammavariate's support is (0, inf)
        # for any shape > 0), but flagged rather than silently assumed.
        rate_tilde = rng.gammavariate(arm.posterior.kappa, 1 / arm.posterior.tau)
        cost_micros = 1 / rate_tilde
    else:
        theta = arm.posterior.theta_mean
        cost_micros = arm.posterior.cost_mean_micros
    density = theta / cost_micros
    return ArmSample(arm.agent_id, theta, cost_micros, density, feasible=False)


def _best(samples: Sequence[ArmSample], retry_tolerant: bool) -> str | None:
    """The feasible sample that wins under this mode's objective, ties broken by the lower agent_id."""
    feasible = [s for s in samples if s.feasible]
    if not feasible:
        return None
    key: Callable[[ArmSample], float] = (lambda s: s.density) if retry_tolerant else (lambda s: s.theta)
    best_value = max(key(s) for s in feasible)
    winners = [s.agent_id for s in feasible if key(s) == best_value]
    return min(winners)


def draw(arms: Sequence[Arm], budget_micros: int, mode: Mode, tolerance: float, rng: random.Random) -> Draw:
    """Thompson sample each arm (or use its posterior means, if `mode.explore` is False), filter by budget
    feasibility, and pick the winner under `mode.retry_tolerant`'s objective.

    `greedy` is always the posterior-mean pick under the same feasibility filter and objective, regardless
    of `mode.explore` -- it is the deterministic baseline `exploratory` is measured against, and with
    `explore=False` it is also what gets chosen (`chosen == greedy` always, `exploratory` always False).

    `greedy` is `None` whenever no arm is feasible by its posterior *mean* cost -- same budget rule as
    `chosen`, never a fallback that ignores the budget. This matters beyond `draw()` itself: a later task's
    retry/cap logic falls back to `greedy` when an index's exploration cap is hit, and dispatching an
    over-budget arm there would be a real budget violation, not a presentation nicety. Anyone who wants to
    explain *why* nothing was chosen (an eligibility UI) already has everything needed in `samples`, where
    every arm is recorded with its own `feasible` flag regardless of whether it's `chosen` or `greedy`.
    """
    sampled = [_sample_arm(arm, mode.explore, rng) for arm in arms]
    budget_limit = budget_micros * (1 + tolerance)
    samples = [
        ArmSample(s.agent_id, s.theta, s.cost_micros, s.density, feasible=s.cost_micros <= budget_limit)
        for s in sampled
    ]

    means = [_sample_arm(arm, explore=False, rng=rng) for arm in arms]
    # `_sample_arm(explore=False, ...)` never touches `rng`, so this costs no extra draws against `rng`'s
    # state -- the test suite's seeded-reproducibility tests depend on that.
    mean_feasible = [
        ArmSample(m.agent_id, m.theta, m.cost_micros, m.density, feasible=m.cost_micros <= budget_limit)
        for m in means
    ]
    greedy = _best(mean_feasible, mode.retry_tolerant)

    chosen = greedy if not mode.explore else _best(samples, mode.retry_tolerant)
    exploratory = chosen is not None and chosen != greedy
    return Draw(chosen=chosen, greedy=greedy, exploratory=exploratory, samples=samples)
