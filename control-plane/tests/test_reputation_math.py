"""Pure Beta x Gamma posterior math (paper sections 8.2-8.7). No database, no I/O."""

from hypothesis import given
from hypothesis import strategies as st

from mergit_cp.reputation import (
    Posterior,
    base_prior,
    pooled_prior,
    update_weight,
    with_cost,
    with_outcome,
)


def test_success_raises_mean_failure_lowers_it():
    p = base_prior(100_000)
    after_success = with_outcome(p, success=True, weight=1.0, gamma=0.95)
    after_failure = with_outcome(p, success=False, weight=1.0, gamma=0.95)
    assert after_success.theta_mean > p.theta_mean
    assert after_failure.theta_mean < p.theta_mean


@given(st.lists(st.booleans(), max_size=500))
def test_decay_bounds_effective_sample(outcomes: list[bool]):
    p = base_prior(100_000)
    for success in outcomes:
        p = with_outcome(p, success=success, weight=1.0, gamma=0.95)
    assert p.alpha + p.beta <= 1 / (1 - 0.95) + 2 + 1e-9


def test_gamma_one_is_undecayed():
    p = base_prior(100_000)
    for success in (True, True, True, False):
        p = with_outcome(p, success=success, weight=1.0, gamma=1.0)
    assert (p.alpha, p.beta) == (4, 2)


def test_cost_mean_tracks_observations():
    p = base_prior(500_000)
    for _ in range(50):
        p = with_cost(p, 300_000, 0.95)
    assert abs(p.cost_mean_micros - 300_000) / 300_000 < 0.01


def test_zero_cost_is_rejected():
    p = base_prior(100_000)
    try:
        with_cost(p, 0, 0.95)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_pooled_prior_never_narrower_than_base():
    base = base_prior(200_000)
    agent_level = Posterior(alpha=1, beta=1, kappa=1, tau=200_000)
    pooled = pooled_prior(agent_level, base, 0.25)
    assert pooled == base


def test_pooled_prior_keeps_agent_mean():
    base = base_prior(200_000)
    agent_level = Posterior(alpha=18, beta=2, kappa=1, tau=200_000)
    pooled = pooled_prior(agent_level, base, 0.25)
    assert pooled.alpha / (pooled.alpha + pooled.beta) == 0.9
    assert pooled.alpha + pooled.beta == 5


def test_pooled_prior_keeps_agent_cost_mean():
    """Cost side mirrors the Beta side: the pooled Gamma prior preserves the agent-level mean cost,
    never its (kappa, tau) pair directly, with strength k0 = max(base.kappa, w * agent_level.kappa)."""
    base = base_prior(200_000)
    agent_level = Posterior(alpha=1, beta=1, kappa=10, tau=3_000_000)  # mean cost 300_000
    pooled = pooled_prior(agent_level, base, 0.25)
    assert pooled.kappa == max(base.kappa, 0.25 * agent_level.kappa)
    assert pooled.cost_mean_micros == agent_level.cost_mean_micros


def test_concentration_discount():
    assert update_weight(1_000_000, 1_000_000, 0) == 1.0
    assert update_weight(1_000_000, 1_000_000, 3) == 0.25
    assert update_weight(10_000, 1_000_000, 0) == 0.01


def test_section_8_8_example():
    # X: theta mean 0.95, cost mean $1.8e6 micros. Y: theta mean 0.88, cost mean $0.6e6 micros.
    x = Posterior(alpha=95, beta=5, kappa=1, tau=1_800_000)
    y = Posterior(alpha=88, beta=12, kappa=1, tau=600_000)
    assert x.theta_mean == 0.95
    assert y.theta_mean == 0.88
    ratio = y.density / x.density
    assert abs(ratio - 2.78) < 0.01
