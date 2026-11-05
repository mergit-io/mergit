"""The World Agent Pass human-approval gate on `POST /v0/plans/{id}/approve` (plan sec 1.7), driven entirely
through HTTP: 428 when a fresh approval is needed, the popup's `/start` -> World login -> `/callback` journey
with a minted ID token, and the `X-World-Approval` header redeeming it. `test_world_approvals.py` covers the
lifecycle functions directly against Postgres; this file proves the HTTP wiring around them. Run with
`pytest -m postgres`.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import psycopg
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from mergit_cp.world import idp
from tests.cp_fakes import FakeLLM, result
from tests.test_plans import APPROVE, create, outbox, planned, sign_in, tasks_body
from tests.world_fakes_idp import TEST_ISSUER, jwks_json, mint_id_token, respx_world_idp, rsa_key

pytestmark = pytest.mark.postgres

JWKS_URL = f"{TEST_ISSUER}{idp.JWKS_PATH}"


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM([result(planned()) for _ in range(20)])


@pytest.fixture
def settings(settings: Settings, tmp_path: Path) -> Settings:
    """Two agents (so a requester can list a retry agent), with Agent Pass configured."""
    chain = tmp_path / "two-agents.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": i,
                        "name": f"agent-{i}",
                        "operator": "0x" + "1" * 40,
                        "runtime_key": "0x" + "2" * 40,
                    }
                    for i in ("1", "2")
                ]
            }
        )
    )
    config = tmp_path / "two-agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        + "".join(
            f'[agents.agent-{i}]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n'
            for i in ("1", "2")
        )
    )
    return settings.model_copy(
        update={
            "agents_file": str(chain),
            "agents_config": str(config),
            "world_idp_client_id": "test-client",
            "world_idp_client_secret": SecretStr("test-client-secret"),
        }
    )


def _truncate(settings: Settings) -> None:
    with psycopg.connect(settings.database_url) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
        ).fetchall()
        if tables:
            conn.execute("TRUNCATE " + ", ".join(t[0] for t in tables) + " CASCADE")


@pytest.fixture
def app_client(settings: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    app = create_app(settings, llm=llm, deliver_events=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as c:
        yield c
    _truncate(settings)


def require_approval(client: TestClient, plan_uuid: str) -> dict[str, Any]:
    response = client.post(f"/v0/plans/{plan_uuid}/approve", json=APPROVE)
    assert response.status_code == 428, response.text
    return response.json()["detail"]


def start_world(client: TestClient, approval_id: str) -> tuple[str, str]:
    """Hits `/start`; returns `(state, nonce)` as World would receive them in the authorize URL."""
    start = client.get(f"/v0/world/approvals/{approval_id}/start")
    assert start.status_code == 302, start.text
    query = parse_qs(urlsplit(start.headers["location"]).query)
    return query["state"][0], query["nonce"][0]


def world_callback(
    client: TestClient, key: RSAPrivateKey, *, state: str, nonce: str, **claim_overrides: Any
) -> httpx.Response:
    token = mint_id_token(key, nonce=nonce, **claim_overrides)
    with respx.mock(assert_all_called=False) as router:
        router.get(JWKS_URL).respond(json=jwks_json(key))
        respx_world_idp(router, token)
        return client.get("/v0/world/callback", params={"code": "test-code", "state": state})


def world_cancel(client: TestClient, *, state: str) -> httpx.Response:
    return client.get("/v0/world/callback", params={"state": state, "error": "access_denied"})


# --- the 428 and its persistence ----------------------------------------------------------------------


def test_approve_without_header_persists_the_approval_row(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    assert detail["code"] == "human_approval_required"
    assert detail["start_url"] == f"/v0/world/approvals/{detail['approval_id']}/start"
    assert detail["summary"]["plan_id"] == plan["plan_id"]

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT status FROM world_approvals WHERE approval_id = %s", (detail["approval_id"],)
        ).fetchone()
    assert row == ("pending",)


# --- the full journey -----------------------------------------------------------------------------------


def test_full_journey_approves_and_funds_the_plan(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]

    state, nonce = start_world(app_client, approval_id)
    key = rsa_key()
    callback = world_callback(app_client, key, state=state, nonce=nonce)
    assert callback.status_code == 302
    want = f"{settings.public_origin}/world/approved?approval={approval_id}&status=approved"
    assert callback.headers["location"] == want

    polled = app_client.get(f"/v0/world/approvals/{approval_id}")
    assert polled.status_code == 200
    assert polled.json()["status"] == "approved"

    approved = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE, headers={"X-World-Approval": approval_id}
    )
    assert approved.status_code == 200, approved.text

    events = [e for e in outbox(settings) if e["type"] == "plan.approved"]
    assert len(events) == 1
    assert events[0]["payload"]["plan_uuid"] == plan["plan_uuid"]

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT status FROM world_approvals WHERE approval_id = %s", (approval_id,)
        ).fetchone()
    assert row == ("consumed",)
    # A second approve on this same plan now hits the "only a draft can change" 409 before the World gate
    # even runs (the plan is no longer a draft) — so re-redeeming a `consumed` approval ("used") cannot be
    # exercised through this same plan at the HTTP layer; it is covered directly against `consume` in
    # test_world_approvals.py::test_consume_succeeds_once_then_refuses_reuse.


def test_cancel_at_world_denies_and_nothing_is_funded(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]

    state, _nonce = start_world(app_client, approval_id)
    callback = world_cancel(app_client, state=state)
    assert callback.status_code == 302
    want = f"{settings.public_origin}/world/approved?approval={approval_id}&status=denied"
    assert callback.headers["location"] == want

    denied = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE, headers={"X-World-Approval": approval_id}
    )
    assert denied.status_code == 403
    assert denied.json()["detail"] == {"code": "human_approval_invalid", "reason": "denied"}

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("SELECT state FROM plans WHERE plan_uuid = %s", (plan["plan_uuid"],)).fetchone()
    assert row == ("draft",)


def test_changed_budget_after_approval_is_refused(app_client: TestClient, settings: Settings) -> None:
    """Review Focus 2, end to end: approved for one budget, the draft is then edited, and the stale
    approval must not fund the new total."""
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]

    state, nonce = start_world(app_client, approval_id)
    key = rsa_key()
    assert world_callback(app_client, key, state=state, nonce=nonce).status_code == 302

    # tasks_body(2) totals 1_200_000 (2 * 600_000); the original plan totals 1_000_000 (2 * 500_000) — the
    # approval was created for the old total, so it must not cover this edited one.
    edited = app_client.patch(f"/v0/plans/{plan['plan_uuid']}", json=tasks_body(2))
    assert edited.status_code == 200, edited.text

    mismatched = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE, headers={"X-World-Approval": approval_id}
    )
    assert mismatched.status_code == 403
    assert mismatched.json()["detail"] == {"code": "human_approval_invalid", "reason": "action_mismatch"}

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("SELECT state FROM plans WHERE plan_uuid = %s", (plan["plan_uuid"],)).fetchone()
    assert row == ("draft",)


# --- the state cookie -----------------------------------------------------------------------------------


def test_callback_without_the_state_cookie_is_rejected(app_client: TestClient) -> None:
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    state, _nonce = start_world(app_client, detail["approval_id"])

    app_client.cookies.delete("mergit_world")
    callback = app_client.get("/v0/world/callback", params={"code": "irrelevant", "state": state})
    assert callback.status_code == 400


def test_callback_with_a_mismatched_cookie_is_rejected(app_client: TestClient) -> None:
    sign_in(app_client)
    plan = create(app_client)
    detail = require_approval(app_client, plan["plan_uuid"])
    state, _nonce = start_world(app_client, detail["approval_id"])

    # Replace the real cookie wholesale (delete, then set) rather than overwrite in place: the jar can hold
    # the old entry and a new one side by side across domain/path attributes, which would leave it unclear
    # which value the request actually sends.
    app_client.cookies.delete("mergit_world")
    app_client.cookies.set("mergit_world", "someone-elses-state")
    callback = app_client.get("/v0/world/callback", params={"code": "irrelevant", "state": state})
    assert callback.status_code == 400


# --- the gate is a no-op when Agent Pass is not configured -----------------------------------------------


def test_gate_is_off_when_agent_pass_is_not_configured(settings: Settings) -> None:
    off = settings.model_copy(update={"world_idp_client_id": None, "world_idp_client_secret": None})
    assert not off.world_idp_enabled
    llm = FakeLLM([result(planned())])
    with TestClient(create_app(off, llm=llm, deliver_events=False), base_url="https://testserver") as client:
        sign_in(client)
        plan = create(client)
        response = client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE)
        assert response.status_code == 200, response.text
    _truncate(settings)
