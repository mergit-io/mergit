"""The reputation maths (paper §8 and §9.3): decayed Beta and Gamma updates, value density, one Thompson draw.

The expected numbers are worked by hand in the comments, not read back from the code under test.
"""

import random

import pytest

from mergit_cp.reputation_model import GAMMA, Params, Posterior, draw

PARAMS = Params(tau0=2.0)


def test_the_prior_is_beta_1_1_and_a_cost_prior_from_configuration() -> None:
    p = Posterior.prior(PARAMS)
    assert (p.alpha, p.beta, p.kappa, p.tau, p.n) == (1.0, 1.0, 1.0, 2.0, 0)


def test_a_success_decays_both_beta_parameters_and_adds_one_to_alpha() -> None:
    # 0.95 * 1 + 1 = 1.95 ; 0.95 * 1 = 0.95  (paper §8.2: both decay, one increments)
    p = Posterior.prior(PARAMS).observe(True, cost=4.0)
    assert p.alpha == pytest.approx(1.95)
    assert p.beta == pytest.approx(0.95)


def test_a_failure_decays_both_beta_parameters_and_adds_one_to_beta() -> None:
    p = Posterior.prior(PARAMS).observe(False, cost=4.0)
    assert p.alpha == pytest.approx(0.95)
    assert p.beta == pytest.approx(1.95)


def test_two_successes_in_a_row() -> None:
    # alpha: 0.95 * 1.95 + 1 = 2.8525 ; beta: 0.95 * 0.95 = 0.9025
    p = Posterior.prior(PARAMS).observe(True, 4.0).observe(True, 4.0)
    assert (p.alpha, p.beta) == (pytest.approx(2.8525), pytest.approx(0.9025))
    assert p.n == 2


def test_cost_is_learned_from_failures_as_well_as_successes() -> None:
    # kappa: 0.95 * 1 + 1 = 1.95 ; tau: 0.95 * 2 + 4 = 5.9 (paper §8.3: every completed task informs cost)
    for success in (True, False):
        p = Posterior.prior(PARAMS).observe(success, cost=4.0)
        assert (p.kappa, p.tau) == (pytest.approx(1.95), pytest.approx(5.9))


def test_value_density_is_the_ratio_of_expectations() -> None:
    # after one success costing 4: theta = 1.95 / 2.9 = 0.67241 ; 1 / mean cost = 1.95 / 5.9 = 0.33051
    # D = 0.67241 * 0.33051 = 0.22224
    p = Posterior.prior(PARAMS).observe(True, cost=4.0)
    assert p.mean_success == pytest.approx(1.95 / 2.9)
    assert p.mean_cost == pytest.approx(5.9 / 1.95)
    assert p.density == pytest.approx(0.22224, abs=1e-4)


def test_effective_memory_is_about_twenty_observations_at_gamma_0_95() -> None:
    # alpha + beta follows s <- 0.95 s + 1, which settles at 1 / (1 - 0.95) = 20 (paper §8.2)
    p = Posterior.prior(PARAMS)
    for i in range(400):
        p = p.observe(i % 3 != 0, cost=1.0)
    assert GAMMA == 0.95
    assert p.alpha + p.beta == pytest.approx(20.0, abs=1e-6)


def test_old_evidence_fades() -> None:
    # Fifty failures then fifty successes: the recent run dominates.
    p = Posterior.prior(PARAMS)
    for _ in range(50):
        p = p.observe(False, 1.0)
    for _ in range(50):
        p = p.observe(True, 1.0)
    assert p.mean_success > 0.9


@pytest.mark.parametrize("bad", [-1.0, float("nan"), float("inf")])
def test_a_cost_that_is_not_a_finite_non_negative_number_is_refused(bad: float) -> None:
    with pytest.raises(ValueError, match="cost"):
        Posterior.prior(PARAMS).observe(True, cost=bad)


def test_the_prior_must_be_proper() -> None:
    with pytest.raises(ValueError, match="positive"):
        Posterior.prior(Params(tau0=0.0))


def test_a_draw_is_reproducible_from_its_seed() -> None:
    p = Posterior.prior(PARAMS).observe(True, 4.0)
    assert draw(p, random.Random(7)) == draw(p, random.Random(7))
    assert draw(p, random.Random(7)) != draw(p, random.Random(8))


def test_draws_centre_on_the_posterior() -> None:
    # Many draws: the mean of theta is alpha / (alpha + beta); the harmonic-mean cost c = 1/r is positive.
    p = Posterior.prior(PARAMS)
    for _ in range(10):
        p = p.observe(True, 3.0)
    rng = random.Random(1)
    draws = [draw(p, rng) for _ in range(4000)]
    assert sum(t for t, _ in draws) / len(draws) == pytest.approx(p.mean_success, abs=0.01)
    assert all(0.0 <= t <= 1.0 and c > 0.0 for t, c in draws)
