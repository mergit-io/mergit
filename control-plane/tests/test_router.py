"""The pure Thompson-sampling-over-value-density routing policy (paper 9.3-9.4). No database, no I/O."""

import random
from collections import Counter

from mergit_cp.reputation import Posterior, base_prior, with_cost, with_outcome
from mergit_cp.router import Arm, Mode, draw


def _tight_arm(agent_id: str, theta: float, cost_micros: float, strength: float = 1000.0) -> Arm:
    """A posterior concentrated near (theta, cost_micros): high alpha+beta, high kappa, matching tau/kappa."""
    alpha = theta * strength
    beta = (1 - theta) * strength
    kappa = strength
    tau = cost_micros * kappa
    return Arm(agent_id, Posterior(alpha=alpha, beta=beta, kappa=kappa, tau=tau))


def test_same_seed_same_draw():
    arms = [
        _tight_arm("agent-a", 0.9, 300_000),
        _tight_arm("agent-b", 0.7, 100_000),
    ]
    mode = Mode()
    d1 = draw(arms, 1_000_000, mode, 0.1, random.Random(42))
    d2 = draw(arms, 1_000_000, mode, 0.1, random.Random(42))
    assert d1 == d2


def test_budget_filter_skips_expensive_arm():
    expensive = _tight_arm("expensive", 0.9, 5_000_000, strength=5000.0)
    cheap = _tight_arm("cheap", 0.9, 100_000, strength=5000.0)
    mode = Mode()
    chosen_counts: Counter[str | None] = Counter()
    for seed in range(200):
        d = draw([expensive, cheap], 1_000_000, mode, 0.1, random.Random(seed))
        chosen_counts[d.chosen] += 1
        assert d.chosen != "expensive"
    assert chosen_counts["cheap"] == 200


def test_retry_intolerant_prefers_quality():
    # Paper 8.8 example: X has higher quality but higher cost; Y is cheaper but lower quality.
    x = _tight_arm("X", 0.95, 1_800_000, strength=2000.0)
    y = _tight_arm("Y", 0.88, 600_000, strength=2000.0)
    budget = 2_000_000

    tolerant_picks = Counter(
        draw([x, y], budget, Mode(retry_tolerant=True), 0.1, random.Random(seed)).chosen
        for seed in range(500)
    )
    intolerant_picks = Counter(
        draw([x, y], budget, Mode(retry_tolerant=False), 0.1, random.Random(seed)).chosen
        for seed in range(500)
    )

    assert tolerant_picks["Y"] / 500 >= 0.90
    assert intolerant_picks["X"] / 500 >= 0.90


def test_explore_off_is_greedy_and_never_exploratory():
    arms = [
        _tight_arm("agent-a", 0.9, 300_000),
        _tight_arm("agent-b", 0.95, 900_000),
        Arm("agent-c", base_prior(200_000)),
    ]
    mode = Mode(explore=False)
    for seed in range(50):
        d = draw(arms, 1_000_000, mode, 0.1, random.Random(seed))
        assert d.chosen == d.greedy
        assert d.exploratory is False


def test_cold_arm_is_explored_but_not_favoured():
    # Tight, good posterior exactly as specified in the brief: alpha=95, beta=5, kappa=100, tau=100*200_000.
    confident = Arm("confident", Posterior(alpha=95, beta=5, kappa=100, tau=100 * 200_000))
    cold = Arm("cold", base_prior(200_000))
    budget = 2_000_000
    n = 1000
    chosen_counts: Counter[str | None] = Counter()
    exploratory_when_cold = []
    for seed in range(n):
        d = draw([confident, cold], budget, Mode(), 0.1, random.Random(seed))
        chosen_counts[d.chosen] += 1
        if d.chosen == "cold":
            exploratory_when_cold.append(d.exploratory)

    cold_fraction = chosen_counts["cold"] / n
    assert 0.01 < cold_fraction < 0.5
    assert exploratory_when_cold, "cold arm was never chosen across 1000 seeds"
    assert all(exploratory_when_cold)


def test_no_feasible_arm_returns_none():
    expensive_a = _tight_arm("a", 0.9, 5_000_000, strength=5000.0)
    expensive_b = _tight_arm("b", 0.8, 8_000_000, strength=5000.0)
    for seed in range(50):
        d = draw([expensive_a, expensive_b], 1_000_000, Mode(), 0.1, random.Random(seed))
        assert d.chosen is None


def test_ties_go_to_lower_agent_id():
    identical = [
        Arm("b-agent", Posterior(alpha=50, beta=50, kappa=50, tau=50 * 200_000)),
        Arm("a-agent", Posterior(alpha=50, beta=50, kappa=50, tau=50 * 200_000)),
    ]
    d = draw(identical, 1_000_000, Mode(explore=False), 0.1, random.Random(1))
    assert d.chosen == "a-agent"
    assert d.greedy == "a-agent"


def test_samples_recorded_for_every_arm_including_infeasible():
    expensive = _tight_arm("expensive", 0.9, 5_000_000, strength=5000.0)
    cheap = _tight_arm("cheap", 0.9, 100_000, strength=5000.0)
    d = draw([expensive, cheap], 1_000_000, Mode(), 0.1, random.Random(1))
    agent_ids = {s.agent_id for s in d.samples}
    assert agent_ids == {"expensive", "cheap"}
    by_id = {s.agent_id: s for s in d.samples}
    assert by_id["expensive"].feasible is False
    assert by_id["cheap"].feasible is True


def test_no_arms_returns_none_draw():
    d = draw([], 1_000_000, Mode(), 0.1, random.Random(1))
    assert d.chosen is None
    assert d.greedy is None
    assert d.exploratory is False
    assert d.samples == []


def test_simulation_value_density_beats_quality_greedy():
    """SIMULATION, not a measurement: synthetic agents with known true (theta, mean cost), Bernoulli/
    exponential sampling, no real task data. Numbers below are simulated, never presented as measured."""
    rng = random.Random(2026)

    true_x = (0.95, 1_800_000.0)  # (theta, mean cost), paper 8.8's X
    true_y = (0.88, 600_000.0)  # paper 8.8's Y
    budget = 2_000_000
    n_tasks = 2000

    def simulate(policy_pick) -> tuple[int, float]:
        posteriors = {"X": base_prior(200_000), "Y": base_prior(200_000)}
        successes = 0
        total_cost = 0.0
        for _ in range(n_tasks):
            arms = [Arm(name, posteriors[name]) for name in ("X", "Y")]
            chosen = policy_pick(arms)
            if chosen is None:
                continue
            true_theta, true_cost_mean = true_x if chosen == "X" else true_y
            success = rng.random() < true_theta
            cost = rng.expovariate(1.0 / true_cost_mean)
            cost_micros = max(1, round(cost))
            if success:
                successes += 1
            total_cost += cost_micros
            p = posteriors[chosen]
            p = with_outcome(p, success=success, weight=1.0, gamma=1.0)
            p = with_cost(p, cost_micros, gamma=1.0)
            posteriors[chosen] = p
        return successes, total_cost

    def thompson_pick(arms: list[Arm]) -> str | None:
        return draw(arms, budget, Mode(retry_tolerant=True), 0.1, rng).chosen

    def quality_greedy_pick(arms: list[Arm]) -> str | None:
        # Quality-only greedy: highest posterior-mean theta, cost ignored once budget-feasible. `max`
        # keeps the first element on a tie, so an exact tie (both arms still at the uninformative prior)
        # resolves to whichever arm is first in `arms` ("X") -- deterministic, not a hidden tie-break on
        # agent_id the way `draw()`'s own feasibility objective is.
        feasible = [a for a in arms if a.posterior.cost_mean_micros <= budget * 1.1]
        if not feasible:
            return None
        return max(feasible, key=lambda a: a.posterior.theta_mean).agent_id

    thompson_successes, thompson_cost = simulate(thompson_pick)
    greedy_successes, greedy_cost = simulate(quality_greedy_pick)

    thompson_rate = thompson_successes / thompson_cost
    greedy_rate = greedy_successes / greedy_cost

    print(
        f"[SIMULATED, not measured] Thompson-over-density: {thompson_successes} successes / "
        f"${thompson_cost / 1_000_000:.2f} = {thompson_rate * 1_000_000:.4f} successes/$. "
        f"Quality-only greedy: {greedy_successes} successes / ${greedy_cost / 1_000_000:.2f} = "
        f"{greedy_rate * 1_000_000:.4f} successes/$."
    )

    assert thompson_rate >= 1.5 * greedy_rate, (
        f"[SIMULATED] expected Thompson-over-density success/$ ({thompson_rate}) to be at least 1.5x "
        f"quality-only-greedy's ({greedy_rate})"
    )
