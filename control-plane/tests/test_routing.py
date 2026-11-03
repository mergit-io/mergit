"""Ranking agents for a task: greedy by posterior means, or a seeded Thompson draw (paper §9.3 and §9.4)."""

import random

import pytest

from mergit_cp.reputation_model import Params, Posterior
from mergit_cp.routing import rank

PRIOR = Posterior.prior(Params(tau0=500_000.0))


def seasoned(successes: int, failures: int, cost: float) -> Posterior:
    """An agent that has passed and failed this many counted tasks, each costing ``cost``."""
    p = PRIOR
    for _ in range(failures):
        p = p.observe(False, cost)
    for _ in range(successes):
        p = p.observe(True, cost)
    return p


def ranked(candidates: dict[str, Posterior], budget: float = 1_000_000, **over: object) -> list[str]:
    args: dict[str, object] = {
        "explore": False,
        "epsilon": 0.1,
        "min_observations": 5,
        "rng": random.Random(0),
    } | over
    return [p.agent_id for p in rank(candidates, budget, **args)]  # type: ignore[arg-type]


def test_greedy_ranks_by_mean_success_over_mean_cost():
    # b passes most often at the lowest price; c is as reliable but twice the price (still ahead of the
    # unreliable a, whose success is a quarter of c's for the same half price).
    got = ranked(
        {"a": seasoned(2, 8, 300_000), "b": seasoned(9, 1, 300_000), "c": seasoned(9, 1, 600_000)},
    )
    assert got == ["b", "c", "a"]


def test_greedy_is_deterministic_and_ignores_the_random_generator():
    cands = {"a": seasoned(5, 5, 300_000), "b": seasoned(6, 4, 300_000)}
    assert ranked(cands, rng=random.Random(1)) == ranked(cands, rng=random.Random(99)) == ["b", "a"]


def test_ties_break_by_agent_id_not_by_insertion_order():
    assert ranked({"b": PRIOR, "a": PRIOR}) == ["a", "b"]


def test_an_agent_whose_cost_would_not_fit_the_budget_is_skipped():
    pricey = seasoned(10, 0, 5_000_000)
    assert ranked({"cheap": seasoned(5, 5, 200_000), "pricey": pricey}, budget=1_000_000) == ["cheap"]


def test_the_budget_slack_lets_a_slightly_dearer_agent_in():
    edge = seasoned(10, 0, 1_050_000)  # mean cost 1.05M against a 1M budget
    assert ranked({"x": edge}, budget=1_000_000, epsilon=0.0) == []
    assert ranked({"x": edge}, budget=1_000_000, epsilon=0.1) == ["x"]


def test_when_nothing_fits_the_answer_is_empty_not_a_guess():
    assert ranked({"a": seasoned(10, 0, 9_000_000)}, budget=100_000) == []


def test_a_newcomer_is_ranked_on_its_prior_and_called_unproven():
    picks = rank(
        {"new": PRIOR, "old": seasoned(20, 0, 300_000)},
        1_000_000,
        explore=False,
        epsilon=0.1,
        min_observations=5,
        rng=random.Random(0),
    )
    by_id = {p.agent_id: p for p in picks}
    assert by_id["new"].unproven and by_id["new"].counted_outcomes == 0
    assert not by_id["old"].unproven and by_id["old"].counted_outcomes == 20


def test_an_exploring_draw_is_reproducible_from_its_seed():
    cands = {"a": seasoned(3, 3, 300_000), "b": seasoned(3, 3, 300_000), "c": PRIOR}
    first = rank(cands, 1_000_000, explore=True, epsilon=0.1, min_observations=5, rng=random.Random(5))
    again = rank(cands, 1_000_000, explore=True, epsilon=0.1, min_observations=5, rng=random.Random(5))
    assert first == again


def test_an_exploring_draw_skips_an_agent_whose_drawn_cost_cannot_fit():
    # kappa 1, tau 1e12: the drawn cost is around a million times the budget, every time.
    hopeless = Posterior(alpha=5.0, beta=1.0, kappa=1.0, tau=1e12, n=10)
    for seed in range(20):
        got = rank(
            {"h": hopeless, "ok": seasoned(5, 5, 300_000)},
            1_000_000,
            explore=True,
            epsilon=0.1,
            min_observations=5,
            rng=random.Random(seed),
        )
        assert [p.agent_id for p in got] == ["ok"]


def test_exploring_still_favours_the_better_agent_most_of_the_time():
    good, poor = seasoned(18, 2, 300_000), seasoned(3, 17, 300_000)
    wins = sum(
        rank(
            {"good": good, "poor": poor},
            1_000_000,
            explore=True,
            epsilon=0.1,
            min_observations=5,
            rng=random.Random(seed),
        )[0].agent_id
        == "good"
        for seed in range(300)
    )
    assert wins > 270  # an experienced, clearly better agent wins nearly every draw


def test_exploring_gives_an_uncertain_newcomer_some_of_the_draws():
    veteran, newcomer = seasoned(14, 6, 300_000), PRIOR  # newcomer's prior is wide: worth trying sometimes
    firsts = [
        rank(
            {"vet": veteran, "new": newcomer},
            1_000_000,
            explore=True,
            epsilon=0.1,
            min_observations=5,
            rng=random.Random(seed),
        )[0].agent_id
        for seed in range(400)
    ]
    assert 0 < firsts.count("new") < 400


@pytest.mark.parametrize("explore", [False, True])
def test_every_pick_says_what_it_was_scored_on(explore: bool):
    picks = rank(
        {"a": seasoned(4, 1, 300_000)},
        1_000_000,
        explore=explore,
        epsilon=0.1,
        min_observations=5,
        rng=random.Random(3),
    )
    p = picks[0]
    assert p.score == pytest.approx(p.success / p.cost)
    assert 0.0 <= p.success <= 1.0 and p.cost > 0.0
