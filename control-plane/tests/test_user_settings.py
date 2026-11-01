# ruff: noqa: F811  (the fixtures are imported from test_accounts and then named as test parameters)
"""The settings a signed-in user controls: profile, sign-in methods, wallets, sessions, run preferences, spend
limits and deleting the account.

Mostly guards that must fire: nobody is left without a way to sign in, a wallet with work in flight is not
pulled out from under it, a spend cap blocks an approval, and a deleted account keeps no goal text but also
cannot collect the free credits a second time. Run with `pytest -m postgres`.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest
from eth_account import Account
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.cp_fakes import FakeLLM, result
from tests.test_accounts import (  # noqa: F401  (fixtures)
    Outbox,
    _nonce,
    _signed_by,
    github_login,
    google_login,
    me,
    outbox,
    sign_in_with_wallet,
)
from tests.test_plans import BODY, planned

pytestmark = pytest.mark.postgres

SECOND_MODEL = "claude-sonnet-5"  # priced in prices.toml, so it may be offered


@pytest.fixture
def configured(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "github_client_id": "gh-id",
            "github_client_secret": SecretStr("gh-secret"),
            "google_client_id": "g-id",
            "google_client_secret": SecretStr("g-secret"),
            "planner_models": [settings.planner_model, SECOND_MODEL],
        }
    )


@pytest.fixture
def client(configured: Settings, outbox: Outbox) -> Iterator[TestClient]:
    llm = FakeLLM([result(planned()) for _ in range(8)])
    app = create_app(configured, llm=llm, deliver_events=False, mailer=outbox)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as c:
        yield c
    with psycopg.connect(configured.database_url) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
        ).fetchall()
        conn.execute("TRUNCATE " + ", ".join(t[0] for t in tables) + " CASCADE")


def link_wallet(client: TestClient) -> str:
    account = Account.create()
    response = client.post("/v0/auth/wallet/link", json=_signed_by(account, _nonce(client)))
    assert response.status_code == 200, response.text
    return account.address.lower()


def trial_user(client: TestClient) -> None:
    github_login(client)
    assert client.post("/v0/account/trial").status_code == 200


def approve(client: TestClient, plan: dict[str, object], funding: str = "credits") -> int:
    tasks = {str(t["index"]): ["1"] for t in plan["tasks"]}  # type: ignore[index,union-attr]
    return client.post(
        f"/v0/plans/{plan['plan_uuid']}/approve", json={"agents": tasks, "funding": funding}
    ).status_code


def run(settings: Settings, sql: str, *args: object) -> list[tuple[object, ...]]:
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        cur = conn.execute(sql, args or None)  # type: ignore[arg-type]
        return cur.fetchall() if cur.description else []


# --- who may ask -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/v0/account/settings", None),
        ("PUT", "/v0/account/settings", {}),
        ("PATCH", "/v0/account/profile", {"name": "x"}),
        ("DELETE", "/v0/account/wallets/0x" + "1" * 40, None),
        ("DELETE", "/v0/account/identities/github", None),
        ("GET", "/v0/account/sessions", None),
        ("POST", "/v0/account/sessions/revoke-others", None),
        ("DELETE", "/v0/account", {"confirm": "delete"}),
    ],
)
def test_every_settings_route_needs_a_session(
    client: TestClient, method: str, path: str, body: object
) -> None:
    assert client.request(method, path, json=body).status_code == 401


# --- profile ---------------------------------------------------------------------------------------------


def test_the_name_can_be_changed_and_is_trimmed(client: TestClient) -> None:
    github_login(client)
    response = client.patch("/v0/account/profile", json={"name": "  Yash V  "})
    assert response.status_code == 200, response.text
    assert me(client)["name"] == "Yash V"


@pytest.mark.parametrize("name", ["", "   ", "x" * 81, "bad\x00name"])
def test_a_bad_name_is_refused(client: TestClient, name: str) -> None:
    github_login(client)
    before = me(client)["name"]
    assert client.patch("/v0/account/profile", json={"name": name}).status_code == 422
    assert me(client)["name"] == before


# --- run preferences and limits --------------------------------------------------------------------------


def test_defaults_are_served_before_anything_is_saved(client: TestClient, configured: Settings) -> None:
    github_login(client)
    got = client.get("/v0/account/settings")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["preferences"] == {
        "planner_model": None,
        "routing_mode": "greedy",
        "max_attempts": 1,
        "default_funding": "credits",
        "per_plan_cap_usdc_units": None,
        "daily_cap_usdc_units": None,
    }
    assert body["planner_models"] == [configured.planner_model, SECOND_MODEL]
    assert body["default_planner_model"] == configured.planner_model


def test_preferences_round_trip(client: TestClient) -> None:
    github_login(client)
    saved = {
        "planner_model": SECOND_MODEL,
        "routing_mode": "explore",
        "max_attempts": 3,
        "default_funding": "wallet",
        "per_plan_cap_usdc_units": "3000000",
        "daily_cap_usdc_units": "9000000",
    }
    assert client.put("/v0/account/settings", json=saved).status_code == 200
    assert client.get("/v0/account/settings").json()["preferences"] == saved


@pytest.mark.parametrize(
    "bad",
    [
        {"planner_model": "gpt-nope"},
        {"routing_mode": "yolo"},
        {"max_attempts": 0},
        {"max_attempts": 4},
        {"default_funding": "cash"},
        {"per_plan_cap_usdc_units": "0"},
        {"per_plan_cap_usdc_units": "-5"},
        {"daily_cap_usdc_units": "lots"},
    ],
)
def test_an_invalid_preference_is_refused_and_nothing_changes(
    client: TestClient, bad: dict[str, object]
) -> None:
    github_login(client)
    before = client.get("/v0/account/settings").json()
    assert client.put("/v0/account/settings", json=bad).status_code == 422
    assert client.get("/v0/account/settings").json() == before


def test_the_chosen_planner_model_drafts_the_plan(client: TestClient, configured: Settings) -> None:
    trial_user(client)
    assert client.put("/v0/account/settings", json={"planner_model": SECOND_MODEL}).status_code == 200
    assert client.post("/v0/plans", json=BODY).status_code == 201
    assert run(configured, "SELECT planner_model FROM plans") == [(SECOND_MODEL,)]


def test_another_users_preferences_are_not_theirs(client: TestClient) -> None:
    github_login(client)
    assert client.put("/v0/account/settings", json={"routing_mode": "explore"}).status_code == 200
    client.cookies.clear()
    google_login(client)
    assert client.get("/v0/account/settings").json()["preferences"]["routing_mode"] == "greedy"


def test_a_plan_over_the_per_plan_cap_is_not_approved(client: TestClient) -> None:
    trial_user(client)
    assert client.put("/v0/account/settings", json={"per_plan_cap_usdc_units": "500000"}).status_code == 200
    plan = client.post("/v0/plans", json=BODY).json()  # two tasks of 500000 each
    assert approve(client, plan) == 422
    assert client.get(f"/v0/plans/{plan['plan_uuid']}").json()["state"] == "draft"


def test_the_daily_cap_counts_what_was_approved_in_the_last_day(client: TestClient) -> None:
    trial_user(client)
    assert client.put("/v0/account/settings", json={"daily_cap_usdc_units": "1500000"}).status_code == 200
    first = client.post("/v0/plans", json=BODY).json()
    second = client.post("/v0/plans", json=BODY).json()
    assert approve(client, first) == 200  # 1000000 of 1500000
    assert approve(client, second) == 422  # would make 2000000


# --- sign-in methods and wallets -------------------------------------------------------------------------


def test_the_only_way_to_sign_in_cannot_be_removed(client: TestClient) -> None:
    github_login(client)
    assert client.delete("/v0/account/identities/github").status_code == 409
    assert [i["provider"] for i in me(client)["identities"]] == ["github"]


def test_an_identity_can_go_when_another_way_remains(client: TestClient) -> None:
    github_login(client)
    link_wallet(client)
    assert client.delete("/v0/account/identities/github").status_code == 204
    assert me(client)["identities"] == []
    assert client.delete("/v0/account/identities/github").status_code == 404


def test_the_last_wallet_of_a_wallet_only_account_cannot_be_removed(client: TestClient) -> None:
    address = sign_in_with_wallet(client)
    assert client.delete(f"/v0/account/wallets/{address}").status_code == 409
    assert me(client)["wallets"] == [address]


def test_a_wallet_goes_and_the_session_falls_back_to_a_wallet_that_is_left(client: TestClient) -> None:
    github_login(client)
    first = link_wallet(client)
    second = link_wallet(client)
    assert me(client)["address"] == second
    assert client.delete(f"/v0/account/wallets/{second}").status_code == 204
    after = me(client)
    assert after["wallets"] == [first]
    assert after["address"] == first


def test_removing_the_last_wallet_of_an_account_with_a_login_goes_back_to_the_trial_address(
    client: TestClient,
) -> None:
    github_login(client)
    wallet = link_wallet(client)
    assert client.delete(f"/v0/account/wallets/{wallet}").status_code == 204
    after = me(client)
    assert after["wallets"] == []
    assert after["address"] == after["trial_address"]


def test_someone_elses_wallet_cannot_be_removed(client: TestClient, configured: Settings) -> None:
    github_login(client)
    mine = link_wallet(client)
    client.cookies.clear()
    google_login(client)
    other = link_wallet(client)
    assert client.delete(f"/v0/account/wallets/{mine}").status_code == 404
    assert run(configured, "SELECT count(*) FROM wallets WHERE address = %s", mine) == [(1,)]
    assert other != mine


def test_a_wallet_with_a_plan_in_flight_stays(client: TestClient) -> None:
    github_login(client)
    wallet = link_wallet(client)
    plan = client.post("/v0/plans", json=BODY).json()
    assert approve(client, plan, "wallet") == 200
    response = client.delete(f"/v0/account/wallets/{wallet}")
    assert response.status_code == 409
    assert me(client)["wallets"] == [wallet]


# --- sessions --------------------------------------------------------------------------------------------


def test_sessions_lists_this_one_as_current(client: TestClient) -> None:
    github_login(client)
    listed = client.get("/v0/account/sessions").json()
    assert [s["current"] for s in listed] == [True]
    assert set(listed[0]) == {"created_at", "expires_at", "address", "current"}


def test_signing_out_other_devices_keeps_this_one(client: TestClient, configured: Settings) -> None:
    github_login(client)
    this = client.cookies.get("mergit_session")
    github_login(client)  # a second session of the same user (same GitHub identity)
    other = client.cookies.get("mergit_session")
    assert this != other
    assert client.post("/v0/account/sessions/revoke-others").status_code == 200
    assert me(client)["name"]  # still signed in
    client.cookies.clear()
    client.cookies.set("mergit_session", str(this))
    assert client.get("/v0/auth/me").status_code == 401


# --- deleting the account --------------------------------------------------------------------------------


def test_the_confirmation_must_match(client: TestClient) -> None:
    github_login(client)
    assert client.request("DELETE", "/v0/account", json={"confirm": "nope"}).status_code == 422
    assert me(client)["name"]


def test_deleting_removes_the_user_and_signs_every_session_out(
    client: TestClient, configured: Settings
) -> None:
    github_login(client)
    link_wallet(client)
    assert client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    assert client.get("/v0/auth/me").status_code == 401
    for table in ("users", "identities", "wallets", "sessions"):
        assert run(configured, f"SELECT count(*) FROM {table}") == [(0,)]


def test_deleting_redacts_plan_text_and_keeps_the_money_trail(
    client: TestClient, configured: Settings
) -> None:
    trial_user(client)
    plan = client.post("/v0/plans", json=BODY).json()
    assert approve(client, plan) == 200
    draft = client.post("/v0/plans", json=BODY).json()
    run(configured, "UPDATE plans SET state = 'done' WHERE plan_uuid = %s", plan["plan_uuid"])
    assert client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    goals = run(configured, "SELECT goal, repo_url, ref FROM plans")
    assert len(goals) == 2
    assert all(row == ("[deleted]", "[deleted]", "[deleted]") for row in goals)
    assert run(configured, "SELECT count(*) FROM tasks WHERE instructions <> '[deleted]'") == [(0,)]
    assert run(configured, "SELECT count(*) FROM plans WHERE plan_uuid = %s", draft["plan_uuid"]) == [(1,)]


def test_deleting_is_refused_while_a_plan_is_in_flight(client: TestClient, configured: Settings) -> None:
    trial_user(client)
    plan = client.post("/v0/plans", json=BODY).json()
    assert approve(client, plan) == 200
    response = client.request("DELETE", "/v0/account", json={"confirm": "delete"})
    assert response.status_code == 409
    assert me(client)["name"]
    assert run(configured, "SELECT goal FROM plans") != [("[deleted]",)]


def test_one_person_cannot_collect_the_free_credits_twice_by_deleting_and_coming_back(
    client: TestClient,
) -> None:
    trial_user(client)
    assert client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    client.cookies.clear()
    github_login(client)  # the same GitHub identity, a brand new account
    assert client.post("/v0/account/trial").status_code == 403
    assert client.post("/v0/plans", json=BODY).status_code == 403


def test_another_person_is_unaffected_by_a_deletion(client: TestClient) -> None:
    github_login(client)
    assert client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    client.cookies.clear()
    google_login(client)
    assert client.post("/v0/account/trial").status_code == 200
