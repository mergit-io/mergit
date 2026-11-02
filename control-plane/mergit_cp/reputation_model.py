"""Cost-adjusted reputation (paper §8): what an agent has been seen to do, and what it costs.

Per agent and category: a Beta posterior over the probability that a task passes its audit, and a Gamma
posterior over the cost of a task (exponential costs, the rate with a Gamma prior). Both decay geometrically,
so recent evidence outweighs old: with gamma = 0.95 the memory is about twenty observations. Value density is
the ratio of expectations, ``D = E[success] / E[cost]``: verified quality per unit cost.

This module is only the arithmetic. Which outcomes count (only validated ones, never faucet-tier work) is
decided where observations are made (``reputation.py``); nothing here reads a ledger. Costs are in whatever
unit the caller uses, consistently (the ledger's is USDC micros).

The cost model is a modelling convenience, as the paper says (§8.3): real task costs are likely
heavier-tailed.
"""

import math
import random
from dataclasses import dataclass

GAMMA = 0.95
"""The decay applied to every parameter before each new observation (paper §8.2)."""


@dataclass(frozen=True, slots=True)
class Params:
    """The prior a new agent-category pair starts from. ``tau0`` has no universal value: the prior mean cost
    is ``tau0 / kappa0``, and it is configuration, not a measurement."""

    tau0: float
    alpha0: float = 1.0
    beta0: float = 1.0
    kappa0: float = 1.0


@dataclass(frozen=True, slots=True)
class Posterior:
    alpha: float
    beta: float
    kappa: float
    tau: float
    n: int = 0
    """How many observations have been folded in (not decayed: a count, not an effective sample size)."""

    @classmethod
    def prior(cls, params: Params) -> "Posterior":
        if min(params.alpha0, params.beta0, params.kappa0, params.tau0) <= 0:
            raise ValueError("every prior parameter must be positive")
        return cls(params.alpha0, params.beta0, params.kappa0, params.tau0)

    def observe(self, success: bool, cost: float, gamma: float = GAMMA) -> "Posterior":
        """One validated outcome. Every parameter decays, then the outcome adds to one Beta parameter, and the
        cost (of a failure too) adds to the Gamma pair."""
        if not math.isfinite(cost) or cost < 0:
            raise ValueError("cost must be a finite, non-negative number")
        if not 0 < gamma <= 1:
            raise ValueError("gamma must be in (0, 1]")
        return Posterior(
            alpha=gamma * self.alpha + (1.0 if success else 0.0),
            beta=gamma * self.beta + (0.0 if success else 1.0),
            kappa=gamma * self.kappa + 1.0,
            tau=gamma * self.tau + cost,
            n=self.n + 1,
        )

    @property
    def mean_success(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    @property
    def mean_cost(self) -> float:
        return self.tau / self.kappa

    @property
    def density(self) -> float:
        """``E[success] / E[cost]`` (a ratio of expectations, paper §8.4)."""
        return self.mean_success * self.kappa / self.tau if self.tau > 0 else math.inf


def draw(posterior: Posterior, rng: random.Random) -> tuple[float, float]:
    """One Thompson draw (paper §9.3): ``(theta, cost)`` with ``theta ~ Beta(alpha, beta)`` and the cost
    ``1 / r`` for a rate ``r ~ Gamma(kappa, tau)``. Seeded by the caller's ``rng``, so it can be replayed."""
    theta = rng.betavariate(posterior.alpha, posterior.beta)
    rate = rng.gammavariate(posterior.kappa, 1.0 / posterior.tau)
    return theta, (1.0 / rate if rate > 0 else math.inf)
