"""Pure Beta x Gamma posterior math (paper sections 8.2-8.7). No database, no I/O."""

import pytest
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


@given(st.lists(st.booleans(), min_size=500, max_size=500))
def test_decay_bounds_effective_sample(outcomes: list[bool]):
    # s_n = alpha+beta follows s_n = gamma^n*s_0 + (1-gamma^n)*(1/(1-gamma)), a weighted average of
    # s_0=2 and the limit 1/(1-gamma)=20, so it is always < 20 and converges to 20 as n grows -- never
    # higher, regardless of which outcomes are successes vs failures (weight is added every step either
    # way). min_size=500 forces every run to actually exercise 500 outcomes, not whatever short list
    # hypothesis happens to shrink/generate by default.
    p = base_prior(100_000)
    for success in outcomes:
        p = with_outcome(p, success=success, weight=1.0, gamma=0.95)
    assert p.alpha + p.beta <= 20 + 1e-9


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


def test_pooled_prior_floor_binds_and_preserves_agent_means():
    """Unlike the other pooled_prior tests, here the base-strength floor actually binds on BOTH sides,
    and a naive un-floored reading (`w * agent_alpha, w * agent_beta` / `w * agent_kappa, w * agent_tau`)
    would happen to land on the same *means* but the wrong *fields* -- so this test pins down the exact
    (alpha, beta, kappa, tau), not just the derived means, to actually catch that bug.

    agent_level = Posterior(3, 1, 2, 600_000) (mean theta=0.75, mean cost=300_000), w=0.25, against the
    uninformative base_prior(999_999) (base's own tau is irrelevant here -- only base.kappa=1 and
    base.alpha+base.beta=2 matter, and 999_999 is chosen to be nothing like 300_000 so a bug that leaked
    the base's cost in would be obvious).

    Beta side:  n0 = max(2, 0.25*4) = max(2, 1) = 2            (floor binds: w*4=1 < base's 2)
                new_alpha, new_beta = 0.75*2, 0.25*2 = 1.5, 0.5
    Cost side:  k0 = max(1, 0.25*2) = max(1, 0.5) = 1          (floor binds: w*2=0.5 < base's 1)
                tau0 = k0 * (600_000/2) = 1 * 300_000 = 300_000

    Naive un-floored formula would instead give alpha=0.75, beta=0.25, kappa=0.5, tau=150_000 -- different
    fields, but coincidentally the same theta_mean (0.75) and cost_mean_micros (300_000), because scaling
    both halves of a ratio by the same w leaves the ratio unchanged. So this test checks the fields
    themselves, not just the derived means.
    """
    base = base_prior(999_999)
    agent_level = Posterior(alpha=3, beta=1, kappa=2, tau=600_000)
    pooled = pooled_prior(agent_level, base, 0.25)
    assert (pooled.alpha, pooled.beta, pooled.kappa, pooled.tau) == (1.5, 0.5, 1, 300_000)
    assert pooled.theta_mean == 0.75
    assert pooled.cost_mean_micros == 300_000
    # Sanity: the naive un-floored reading is a genuinely different (wrong) result, not a coincidence.
    naive_alpha, naive_beta = 0.25 * agent_level.alpha, 0.25 * agent_level.beta
    naive_kappa, naive_tau = 0.25 * agent_level.kappa, 0.25 * agent_level.tau
    naive = (naive_alpha, naive_beta, naive_kappa, naive_tau)
    assert naive != (pooled.alpha, pooled.beta, pooled.kappa, pooled.tau)


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


@pytest.mark.parametrize(
    "fields",
    [
        {"alpha": 0, "beta": 1, "kappa": 1, "tau": 1},
        {"alpha": 1, "beta": 0, "kappa": 1, "tau": 1},
        {"alpha": 1, "beta": 1, "kappa": 0, "tau": 1},
        {"alpha": 1, "beta": 1, "kappa": 1, "tau": 0},
    ],
)
def test_posterior_rejects_non_positive_fields(fields: dict[str, float]):
    """A later task builds `Posterior` straight from database rows; a malformed row (e.g. kappa=0) must
    fail loudly here, not with a silent ZeroDivisionError deep inside theta_mean/cost_mean_micros."""
    with pytest.raises(ValueError, match="strictly positive"):
        Posterior(**fields)


def test_with_outcome_floors_a_parameter_that_would_underflow():
    """Final review n2. With the paper's gamma = 0.95 the decay cannot actually reach 0.0: once a parameter
    is a few subnormal ulps, `0.95 * x` rounds back to `x`, so it stalls there (checked here, so the note in
    `with_outcome` stays true). `with_outcome` takes any gamma, though, and with 0.5 the smallest subnormal
    rounds to exactly 0.0, which `Posterior` rejects. The floor keeps both decayed sides positive."""
    tiny = 5e-324
    assert 0.95 * tiny == tiny  # stalls, never reaches zero
    assert 0.5 * tiny == 0.0  # does reach zero
    after = with_outcome(Posterior(1, tiny, 1, 1), success=True, weight=1.0, gamma=0.5)
    assert after.beta > 0
    after = with_outcome(Posterior(tiny, 1, 1, 1), success=False, weight=1.0, gamma=0.5)
    assert after.alpha > 0


def test_pooled_prior_survives_an_agent_whose_mean_rounds_to_one():
    """Final review n2, the reachable form: after some 660 straight full-weight successes, beta is under
    2^-53 of alpha, so `theta_mean` rounds to exactly 1.0. Pooling computed `(1 - mean) * n0`, exactly 0.0,
    and `Posterior` rejected the pooled prior -- every new category for a consistently good agent would
    have failed to load."""
    agent = base_prior(200_000)
    for _ in range(700):
        agent = with_outcome(agent, success=True, weight=1.0, gamma=0.95)
    assert agent.theta_mean == 1.0
    assert 1 - agent.theta_mean == 0.0
    pooled = pooled_prior(agent, base_prior(200_000), w=0.25)
    assert pooled.beta > 0
    assert pooled.theta_mean == pytest.approx(agent.theta_mean)
