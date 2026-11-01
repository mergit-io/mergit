"""The pull-request gate (diff, open-pr, pr) is part of the running API, behind the same sign-in as every
other plan route, and an account owns its plans through every address it holds.
Run with `pytest -m postgres`."""

from __future__ import annotations

import uuid

import pytest
from eth_account import Account
from fastapi.testclient import TestClient

from tests.test_accounts import (  # noqa: F401  (client, configured and outbox are fixtures)
    _nonce,
    _signed_by,
    client,
    configured,
    github_login,
    google_login,
    outbox,
)
from tests.test_plans import BODY

# ruff: noqa: F811  (the fixtures are imported and then named as test parameters)
pytestmark = pytest.mark.postgres

NOBODY = str(uuid.uuid4())


def draft_on_trial(c: TestClient) -> str:
    c.post("/v0/account/trial")
    made = c.post("/v0/plans", json=BODY)
    assert made.status_code == 201, made.text
    return made.json()["plan_uuid"]


def test_the_routes_exist_and_need_a_session(client: TestClient) -> None:
    for method, path in [("get", "diff"), ("post", "open-pr"), ("get", "pr")]:
        r = getattr(client, method)(f"/v0/plans/{NOBODY}/{path}")
        assert r.status_code == 401, (path, r.status_code)


def test_an_unknown_plan_is_a_404_not_a_405_or_a_crash(client: TestClient) -> None:
    github_login(client)
    for method, path in [("get", "diff"), ("post", "open-pr"), ("get", "pr")]:
        r = getattr(client, method)(f"/v0/plans/{NOBODY}/{path}")
        assert r.status_code == 404, (path, r.status_code, r.text)


def test_a_plan_that_is_not_done_cannot_be_turned_into_a_pull_request(client: TestClient) -> None:
    github_login(client)
    plan = draft_on_trial(client)
    diff = client.get(f"/v0/plans/{plan}/diff")
    assert diff.status_code == 409
    assert diff.json()["detail"]["blockers"]
    assert client.post(f"/v0/plans/{plan}/open-pr").status_code == 409
    assert client.get(f"/v0/plans/{plan}/pr").status_code == 404  # nothing was requested


def test_only_the_account_that_owns_the_plan_may_ask(client: TestClient) -> None:
    github_login(client)
    plan = draft_on_trial(client)
    client.cookies.clear()
    google_login(client)
    for method, path in [("get", "diff"), ("post", "open-pr"), ("get", "pr")]:
        r = getattr(client, method)(f"/v0/plans/{plan}/{path}")
        assert r.status_code == 403, (path, r.status_code)


def test_a_plan_drafted_on_the_trial_is_still_yours_after_you_connect_a_wallet(client: TestClient) -> None:
    github_login(client)
    plan = draft_on_trial(client)
    wallet = Account.create()
    assert client.post("/v0/auth/wallet/link", json=_signed_by(wallet, _nonce(client))).status_code == 200
    # The session now acts as the wallet, but the plan's requester is the trial address: still this account's.
    assert client.get(f"/v0/plans/{plan}/diff").status_code == 409  # yours, and not ready: not 403
    assert client.get(f"/v0/plans/{plan}/pr").status_code == 404
