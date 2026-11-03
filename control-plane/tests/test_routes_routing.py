"""``GET /v0/plans/{uuid}/suggestions``: advice for a draft plan's owner only, greedy by default, a
recorded and replayable draw when exploring, and never shaped by free-credit work.
Run with `pytest -m postgres`.
"""

# ruff: noqa: F811
# (the imported fixtures are used by name, so their parameters look like redefinitions)
from __future__ import annotations

import random

import psycopg
import pytest
from fastapi.testclient import TestClient

from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.reputation import record_missing_costs, refresh_posteriors
from mergit_cp.reputation_model import Posterior
from mergit_cp.routing import rank
from tests.test_api import seed_plan
from tests.test_plans import app_client, create, llm, settings, sign_in  # noqa: F401  (fixtures)
from tests.test_reputation import gateway, run
from tests.test_reputation_outcomes import verdict

pytestmark = pytest.mark.postgres


@pytest.fixture(autouse=True)
def _no_history(database_url: str) -> None:
    """The posteriors are global and the database is shared, so outcomes other tests left behind would
    otherwise already be in them."""
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE plans, agent_posteriors, task_costs CASCADE")


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
        replay = rank(
            candidates,
            500_000.0,
            explore=True,
            epsilon=settings.routing_epsilon,
            min_observations=settings.routing_min_observations,
            rng=random.Random(f"{seed}/{index}"),
        )[: settings.max_attempts]
        assert [p.agent_id for p in replay] == [p["agent_id"] for p in got["tasks"][index]["picks"]]


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
