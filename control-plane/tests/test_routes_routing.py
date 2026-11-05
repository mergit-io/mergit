"""``GET /v0/plans/{uuid}/suggestions``: advice for a draft plan's owner only, greedy by default, a
recorded and replayable draw when exploring, and never shaped by free-credit work.
Run with `pytest -m postgres`.
"""

# ruff: noqa: F811
# (the imported fixtures are used by name, so their parameters look like redefinitions)
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import psycopg
import pytest
import respx
from fastapi.testclient import TestClient

from mergit_cp import routes_routing
from mergit_cp.agents import Agent
from mergit_cp.app import create_app
from mergit_cp.arkiv_mirror import ArkivMirror
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.eligibility import AT_CAP, IN_PROBATION
from mergit_cp.reputation import record_missing_costs, refresh_posteriors
from mergit_cp.reputation_model import Params, Posterior
from mergit_cp.routes_routing import (
    ALL_LEFT_OUT,
    NO_FIT,
    NO_FIT_ON_PRIOR_ALONE,
    NO_FIT_THIS_DRAW,
    PARTLY_LEFT_OUT,
)
from mergit_cp.routing import (
    BELOW_MAX_ATTEMPTS,
    OVER_BUDGET,
    OVER_BUDGET_IN_THIS_DRAW,
    feasible_probability,
    mean_feasible,
    rank,
)
from tests.cp_fakes import FakeLLM
from tests.test_api import seed_plan
from tests.test_eligibility import dispatch, invalid_verdict
from tests.test_plans import app_client, create, llm, settings, sign_in  # noqa: F401  (fixtures)
from tests.test_reputation import gateway, run
from tests.test_reputation_outcomes import verdict

pytestmark = pytest.mark.postgres


@pytest.fixture(autouse=True)
def _no_history(database_url: str) -> None:
    """The posteriors are global and the database is shared, so outcomes other tests left behind would
    otherwise already be in them. ``run`` migrates before it empties the tables, like every other ledger
    test, so this file also passes when it is the first (or only) one to touch a fresh database."""

    async def nothing(_: Pool) -> None:
        return None

    run(database_url, nothing)


def decisions(settings: Settings, plan_uuid: str) -> list[tuple[int, int, list[dict[str, float | str]]]]:
    with psycopg.connect(settings.database_url) as conn:
        rows = conn.execute(
            "SELECT task_index, seed, candidates FROM routing_decisions"
            " WHERE plan_uuid = %s ORDER BY task_index",
            (plan_uuid,),
        ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def test_the_owner_gets_greedy_suggestions_for_every_task(app_client: TestClient, settings: Settings):
    sign_in(app_client)
    plan = create(app_client)
    got = app_client.get(f"/v0/plans/{plan['plan_uuid']}/suggestions")
    assert got.status_code == 200, got.text
    body = got.json()
    assert (body["mode"], body["seed"]) == ("greedy", None)
    assert "not an assignment" in body["note"]
    assert [t["index"] for t in body["tasks"]] == [0, 1]
    for task in body["tasks"]:
        assert {p["agent_id"] for p in task["picks"]} == {"1", "2"}
        assert all(p["unproven"] and p["counted_outcomes"] == 0 for p in task["picks"])
    assert (
        decisions(settings, plan["plan_uuid"]) == []
    )  # a greedy answer is deterministic, so nothing to replay


def test_only_the_requester_may_ask_and_only_for_a_draft(app_client: TestClient, settings: Settings):
    sign_in(app_client)
    plan = create(app_client)
    url = f"/v0/plans/{plan['plan_uuid']}/suggestions"
    assert app_client.get("/v0/plans/00000000-0000-0000-0000-000000000000/suggestions").status_code == 404
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("UPDATE plans SET state = 'closed' WHERE plan_uuid = %s", (plan["plan_uuid"],))
    assert app_client.get(url).status_code == 409
    app_client.cookies.clear()
    sign_in(app_client)  # someone else
    assert app_client.get(url).status_code == 403


def test_an_exploring_answer_is_recorded_and_can_be_replayed(app_client: TestClient, settings: Settings):
    sign_in(app_client)
    plan = create(app_client)
    got = app_client.get(f"/v0/plans/{plan['plan_uuid']}/suggestions", params={"explore": "true"}).json()
    assert got["mode"] == "explore" and isinstance(got["seed"], int)

    logged = decisions(settings, plan["plan_uuid"])
    assert [(i, seed) for i, seed, _ in logged] == [(0, got["seed"]), (1, got["seed"])]
    for index, seed, snapshot in logged:
        candidates = {
            c["agent_id"]: Posterior(c["alpha"], c["beta"], c["kappa"], c["tau"], c["n"]) for c in snapshot
        }  # type: ignore[arg-type]
        replay, _ = rank(
            candidates,
            500_000.0,
            explore=True,
            epsilon=settings.routing_epsilon,
            min_observations=settings.routing_min_observations,
            min_feasible_probability=settings.routing_min_feasible_probability,
            rng=random.Random(f"{seed}/{index}"),
        )
        picked = [p.agent_id for p in replay[: settings.max_attempts]]
        assert picked == [p["agent_id"] for p in got["tasks"][index]["picks"]]


def test_a_draft_with_a_recorded_draw_can_still_be_discarded_and_the_draw_outlives_it(
    app_client: TestClient, settings: Settings
):
    """A draw is the first thing that can point at a still-draft plan, and discarding a draft really deletes
    it. The replay record is an audit log, so it stays, and it must not block the discard (migration 0022)."""
    sign_in(app_client)
    plan = create(app_client)
    url = f"/v0/plans/{plan['plan_uuid']}"
    drawn = app_client.get(f"{url}/suggestions", params={"explore": "true"})
    assert drawn.status_code == 200, drawn.text
    assert len(decisions(settings, plan["plan_uuid"])) == 2

    assert app_client.delete(url).status_code == 204
    assert app_client.get(url).status_code == 404
    logged = decisions(settings, plan["plan_uuid"])
    assert [(i, seed) for i, seed, _ in logged] == [(0, drawn.json()["seed"]), (1, drawn.json()["seed"])]
    # Outliving the plan does not make the record editable: the append-only trigger still holds.
    with psycopg.connect(settings.database_url) as conn:
        for sql in (
            "DELETE FROM routing_decisions WHERE plan_uuid = %s",
            "UPDATE routing_decisions SET seed = 0 WHERE plan_uuid = %s",
        ):
            with pytest.raises(psycopg.errors.RaiseException, match="append-only"), conn.transaction():
                conn.execute(sql, (plan["plan_uuid"],))
    assert decisions(settings, plan["plan_uuid"]) == logged


def test_free_credit_work_does_not_change_a_suggestion(
    app_client: TestClient, settings: Settings, database_url: str
):
    async def body(pool: Pool) -> None:
        plan_uuid, _, tasks = await seed_plan(pool, requester="0x" + "3" * 40)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (plan_uuid,))
        await verdict(pool, settings, tasks[0], "fail", "1")
        await verdict(pool, settings, tasks[1], "fail", "2")
        await record_missing_costs(pool, gateway({t: "100000" for t in tasks}))
        await refresh_posteriors(pool, settings)

    run(database_url, body)  # leaves two counted-looking failures for agent 1, funded from credits
    sign_in(app_client)
    plan = create(app_client)
    picks = app_client.get(f"/v0/plans/{plan['plan_uuid']}/suggestions").json()["tasks"][0]["picks"]
    assert {p["agent_id"]: p["counted_outcomes"] for p in picks} == {"1": 0, "2": 0}


def test_validated_history_moves_the_ranking(app_client: TestClient, settings: Settings, database_url: str):
    async def body(pool: Pool) -> None:
        _, _, tasks = await seed_plan(pool, requester="0x" + "4" * 40, n_tasks=2)
        for t, task in enumerate(tasks):  # agent 1 fails, validated, twice, at a fair price
            await verdict(pool, settings, task, "fail", str(t + 1))
        await record_missing_costs(pool, gateway({t: "200000" for t in tasks}))
        await refresh_posteriors(pool, settings)

    run(database_url, body)
    sign_in(app_client)
    plan = create(app_client)
    picks = app_client.get(f"/v0/plans/{plan['plan_uuid']}/suggestions").json()["tasks"][0]["picks"]
    assert [p["agent_id"] for p in picks] == ["2", "1"]  # the untried agent's prior beats a failing record
    assert {p["agent_id"]: p["counted_outcomes"] for p in picks} == {"1": 2, "2": 0}


def test_exploring_suggestions_are_rate_limited_per_requester(settings: Settings, llm: FakeLLM) -> None:
    """Each exploring call appends a replay record per task to the append-only routing_decisions, so it is
    limited per requester like the planner (plans_per_hour). A greedy call writes nothing and is not."""
    limited = settings.model_copy(update={"suggestions_per_hour": 2})
    with TestClient(create_app(limited, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        sign_in(c)
        plan = create(c)
        url = f"/v0/plans/{plan['plan_uuid']}/suggestions"
        for _ in range(2):
            assert c.get(url, params={"explore": "true"}).status_code == 200
        refused = c.get(url, params={"explore": "true"})
        assert refused.status_code == 429, refused.text
        assert len(decisions(settings, plan["plan_uuid"])) == 2 * 2  # two calls x two tasks; not the third
        assert c.get(url).status_code == 200  # greedy is still answered

        c.cookies.clear()
        sign_in(c)  # someone else has their own allowance
        other = create(c)
        theirs = f"/v0/plans/{other['plan_uuid']}/suggestions"
        assert c.get(theirs, params={"explore": "true"}).status_code == 200


# Why each agent is left out: every roster agent is in a task's picks or in its ineligible list, once.

OPERATORS = {str(i): "0x" + c * 40 for i, c in zip(range(1, 6), "abcde", strict=True)}
PRICEY = Posterior(8.0, 3.0, 10.0, 20_000_000.0, 10)  # mean cost 2M against a 500k task, on evidence
EXCELLENT = Posterior(18.0, 2.0, 15.0, 3_000_000.0, 20)  # mean cost 200k, passes nine in ten
PICK_FIELDS = {
    "agent_id",
    "name",
    "score_per_usdc",
    "assumed_success",
    "assumed_cost_micros",
    "counted_outcomes",
    "unproven",
    "cost_is_prior",
}


def roster_agent(agent_id: str) -> Agent:
    return Agent(
        agent_id=agent_id,
        name=f"agent-{agent_id}",
        operator=OPERATORS[agent_id],
        runtime_key="0x" + "2" * 40,
        provider="anthropic",
        model="m",
        system_prompt="p",
    )


@pytest.fixture
def roster(settings: Settings, tmp_path: Path) -> Settings:
    """Five agents, each with its own operator, so probation or the cap on one leaves the others alone."""
    chain = tmp_path / "five-agents.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {"agent_id": i, "name": f"agent-{i}", "operator": op, "runtime_key": "0x" + "2" * 40}
                    for i, op in OPERATORS.items()
                ]
            }
        )
    )
    config = tmp_path / "five-agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        + "".join(
            f'[agents.agent-{i}]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n'
            for i in OPERATORS
        )
    )
    return settings.model_copy(update={"agents_file": str(chain), "agents_config": str(config)})


@contextmanager
def suggesting(settings: Settings, llm: FakeLLM, **update: Any) -> Iterator[TestClient]:
    """A signed-in requester. The reputation updater is off, since these tests write ``agent_posteriors``
    directly and a refresh would rebuild it from the (empty) ledger."""
    app = create_app(
        settings.model_copy(update=update),
        llm=llm,
        deliver_events=False,
        process_outcomes=False,
        update_reputation=False,
    )
    with TestClient(app, base_url="https://testserver") as c:
        sign_in(c)
        yield c
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "TRUNCATE plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces CASCADE"
        )


def history(
    database_url: str,
    *,
    posteriors: dict[str, Posterior] | None = None,
    probation: tuple[str, ...] = (),
    in_flight: tuple[str, ...] = (),
) -> None:
    """Posteriors in the plan's category; a falsification an hour ago for each agent in ``probation``; one
    running dispatch for each agent in ``in_flight`` (at cap when ``routing_operator_concurrency_cap`` is
    1)."""

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn:
            for agent_id, p in (posteriors or {}).items():
                await conn.execute(
                    "INSERT INTO agent_posteriors (agent_id, category, alpha, beta, kappa, tau, n)"
                    " VALUES (%s, 'test-repair', %s, %s, %s, %s, %s)",
                    (agent_id, p.alpha, p.beta, p.kappa, p.tau, p.n),
                )
        now = datetime.now(UTC)
        for agent_id in probation:
            plan_uuid, task_id = await dispatch(pool, roster_agent(agent_id), at=now - timedelta(days=1))
            await invalid_verdict(pool, plan_uuid, task_id, now - timedelta(hours=1))
        for agent_id in in_flight:
            await dispatch(pool, roster_agent(agent_id), at=now)

    run(database_url, body)


def suggest(c: TestClient, explore: bool = False) -> dict[str, Any]:
    plan = create(c)
    got = c.get(f"/v0/plans/{plan['plan_uuid']}/suggestions", params={"explore": str(explore).lower()})
    assert got.status_code == 200, got.text
    return got.json()


def why(task: dict[str, Any]) -> dict[str, str]:
    return {e["agent_id"]: e["reason"] for e in task["ineligible"]}


def picked(task: dict[str, Any]) -> list[str]:
    return [p["agent_id"] for p in task["picks"]]


def test_greedy_lists_over_budget_agents_with_reason(roster: Settings, llm: FakeLLM, database_url: str):
    history(database_url, posteriors={"1": PRICEY})
    with suggesting(roster, llm) as c:
        body = suggest(c)
    for task in body["tasks"]:
        assert "1" not in picked(task)
        assert {"agent_id": "1", "name": "agent-1", "reason": OVER_BUDGET} in task["ineligible"]


def test_probation_or_cap_reason_wins_over_over_budget(roster: Settings, llm: FakeLLM, database_url: str):
    """1 and 2 would be over budget anyway, but probation and the cap are the more fundamental reasons. 3 is
    the best agent on the roster by its record, and probation still keeps it out of the ranking."""
    history(
        database_url,
        posteriors={"1": PRICEY, "2": PRICEY, "3": EXCELLENT},
        probation=("1", "3"),
        in_flight=("2",),
    )
    with suggesting(roster, llm, routing_operator_concurrency_cap=1) as c:
        greedy, explored = suggest(c), suggest(c, explore=True)
    for task in greedy["tasks"]:
        assert picked(task) == ["4", "5"]
        assert why(task) == {"1": IN_PROBATION, "2": AT_CAP, "3": IN_PROBATION}
    for task in explored["tasks"]:
        assert set(picked(task)) <= {"4", "5"}
        assert {a: r for a, r in why(task).items() if a in "123"} == {
            "1": IN_PROBATION,
            "2": AT_CAP,
            "3": IN_PROBATION,
        }


def test_max_attempts_cut_agents_are_listed(roster: Settings, llm: FakeLLM):
    with suggesting(roster, llm) as c:
        body = suggest(c)
    for task in body["tasks"]:  # five equal priors, ties by agent id
        assert picked(task) == ["1", "2", "3"]
        assert task["ineligible"] == [
            {"agent_id": "4", "name": "agent-4", "reason": BELOW_MAX_ATTEMPTS},
            {"agent_id": "5", "name": "agent-5", "reason": BELOW_MAX_ATTEMPTS},
        ]


def test_every_roster_agent_is_in_picks_or_ineligible(roster: Settings, llm: FakeLLM, database_url: str):
    history(database_url, posteriors={"1": PRICEY, "3": EXCELLENT}, probation=("2",))
    reasons = {IN_PROBATION, AT_CAP, OVER_BUDGET, OVER_BUDGET_IN_THIS_DRAW, BELOW_MAX_ATTEMPTS}
    with suggesting(roster, llm) as c:
        bodies = [suggest(c)] + [suggest(c, explore=True) for _ in range(6)]
    for body in bodies:
        for task in body["tasks"]:
            ids = picked(task) + [e["agent_id"] for e in task["ineligible"]]
            assert sorted(ids) == sorted(OPERATORS)  # each exactly once
            assert set(why(task).values()) <= reasons
            assert {e["name"] for e in task["ineligible"]} == {f"agent-{a}" for a in why(task)}
            assert why(task)["2"] == IN_PROBATION and why(task)["1"] == OVER_BUDGET


@pytest.mark.parametrize("explore", [False, True])
def test_existing_response_fields_unchanged(roster: Settings, llm: FakeLLM, explore: bool):
    with suggesting(roster, llm) as c:
        body = suggest(c, explore=explore)
    assert set(body) == {"plan_id", "mode", "seed", "note", "tasks"}
    assert isinstance(body["plan_id"], str) and body["mode"] == ("explore" if explore else "greedy")
    assert isinstance(body["seed"], int) if explore else body["seed"] is None
    assert "not an assignment" in body["note"]
    assert [t["index"] for t in body["tasks"]] == [0, 1]
    for task in body["tasks"]:
        # "ineligible" is the one new field; "reason" is there exactly when "picks" is empty, as before.
        reason = set() if task["picks"] else {"reason"}
        assert set(task) == {"index", "budget_usdc_units", "picks", "ineligible"} | reason
        assert task["budget_usdc_units"] == "500000"
        for pick in task["picks"]:
            assert set(pick) == PICK_FIELDS
            assert isinstance(pick["agent_id"], str) and pick["name"] == f"agent-{pick['agent_id']}"
            assert all(isinstance(pick[k], float) for k in ("score_per_usdc", "assumed_success"))
            assert isinstance(pick["assumed_cost_micros"], float)
            assert (pick["counted_outcomes"], pick["unproven"], pick["cost_is_prior"]) == (0, True, True)
        if not explore:  # the prior's own means, exactly as before (plus the additive "cost_is_prior")
            assert task["picks"][0] == {
                "agent_id": "1",
                "name": "agent-1",
                "score_per_usdc": 1.0,
                "assumed_success": 0.5,
                "assumed_cost_micros": 500_000.0,
                "counted_outcomes": 0,
                "unproven": True,
                "cost_is_prior": True,
            }


@pytest.mark.parametrize("explore", [False, True])
def test_a_pick_says_when_its_cost_is_only_the_prior(
    roster: Settings, llm: FakeLLM, database_url: str, explore: bool
):
    """Agent 1 has counted outcomes, but every one metered 0, so its cost is still the configured prior
    (``Posterior.observe``) and a client must not show it as measured. Agent 2 has recorded costs. Agents
    3-5 have no history at all."""
    prior = Posterior.prior(Params(tau0=float(roster.reputation_cost_prior_micros)))
    no_cost = prior.observe(True, None).observe(True, None).observe(False, None)
    assert no_cost.n == 3
    history(database_url, posteriors={"1": no_cost, "2": EXCELLENT})
    with suggesting(roster, llm) as c:
        body = suggest(c, explore=explore)
    for task in body["tasks"]:
        for pick in task["picks"]:
            assert pick["cost_is_prior"] is (pick["agent_id"] != "2"), pick
        if not explore:
            by_id = {p["agent_id"]: p for p in task["picks"]}
            assert by_id["1"]["counted_outcomes"] == 3 and by_id["1"]["cost_is_prior"] is True
            assert by_id["2"]["cost_is_prior"] is False


@pytest.mark.parametrize("explore", [False, True])
def test_an_empty_answer_says_when_it_rests_on_the_prior_alone(
    roster: Settings, llm: FakeLLM, database_url: str, explore: bool
):
    """No agent has a recorded cost, and the configured prior's mean (5M) is ten times the task's budget:
    the answer is still empty, but it says the expectation is an assumption, not what anyone was seen to do.
    One agent in probation does not change that, but the answer says it is out for another reason too."""
    history(database_url, probation=("1",))
    with suggesting(roster, llm, reputation_cost_prior_micros=5_000_000) as c:
        body = suggest(c, explore=explore)
    for task in body["tasks"]:
        assert task["picks"] == []
        assert why(task) == {"1": IN_PROBATION} | {a: OVER_BUDGET for a in "2345"}
        assert task["reason"] == PARTLY_LEFT_OUT + NO_FIT_ON_PRIOR_ALONE
        assert "not evidence" in task["reason"] and "starting" in task["reason"]


def test_an_empty_answer_backed_by_evidence_says_so_plainly(
    roster: Settings, llm: FakeLLM, database_url: str
):
    history(database_url, posteriors=dict.fromkeys(OPERATORS, PRICEY))
    with suggesting(roster, llm) as c:
        body = suggest(c)
    for task in body["tasks"]:
        assert task["picks"] == [] and set(why(task).values()) == {OVER_BUDGET}
        assert task["reason"] == NO_FIT


def test_an_agent_with_outcomes_but_no_recorded_cost_still_rests_on_the_prior(
    roster: Settings, llm: FakeLLM, database_url: str
):
    """Outcomes whose receipts metered 0 count toward success but leave the cost posterior at the prior
    (``Posterior.observe``), so a budget call on it is still only the assumption."""
    prior = Posterior(1.0, 1.0, 1.0, 5_000_000.0)
    no_cost = prior.observe(True, None).observe(False, None).observe(True, None)
    history(database_url, posteriors=dict.fromkeys(OPERATORS, no_cost))
    with suggesting(roster, llm, reputation_cost_prior_micros=5_000_000) as c:
        body = suggest(c)
    for task in body["tasks"]:
        assert task["picks"] == [] and task["reason"] == NO_FIT_ON_PRIOR_ALONE


def test_an_empty_answer_when_every_agent_is_left_out_for_now(
    roster: Settings, llm: FakeLLM, database_url: str
):
    history(database_url, probation=tuple(OPERATORS))
    with suggesting(roster, llm) as c:
        body = suggest(c)
    for task in body["tasks"]:
        assert task["picks"] == [] and set(why(task).values()) == {IN_PROBATION}
        assert task["reason"] == ALL_LEFT_OUT


# Explore: an empty answer because every draw missed is not "no agent is expected to fit".


def unlucky_seed(settings: Settings, candidates: dict[str, Posterior], reasons: set[str]) -> int:
    """The first seed whose draw for task 0 (as the route seeds it) ranks nobody and leaves the candidates out
    for exactly ``reasons``. Found by search over the same pure ``rank`` the route calls, so it is fixed."""
    for seed in range(10_000):
        ranked, left_out = rank(
            candidates,
            500_000.0,
            explore=True,
            epsilon=settings.routing_epsilon,
            min_observations=settings.routing_min_observations,
            min_feasible_probability=settings.routing_min_feasible_probability,
            rng=random.Random(f"{seed}/0"),
        )
        if not ranked and set(left_out.values()) == reasons:
            return seed
    raise AssertionError(f"no seed in 10000 gives {reasons}")


def seeded(monkeypatch: pytest.MonkeyPatch, seed: int) -> None:
    """Make the route's exploring seed ``seed`` instead of a random one."""
    monkeypatch.setattr(routes_routing, "secrets", SimpleNamespace(randbits=lambda _bits: seed))


def test_an_explore_answer_where_every_draw_missed_does_not_claim_no_agent_fits(
    roster: Settings, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch
):
    """Cold start: five agents on the prior (mean 500k) for a 500k task. Each one fits (greedy suggests
    them) and each draw fits about 40% of the time, so all five missing at once happens on about 7% of
    exploring calls. That is one unlucky draw, not evidence, and the answer must not say otherwise."""
    prior = Posterior.prior(Params(tau0=float(roster.reputation_cost_prior_micros)))
    eps, floor = roster.routing_epsilon, roster.routing_min_feasible_probability
    assert mean_feasible(prior, 500_000, eps) and feasible_probability(prior, 500_000, eps) > 0.4 > floor
    seed = unlucky_seed(roster, dict.fromkeys(OPERATORS, prior), {OVER_BUDGET_IN_THIS_DRAW})
    seeded(monkeypatch, seed)
    with suggesting(roster, llm) as c:
        explored, greedy = suggest(c, explore=True), suggest(c)
    task = explored["tasks"][0]
    assert explored["seed"] == seed and task["picks"] == []
    assert set(why(task).values()) == {OVER_BUDGET_IN_THIS_DRAW}
    assert task["reason"] == NO_FIT_THIS_DRAW
    assert "expected to fit" not in task["reason"] and "raise the budget" not in task["reason"]
    assert picked(greedy["tasks"][0]) == ["1", "2", "3"]  # the same posteriors, ranked greedily


def test_an_explore_answer_with_some_over_budget_and_the_rest_unlucky_says_it_was_the_draw(
    roster: Settings, llm: FakeLLM, database_url: str, monkeypatch: pytest.MonkeyPatch
):
    """Agent 1 is over budget on evidence; the other four could fit and only missed this draw. "No agent is
    expected to fit" is true of agent 1 only, so it is not what the answer says."""
    history(database_url, posteriors={"1": PRICEY})
    prior = Posterior.prior(Params(tau0=float(roster.reputation_cost_prior_micros)))
    candidates = dict.fromkeys(OPERATORS, prior) | {"1": PRICEY}
    seed = unlucky_seed(roster, candidates, {OVER_BUDGET, OVER_BUDGET_IN_THIS_DRAW})
    seeded(monkeypatch, seed)
    with suggesting(roster, llm) as c:
        task = suggest(c, explore=True)["tasks"][0]
    assert task["picks"] == []
    assert why(task) == {"1": OVER_BUDGET} | dict.fromkeys("2345", OVER_BUDGET_IN_THIS_DRAW)
    assert task["reason"] == NO_FIT_THIS_DRAW


def test_an_empty_answer_with_agents_out_for_probation_does_not_blame_the_budget_alone(
    roster: Settings, llm: FakeLLM, database_url: str
):
    """Agent 3 would fit easily; it is out for probation. The rest are over budget on evidence. The answer
    says the budget rules out only the others."""
    history(
        database_url,
        posteriors=dict.fromkeys(OPERATORS, PRICEY) | {"3": EXCELLENT},
        probation=("3",),
    )
    with suggesting(roster, llm) as c:
        body = suggest(c)
    for task in body["tasks"]:
        assert task["picks"] == []
        assert why(task) == {"3": IN_PROBATION} | dict.fromkeys("1245", OVER_BUDGET)
        assert task["reason"] == PARTLY_LEFT_OUT + NO_FIT
        assert task["reason"].startswith("some agents are left out for probation or the operator cap")


# -- Arkiv mirror (ETHGlobal Mumbai "Build on Arkiv" track): routing_decisions also written to Arkiv
# (one batched call to the sidecar, chain/arkiv/), and readable back through its own endpoint. Both the
# sidecar and the Rabdi RPC are mocked at the HTTP layer (`respx`), never a real network or process. --

ARKIV_RPC = "https://rpc.example"
ARKIV_SIDECAR = "https://sidecar.example"
ARKIV_OWNER = "0x1111111111111111111111111111111111111111"


def _fake_entity(decision: dict[str, Any]) -> dict[str, Any]:
    """An entity shaped like a real `arkiv_query` match, encoding one decision the sidecar "wrote"
    (`_entity` in `test_arkiv_mirror.py` is the unit-level version of this)."""
    encoded_body = "0x" + json.dumps(
        {"candidates": decision["candidates"], "picks": decision["picks"]}
    ).encode().hex()
    return {
        "key": f"0xe{decision['task_index']}",
        "attributes": [
            {"name": "taskIndex", "type": "i32", "value": decision["task_index"]},
            {"name": "category", "type": "str", "value": decision["category"]},
            {"name": "decidedAt", "type": "str", "value": decision["decided_at"]},
            {"name": "body", "type": "bytes", "value": encoded_body},
        ],
    }


@contextmanager
def arkiv_client(settings: Settings, llm: FakeLLM) -> Iterator[tuple[TestClient, respx.MockRouter]]:
    arkiv = ArkivMirror(ARKIV_RPC, None, ARKIV_OWNER, ARKIV_SIDECAR, "sidecar-secret", 30)
    with (
        respx.mock(assert_all_called=False) as mock,
        TestClient(
            create_app(settings, llm=llm, deliver_events=False, arkiv=arkiv),
            base_url="https://testserver",
        ) as c,
    ):
        mock.post(f"{ARKIV_SIDECAR}/internal/mirror").respond(
            json={"tx_hash": "0xdead", "entity_keys": []}
        )
        yield c, mock


def test_an_exploring_suggestion_is_mirrored_to_arkiv_and_readable_back(settings: Settings, llm: FakeLLM):
    with arkiv_client(settings, llm) as (c, mock):
        sign_in(c)
        plan = create(c)
        write_route = mock.routes[-1]  # the default write mock registered by arkiv_client
        got = c.get(f"/v0/plans/{plan['plan_uuid']}/suggestions", params={"explore": "true"}).json()

        # One write call, carrying every task's decision — never one call per task.
        assert write_route.call_count == 1
        sent = json.loads(write_route.calls[0].request.content)
        assert len(sent["decisions"]) == len(got["tasks"]) == 2
        assert all(d["plan_id"] == plan["plan_id"] for d in sent["decisions"])

        # The read endpoint decodes what was (supposedly) written on Arkiv, not a copy kept in Postgres.
        entities = [_fake_entity(d) for d in sent["decisions"]]
        mock.post(ARKIV_RPC).respond(json={"jsonrpc": "2.0", "id": 1, "result": {"data": entities}})
        mirrored = c.get(f"/v0/plans/{plan['plan_uuid']}/arkiv-suggestions").json()
        assert mirrored["enabled"] is True
        assert {d["task_index"] for d in mirrored["decisions"]} == {0, 1}


def test_arkiv_suggestions_degrades_instead_of_500_when_arkiv_is_unreachable(
    settings: Settings, llm: FakeLLM
):
    """A bad key or a down RPC must not 500 the page for an unrelated feature; the owner still sees
    their plan, just told Arkiv could not be reached."""
    with arkiv_client(settings, llm) as (c, mock):
        sign_in(c)
        plan = create(c)
        c.get(f"/v0/plans/{plan['plan_uuid']}/suggestions", params={"explore": "true"})

        mock.post(ARKIV_RPC).mock(side_effect=httpx.ConnectError("rpc unreachable"))
        resp = c.get(f"/v0/plans/{plan['plan_uuid']}/arkiv-suggestions")

        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled"] is True
        assert body["decisions"] == []
        assert body["error"] == "could not reach Arkiv"


def test_arkiv_suggestions_is_owner_only(settings: Settings, llm: FakeLLM):
    with arkiv_client(settings, llm) as (c, _mock):
        sign_in(c)
        plan = create(c)
        c.get(f"/v0/plans/{plan['plan_uuid']}/suggestions", params={"explore": "true"})
        c.post("/v0/auth/logout")
        sign_in(c)  # a different, freshly generated account
        resp = c.get(f"/v0/plans/{plan['plan_uuid']}/arkiv-suggestions")
        assert resp.status_code == 403


def test_arkiv_suggestions_is_disabled_when_arkiv_is_not_configured(app_client: TestClient):
    sign_in(app_client)
    plan = create(app_client)
    got = app_client.get(f"/v0/plans/{plan['plan_uuid']}/arkiv-suggestions").json()
    assert got == {"enabled": False, "decisions": []}
