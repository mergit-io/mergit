"""Ranking agents for a task: greedy by posterior means, or a seeded Thompson draw (paper §9.3 and §9.4)."""

import math
import random

import pytest
from annotated_types import Le

from mergit_cp.config import Settings
from mergit_cp.reputation_model import Params, Posterior, draw
from mergit_cp.routing import (
    OVER_BUDGET,
    OVER_BUDGET_IN_THIS_DRAW,
    Pick,
    budget_limit,
    feasible_probability,
    mean_feasible,
    rank,
)

PRIOR = Posterior.prior(Params(tau0=500_000.0))
THRESHOLD = 0.01  # routing_min_feasible_probability's default


def seasoned(successes: int, failures: int, cost: float) -> Posterior:
    """An agent that has passed and failed this many counted tasks, each costing ``cost``."""
    p = PRIOR
    for _ in range(failures):
        p = p.observe(False, cost)
    for _ in range(successes):
        p = p.observe(True, cost)
    return p


def ranking(
    candidates: dict[str, Posterior], budget: float = 1_000_000, **over: object
) -> tuple[list[Pick], dict[str, str]]:
    args: dict[str, object] = {
        "explore": False,
        "epsilon": 0.1,
        "min_observations": 5,
        "min_feasible_probability": THRESHOLD,
        "rng": random.Random(0),
    } | over
    return rank(candidates, budget, **args)  # type: ignore[arg-type]


def picks(candidates: dict[str, Posterior], budget: float = 1_000_000, **over: object) -> list[Pick]:
    return ranking(candidates, budget, **over)[0]


def ranked(candidates: dict[str, Posterior], budget: float = 1_000_000, **over: object) -> list[str]:
    return [p.agent_id for p in picks(candidates, budget, **over)]


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


def test_an_agent_whose_cost_would_not_fit_the_budget_is_left_out_and_says_so():
    pricey = seasoned(10, 0, 5_000_000)
    got, left_out = ranking({"cheap": seasoned(5, 5, 200_000), "pricey": pricey}, budget=1_000_000)
    assert [p.agent_id for p in got] == ["cheap"]
    assert left_out == {"pricey": OVER_BUDGET}


def test_the_budget_slack_lets_a_slightly_dearer_agent_in():
    edge = seasoned(10, 0, 1_050_000)  # mean cost 1.05M against a 1M budget
    assert ranked({"x": edge}, budget=1_000_000, epsilon=0.0) == []
    assert ranked({"x": edge}, budget=1_000_000, epsilon=0.1) == ["x"]


def test_when_nothing_fits_the_answer_is_empty_not_a_guess():
    assert ranking({"a": seasoned(10, 0, 9_000_000)}, budget=100_000) == ([], {"a": OVER_BUDGET})


def test_a_newcomer_is_ranked_on_its_prior_and_called_unproven():
    by_id = {p.agent_id: p for p in picks({"new": PRIOR, "old": seasoned(20, 0, 300_000)})}
    assert by_id["new"].unproven and by_id["new"].counted_outcomes == 0
    assert not by_id["old"].unproven and by_id["old"].counted_outcomes == 20


def test_an_exploring_draw_is_reproducible_from_its_seed():
    cands = {"a": seasoned(3, 3, 300_000), "b": seasoned(3, 3, 300_000), "c": PRIOR}
    first = ranking(cands, explore=True, rng=random.Random(5))
    again = ranking(cands, explore=True, rng=random.Random(5))
    assert first == again


def test_an_exploring_draw_skips_an_agent_whose_drawn_cost_cannot_fit():
    # kappa 1, tau 1e12: the drawn cost is around a million times the budget, every time.
    hopeless = Posterior(alpha=5.0, beta=1.0, kappa=1.0, tau=1e12, n=10)
    for seed in range(20):
        got, left_out = ranking(
            {"h": hopeless, "ok": seasoned(5, 5, 300_000)}, explore=True, rng=random.Random(seed)
        )
        assert [p.agent_id for p in got] == ["ok"]
        assert left_out == {"h": OVER_BUDGET}


def test_exploring_still_favours_the_better_agent_most_of_the_time():
    good, poor = seasoned(18, 2, 300_000), seasoned(3, 17, 300_000)
    wins = sum(
        picks({"good": good, "poor": poor}, explore=True, rng=random.Random(seed))[0].agent_id == "good"
        for seed in range(300)
    )
    assert wins > 270  # an experienced, clearly better agent wins nearly every draw


def test_exploring_gives_an_uncertain_newcomer_some_of_the_draws():
    veteran, newcomer = seasoned(14, 6, 300_000), PRIOR  # newcomer's prior is wide: worth trying sometimes
    firsts = [
        picks({"vet": veteran, "new": newcomer}, explore=True, rng=random.Random(seed))[0].agent_id
        for seed in range(400)
    ]
    assert 0 < firsts.count("new") < 400


@pytest.mark.parametrize("explore", [False, True])
def test_every_pick_says_what_it_was_scored_on(explore: bool):
    p = picks({"a": seasoned(4, 1, 300_000)}, explore=explore, rng=random.Random(3))[0]
    assert p.score == pytest.approx(p.success / p.cost)
    assert 0.0 <= p.success <= 1.0 and p.cost > 0.0


# Budget feasibility.


def at(kappa: float, x: float, budget: float = 1_000_000, epsilon: float = 0.1) -> float:
    """``feasible_probability`` for a posterior whose ``tau / limit`` is ``x``."""
    tau = x * budget_limit(budget, epsilon)
    return feasible_probability(Posterior(1.0, 1.0, kappa, tau), budget, epsilon)


def q_integer(n: int, x: float) -> float:
    """Q(n, x) for a whole n: the chance a Poisson(x) count is below n."""
    return math.exp(-x) * sum(x**k / math.factorial(k) for k in range(n))


def q_half(n: int, x: float) -> float:
    """Q(n + 1/2, x): erfc(sqrt x) plus a finite sum, from Q(a + 1, x) = Q(a, x) + x^a e^-x / Gamma(a + 1)."""
    return math.erfc(math.sqrt(x)) + math.exp(-x) * sum(
        x ** (k + 0.5) / math.gamma(k + 1.5) for k in range(n)
    )


@pytest.mark.parametrize(
    ("kappa", "x", "expected"),
    [
        # kappa = 1, the cold prior: exp(-x), as the reference branch's docstring says. Both evaluation
        # branches (the series for x < kappa + 1, the continued fraction otherwise).
        (1.0, 0.5, math.exp(-0.5)),
        (1.0, 3.0, math.exp(-3.0)),
        # Whole kappa: a Poisson tail. Series, near the switch, and continued fraction.
        (4.0, 2.0, q_integer(4, 2.0)),
        (4.0, 4.9, q_integer(4, 4.9)),
        (4.0, 11.0, q_integer(4, 11.0)),
        (20.0, 20.0, q_integer(20, 20.0)),
        # Half-whole kappa: erfc plus a finite sum.
        (0.5, 0.2, q_half(0, 0.2)),
        (2.5, 0.7, q_half(2, 0.7)),
        (2.5, 9.0, q_half(2, 9.0)),
        # Neither: values from mpmath 1.3, gammainc(a, x, inf, regularized=True) at 40 digits.
        (7.3, 4.1, 0.90203619465415758655),
        (7.3, 12.6, 0.040957636455877532386),
        (0.4, 3.0, 0.010001123188919289088),
        (1.95, 0.95, 0.74047986432453140266),
    ],
)
def test_feasible_probability_matches_independent_computation(kappa: float, x: float, expected: float):
    assert at(kappa, x) == pytest.approx(expected, rel=1e-12, abs=1e-15)


@pytest.mark.parametrize(("budget", "epsilon"), [(1_000_000, 0.1), (250_000, 0.0), (40_000, 0.5)])
def test_feasible_probability_is_the_chance_one_draw_fits(budget: float, epsilon: float):
    """What the closed form claims, checked against the draw itself (``reputation_model.draw``)."""
    posterior = Posterior(1.0, 1.0, kappa=3.0, tau=2.4 * budget)
    rng = random.Random(11)
    limit = budget_limit(budget, epsilon)
    fits = sum(draw(posterior, rng)[1] <= limit for _ in range(40_000)) / 40_000
    assert fits == pytest.approx(feasible_probability(posterior, budget, epsilon), abs=0.01)


def test_feasible_probability_of_a_budget_of_nothing_is_zero():
    assert feasible_probability(PRIOR, 0, 0.1) == 0.0


def test_mean_feasible_is_the_mean_cost_within_the_limit():
    p = Posterior(1.0, 1.0, kappa=2.0, tau=2_200_000)  # mean cost 1.1M
    assert mean_feasible(p, 1_000_000, 0.1)
    assert not mean_feasible(p, 999_999, 0.1)
    assert budget_limit(1_000_000, 0.1) == pytest.approx(1_100_000)


@pytest.mark.parametrize("kappa", [1.0, 1.5, 1.95, 3.0, 7.3, 20.0, 400.0])
def test_mean_feasible_agent_is_never_below_min_feasible_probability(kappa: float):
    """If the mean cost fits, ``tau / limit <= kappa``, so the chance a draw fits is at least
    ``Q(kappa, kappa)``: 1/e at kappa 1, rising toward 1/2. Every posterior here has kappa >= 1 (the prior's
    is 1 and each observed cost moves it to 0.95 kappa + 1). The setting is capped well below that, so the
    explore-mode threshold can never leave out an agent greedy mode would suggest."""
    worst = Posterior(1.0, 1.0, kappa=kappa, tau=kappa * budget_limit(300_000, 0.1))  # mean exactly at limit
    assert mean_feasible(worst, 300_000, 0.1)
    p = feasible_probability(worst, 300_000, 0.1)
    assert p >= math.exp(-1) - 1e-12

    field = Settings.model_fields["routing_min_feasible_probability"]
    cap = next(m.le for m in field.metadata if isinstance(m, Le))
    assert p > cap == 0.25


def test_explore_skips_agent_below_threshold_even_if_draw_would_fit():
    """The threshold is applied to the agent up front, never to one draw: an agent whose chance of fitting is
    below it is left out of every draw, including those where its own draw would have fit."""
    budget = 1_000_000
    limit = budget_limit(budget, 0.1)
    unlikely = Posterior(5.0, 1.0, kappa=1.0, tau=limit * math.log(1 / 0.005), n=12)  # fits 0.5% of draws
    assert feasible_probability(unlikely, budget, 0.1) == pytest.approx(0.005)

    # Seeds where its own draw (the first one taken from the generator) would fit the budget.
    lucky = [s for s in range(5_000) if draw(unlikely, random.Random(s))[1] <= limit]
    assert lucky, "no draw of a 0.5% posterior fit in 5000 tries"
    for seed in [*lucky, *range(200)]:
        got, left_out = ranking({"u": unlikely}, budget, explore=True, rng=random.Random(seed))
        assert got == [] and left_out == {"u": OVER_BUDGET}

    # The threshold is what does it: below the agent's own chance, the lucky draws pick it.
    for seed in lucky:
        got, _ = ranking(
            {"u": unlikely}, budget, explore=True, min_feasible_probability=0.001, rng=random.Random(seed)
        )
        assert [p.agent_id for p in got] == ["u"]


def test_an_agent_left_out_up_front_takes_no_draw():
    """Leaving an agent out before the draw means it consumes nothing from the generator, so the others'
    draws are the ones they would have had without it."""
    budget = 1_000_000
    unlikely = Posterior(5.0, 1.0, kappa=1.0, tau=budget_limit(budget, 0.1) * 10, n=12)  # e^-10
    ok = seasoned(5, 5, 300_000)
    for seed in range(20):
        with_it, _ = ranking({"a": unlikely, "b": ok}, budget, explore=True, rng=random.Random(seed))
        without, _ = ranking({"b": ok}, budget, explore=True, rng=random.Random(seed))
        assert with_it == without


def test_a_draw_over_budget_is_reported_as_this_draw_only():
    """An agent above the threshold whose draw happens not to fit is out of this draw, not of the task."""
    budget = 1_000_000
    coin = Posterior(5.0, 1.0, kappa=1.0, tau=budget_limit(budget, 0.1) * math.log(2), n=12)  # fits half
    left_out = [ranking({"c": coin}, budget, explore=True, rng=random.Random(s))[1] for s in range(60)]
    reasons = {r.get("c") for r in left_out}
    assert reasons == {None, OVER_BUDGET_IN_THIS_DRAW}


@pytest.mark.parametrize("explore", [False, True])
def test_every_candidate_is_ranked_or_left_out_with_a_reason(explore: bool):
    budget = 400_000
    cands = {
        "new": PRIOR,  # mean 500k: over in greedy, a ~33% draw in explore
        "cheap": seasoned(5, 5, 100_000),
        "dear": seasoned(9, 1, 2_000_000),
        "hopeless": Posterior(1.0, 1.0, kappa=1.0, tau=1e12, n=3),
        "edge": seasoned(10, 0, 430_000),
    }
    for seed in range(50):
        got, left_out = ranking(cands, budget, explore=explore, rng=random.Random(seed))
        ids = [p.agent_id for p in got]
        assert len(ids) == len(set(ids))
        assert set(ids).isdisjoint(left_out)
        assert set(ids) | set(left_out) == set(cands)
        assert set(left_out.values()) <= {OVER_BUDGET, OVER_BUDGET_IN_THIS_DRAW}
        if not explore:
            assert OVER_BUDGET_IN_THIS_DRAW not in left_out.values()
