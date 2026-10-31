# ruff: noqa: F811  (the fixtures are imported from test_accounts and then named as test parameters)
"""One person, two accounts: a wallet that has its own account can be merged into the account you are in.

A wallet belongs to one account, or "sign in with this wallet" would be ambiguous. When someone who is
signed in proves they hold a wallet that has its own account, the same person has proven both sides, so the
two accounts can become one. Only after they confirm, and with a one-time offer, never silently.
Run with `pytest -m postgres`.
"""

from __future__ import annotations

import psycopg
import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from mergit_cp.config import Settings
from tests.test_accounts import (  # noqa: F401  (fixtures)
    _nonce,
    _signed_by,
    client,
    configured,
    github_login,
    google_login,
    me,
    outbox,
)
from tests.test_plans import BODY

pytestmark = pytest.mark.postgres


def wallet_user(client: TestClient, *, interest: list[str] | None = None) -> tuple[Account, str]:
    """A user who only ever signed in with a wallet. Leaves the client signed out."""
    account = Account.create()
    assert client.post("/v0/auth/verify", json=_signed_by(account, _nonce(client))).status_code == 200
    user = me(client)["user_id"]
    if interest:
        assert client.post("/v0/wallet-interest", json={"wallets": interest}).status_code == 204
    client.post("/v0/auth/logout")
    client.cookies.clear()
    return account, user


def conflict(client: TestClient, account: Account) -> dict[str, object]:
    response = client.post("/v0/auth/wallet/link", json=_signed_by(account, _nonce(client)))
    assert response.status_code == 409, response.text
    return response.json()["detail"]


def merge(client: TestClient, token: object) -> int:
    return client.post("/v0/auth/merge", json={"merge_token": token}).status_code


def test_linking_a_wallet_that_has_its_own_account_offers_a_merge_and_moves_nothing(
    client: TestClient,
) -> None:
    account, other = wallet_user(client)
    github_login(client)
    mine = me(client)
    detail = conflict(client, account)
    assert detail["code"] == "wallet_taken"
    assert isinstance(detail["merge_token"], str) and len(detail["merge_token"]) >= 32
    assert detail["other"] == {"identities": [], "wallets": 1, "plans": 0, "trial_started": False}
    assert me(client) == mine  # a refusal until they confirm
    assert other != mine["user_id"]


def test_confirming_moves_the_wallet_and_everything_else_to_the_account_you_are_in(
    client: TestClient, configured: Settings
) -> None:
    account, other = wallet_user(client)
    github_login(client)
    mine = me(client)["user_id"]
    token = conflict(client, account)["merge_token"]
    response = client.post("/v0/auth/merge", json={"merge_token": token})
    assert response.status_code == 200, response.text
    assert response.json() == {"address": account.address.lower()}

    after = me(client)
    assert after["user_id"] == mine
    assert after["address"] == account.address.lower()
    assert after["wallets"] == [account.address.lower()]
    assert {"provider": "github", "label": "octo"} in after["identities"]
    with psycopg.connect(configured.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM users WHERE user_id = %s", (other,)).fetchone() == (0,)

    # Signing in with the wallet afterwards is signing in to the merged account.
    client.cookies.clear()
    again = client.post("/v0/auth/verify", json=_signed_by(account, _nonce(client)) | {"intent": "login"})
    assert again.status_code == 200
    assert me(client)["user_id"] == mine


def test_the_absorbed_accounts_runs_stay_visible_including_its_free_trial_ones(client: TestClient) -> None:
    google_login(client)  # the account that will be absorbed
    client.post("/v0/account/trial")
    trial_plan = client.post("/v0/plans", json=BODY).json()["plan_uuid"]  # requester: its trial address
    account = Account.create()
    assert client.post("/v0/auth/wallet/link", json=_signed_by(account, _nonce(client))).status_code == 200
    wallet_plan = client.post("/v0/plans", json=BODY).json()["plan_uuid"]  # now it acts as the wallet
    client.post("/v0/auth/logout")
    client.cookies.clear()

    github_login(client)
    assert client.get("/v0/plans").json() == []
    assert merge(client, conflict(client, account)["merge_token"]) == 200
    assert {p["plan_uuid"] for p in client.get("/v0/plans").json()} == {trial_plan, wallet_plan}
    assert client.get(f"/v0/plans/{trial_plan}").status_code == 200


def test_a_merge_offer_reports_what_the_other_account_has(client: TestClient) -> None:
    google_login(client)
    client.post("/v0/account/trial")
    client.post("/v0/plans", json=BODY)
    account = Account.create()
    client.post("/v0/auth/wallet/link", json=_signed_by(account, _nonce(client)))
    client.post("/v0/auth/logout")
    client.cookies.clear()
    github_login(client)
    assert conflict(client, account)["other"] == {
        "identities": [{"provider": "google", "label": "gee@example.com"}],
        "wallets": 1,
        "plans": 1,
        "trial_started": True,
    }


def test_an_account_that_was_merged_into_another_which_is_then_merged_again_is_not_lost(
    client: TestClient,
) -> None:
    google_login(client)  # B
    client.post("/v0/account/trial")
    b_plan = client.post("/v0/plans", json=BODY).json()["plan_uuid"]
    b_wallet = Account.create()
    client.post("/v0/auth/wallet/link", json=_signed_by(b_wallet, _nonce(client)))
    client.post("/v0/auth/logout")
    client.cookies.clear()

    github_login(client)  # A absorbs B
    assert merge(client, conflict(client, b_wallet)["merge_token"]) == 200
    client.post("/v0/auth/logout")
    client.cookies.clear()

    google_login(client, sub="g-2")  # D absorbs A, which had absorbed B
    assert merge(client, conflict(client, b_wallet)["merge_token"]) == 200
    assert b_plan in {p["plan_uuid"] for p in client.get("/v0/plans").json()}


def test_the_earliest_trial_start_is_kept(client: TestClient, configured: Settings) -> None:
    google_login(client)
    client.post("/v0/account/trial")
    account = Account.create()
    client.post("/v0/auth/wallet/link", json=_signed_by(account, _nonce(client)))
    with psycopg.connect(configured.database_url) as conn:
        conn.execute("UPDATE users SET trial_started_at = now() - interval '5 days'")
        earlier = conn.execute("SELECT min(trial_started_at) FROM users").fetchone()
    client.post("/v0/auth/logout")
    client.cookies.clear()
    github_login(client)
    client.post("/v0/account/trial")
    merge(client, conflict(client, account)["merge_token"])
    with psycopg.connect(configured.database_url) as conn:
        kept = conn.execute(
            "SELECT trial_started_at FROM users WHERE user_id = %s", (me(client)["user_id"],)
        ).fetchone()
    assert kept == earlier


def test_wallet_votes_move_over_without_counting_twice(client: TestClient, configured: Settings) -> None:
    account, _ = wallet_user(client, interest=["trust", "rabby"])
    github_login(client)
    client.post("/v0/wallet-interest", json={"wallets": ["trust"]})
    mine = me(client)["user_id"]
    merge(client, conflict(client, account)["merge_token"])
    with psycopg.connect(configured.database_url) as conn:
        rows = conn.execute(
            "SELECT wallet FROM wallet_interest WHERE user_id = %s ORDER BY wallet", (mine,)
        ).fetchall()
    assert rows == [("rabby",), ("trust",)]


def test_an_offer_works_once(client: TestClient) -> None:
    account, _ = wallet_user(client)
    github_login(client)
    token = conflict(client, account)["merge_token"]
    assert merge(client, token) == 200
    assert merge(client, token) == 404


def test_an_offer_expires(client: TestClient, configured: Settings) -> None:
    account, _ = wallet_user(client)
    github_login(client)
    token = conflict(client, account)["merge_token"]
    with psycopg.connect(configured.database_url) as conn:
        conn.execute("UPDATE pending_merges SET expires_at = now() - interval '1 second'")
    assert merge(client, token) == 404
    assert me(client)["wallets"] == []


def test_an_offer_is_for_the_account_it_was_made_for(client: TestClient) -> None:
    account, _ = wallet_user(client)
    github_login(client)
    token = conflict(client, account)["merge_token"]
    client.post("/v0/auth/logout")
    client.cookies.clear()
    google_login(client)  # someone else, signed in, holding a token they should not have
    assert merge(client, token) == 403
    assert me(client)["wallets"] == []
    # and the rightful account can still use it
    client.cookies.clear()
    github_login(client)
    assert merge(client, token) == 200


def test_an_offer_needs_a_session_and_a_real_token(client: TestClient) -> None:
    assert merge(client, "x" * 40) == 401
    github_login(client)
    assert merge(client, "x" * 40) == 404
    assert client.post("/v0/auth/merge", json={"merge_token": "short"}).status_code == 422
    assert client.post("/v0/auth/merge", json={}).status_code == 422


def test_an_offer_is_refused_if_the_wallet_changed_hands_meanwhile(
    client: TestClient, configured: Settings
) -> None:
    account, _ = wallet_user(client)
    github_login(client)
    token = conflict(client, account)["merge_token"]
    with psycopg.connect(configured.database_url) as conn:
        third = conn.execute("INSERT INTO users DEFAULT VALUES RETURNING user_id").fetchone()
        assert third is not None
        conn.execute("UPDATE wallets SET user_id = %s", (third[0],))
    assert merge(client, token) == 404
