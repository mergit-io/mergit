"""Cost-adjusted reputation: a Beta x Gamma posterior per agent (paper sections 8.2-8.7).

This module is pure math only, no database, no I/O: a `Posterior` is a plain value, and every function
here is a total function of its arguments. A later task adds the SQL side (reading and writing posteriors
per agent) to this same module.

The Beta half (`alpha`, `beta`) tracks the agent's success rate; the Gamma half (`kappa`, `tau`) tracks its
mean cost in micro-USD. `density` combines the two into the quantity the router ranks agents by: expected
success per micro-USD spent.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Posterior:
    alpha: float
    beta: float
    kappa: float
    tau: float

    @property
    def theta_mean(self) -> float:
        """Posterior mean success probability."""
        return self.alpha / (self.alpha + self.beta)

    @property
    def cost_mean_micros(self) -> float:
        """Posterior mean cost, in micro-USD."""
        return self.tau / self.kappa

    @property
    def density(self) -> float:
        """Expected success per micro-USD: the quantity Thompson sampling ranks agents by (paper 8.8)."""
        return self.theta_mean / self.cost_mean_micros


def base_prior(prior_cost_micros: int) -> Posterior:
    """The uninformative prior seeded for an agent with no history: Beta(1, 1), Gamma(1, prior_cost)."""
    return Posterior(1, 1, 1, prior_cost_micros)


def with_outcome(p: Posterior, success: bool, weight: float, gamma: float) -> Posterior:
    """Fold one task outcome into the Beta half, decaying prior evidence by `gamma` (paper 8.3-8.4).

    `gamma < 1` makes old evidence count for less than new evidence, so a posterior tracks an agent whose
    true success rate drifts over time rather than averaging over its whole history equally.
    """
    if success:
        alpha, beta = gamma * p.alpha + weight, gamma * p.beta
    else:
        alpha, beta = gamma * p.alpha, gamma * p.beta + weight
    return Posterior(alpha, beta, p.kappa, p.tau)


def with_cost(p: Posterior, cost_micros: int, gamma: float) -> Posterior:
    """Fold one observed cost into the Gamma half, decaying prior evidence by `gamma` (paper 8.3-8.4).

    Raises ValueError when `cost_micros` is not strictly positive: a non-positive cost cannot be a real
    observation (the sealed cost on a job row is always positive once a task actually ran).
    """
    if cost_micros <= 0:
        raise ValueError(f"cost_micros must be positive, got {cost_micros}")
    kappa, tau = gamma * p.kappa + 1, gamma * p.tau + cost_micros
    return Posterior(p.alpha, p.beta, kappa, tau)


def pooled_prior(agent_level: Posterior | None, base: Posterior, w: float) -> Posterior:
    """The prior a router falls back on before an agent has strong agent-level evidence (paper 8.5).

    With no agent-level posterior, that's just `base` (the global, uninformative prior). Otherwise it
    keeps the agent-level posterior's mean (both the success rate and the mean cost) but gives it strength
    `w` times the agent-level evidence, floored at the base prior's own strength -- `w * Beta(1, 1)` would
    be a U-shaped prior that Thompson draws near 0 or 1, which is worse than no agent-level evidence at
    all. The cost side mirrors this exactly: `k0 = max(base.kappa, w * agent_level.kappa)`, and `tau0` is
    picked so the pooled posterior's mean cost equals the agent-level posterior's mean cost
    (`tau0 = k0 * agent_level.cost_mean_micros`), the same way the Beta side preserves `theta_mean`.
    """
    if agent_level is None:
        return base
    n0 = max(base.alpha + base.beta, w * (agent_level.alpha + agent_level.beta))
    mean = agent_level.theta_mean
    new_alpha, new_beta = mean * n0, (1 - mean) * n0
    k0 = max(base.kappa, w * agent_level.kappa)
    tau0 = k0 * agent_level.cost_mean_micros
    return Posterior(new_alpha, new_beta, k0, tau0)


def update_weight(budget_usdc_units: int, value_ref: int, prior_from_requester: int) -> float:
    """How much one outcome from this task should count, relative to a full-weight (weight 1) update
    (paper 8.7): a value term, scaling down for a small budget, times a concentration discount, scaling
    down for a requester who has already supplied `prior_from_requester` outcomes for this agent.

    Predicate strength is folded in as 1 (not a separate factor) because v0 has one predicate kind
    (`exec/0`), and `check_predicate` already refuses predicates that cannot fail -- there is no weaker
    and stronger predicate to tell apart yet.
    """
    return min(1.0, budget_usdc_units / value_ref) / (1 + prior_from_requester)
