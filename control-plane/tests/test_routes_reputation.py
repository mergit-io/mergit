"""``GET /v0/agents/reputation``: figures derived from counted outcomes, the prior labelled as a prior, and
free-credit work reported but never counted. Run with `pytest -m postgres`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from mergit_cp.reputation import record_missing_costs, refresh_posteriors
from mergit_cp.reputation_model import Params, Posterior
from tests.test_api import seed_plan
from tests.test_reputation import REQUESTER, gateway, run
from tests.test_reputation_outcomes import released, verdict

pytestmark = pytest.mark.postgres


def client(settings: Settings) -> TestClient:
    return TestClient(
        create_app(settings, deliver_events=False, process_outcomes=False, update_reputation=False)
    )


def test_with_nothing_counted_the_list_is_empty_and_says_what_the_figures_are(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        return None

    run(database_url, body)
    with client(settings) as c:
        got = c.get("/v0/agents/reputation").json()
    assert got["agents"] == []
    assert "not a measurement" in got["note"]


def test_a_newcomer_shows_its_prior_labelled_as_one(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        return None

    run(database_url, body)
    with client(settings) as c:
        got = c.get("/v0/agents/reputation", params={"category": "test-repair"}).json()["agents"]
    assert [(r["agent_id"], r["counted_outcomes"], r["success_mean"]) for r in got] == [("1", 0, 0.5)]
    assert got[0]["basis"].startswith("prior")
    assert got[0]["effective_sample_size"] == 2.0


def test_counted_outcomes_show_their_figures_and_credit_work_is_only_reported(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        _, _, paid = await seed_plan(pool, requester=REQUESTER)
        await verdict(pool, settings, paid[0], "pass", "1")
        await released(pool, settings, paid[0], "2")
        free_plan, _, free = await seed_plan(pool, requester="0x" + "2" * 40)
        async with pool.connection() as conn:
            await conn.execute("UPDATE plans SET funding = 'credits' WHERE plan_uuid = %s", (free_plan,))
        await verdict(pool, settings, free[0], "fail", "3")
        await record_missing_costs(pool, gateway({paid[0]: "400000", free[0]: "1"}))
        await refresh_posteriors(pool, settings)

    run(database_url, body)
    with client(settings) as c:
        got = c.get("/v0/agents/1/reputation").json()["agents"]
    assert len(got) == 1
    row = got[0]
    expected = Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros))).observe(
        True, 400000.0
    )
    assert row["basis"] == "validated outcomes"
    assert (row["counted_outcomes"], row["uncounted_credit_outcomes"]) == (1, 1)
    assert row["success_mean"] == pytest.approx(expected.mean_success)
    assert row["cost_mean_micros"] == pytest.approx(expected.mean_cost)
    assert row["value_density_per_usdc"] == pytest.approx(expected.density * 1_000_000)


def test_an_unknown_agent_is_404_and_a_malformed_category_is_422(database_url: str, settings: Settings):
    with client(settings) as c:
        assert c.get("/v0/agents/999/reputation").status_code == 404
        assert c.get("/v0/agents/reputation", params={"category": "Not Valid!"}).status_code == 422
