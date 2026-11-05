"""`GET /v0/world/config` and `POST /v0/world/rp-context` (plan sec 1.7, task 4): the public config probe
the frontend reads before deciding whether to show IDKit or Agent Pass UI at all, and the signed RP context
IDKit needs to open a proof request. Neither route touches Postgres (`/config` takes no dependency that
does; `/rp-context`'s session check is driven directly through `auth.current_principal`'s dependency
override, the same pattern `test_world_pr_gate.py` uses for `auth.current_address`), so this file runs with
the default, no-Docker test suite.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp import auth, routes_world
from mergit_cp.auth import Principal
from mergit_cp.config import Settings
from mergit_cp.world.rp_sign import _compute_rp_signature_message

SIGNING_KEY = "11" * 32

SETTINGS = Settings(
    database_url="unused",
    app_domain="app.mergit.test",
    session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
    gateway_url="http://gateway.invalid",
    store_url="http://store.invalid",
    agents_file="unused",
    planner_model="claude-opus-5",
    planner_provider="anthropic",
    events_token=SecretStr("test-events-token"),
    chain_events_token=SecretStr("test-chain-events-token"),
    worker_token=SecretStr("test-worker-token"),
)

WORLD_ON = SETTINGS.model_copy(
    update={
        "world_app_id": "app_test123",
        "world_rp_id": "rp_test123",
        "world_signing_key": SecretStr(SIGNING_KEY),
        "world_idp_client_id": "client_test123",
        "world_idp_client_secret": SecretStr("client-secret-test123"),
        # Not the default ("production"), so the config test below can tell it is really passed through.
        "world_environment": "staging",
    }
)


def _app(settings: Settings) -> FastAPI:
    """A bare `FastAPI` app carrying only `routes_world.router`, no lifespan and no real pool: `/config`
    takes no pool-backed dependency, and the one route here that does (`/rp-context`, through
    `PrincipalDep`) either fails the session check before ever touching the pool, or has that dependency
    overridden outright."""
    app = FastAPI()
    app.state.settings = settings
    app.state.pool = None  # never dereferenced: see the docstring above
    app.include_router(routes_world.router)
    return app


def _signed_in(app: FastAPI, *, user_id: Any = None) -> None:
    app.dependency_overrides[auth.current_principal] = lambda: Principal(
        address="0xabc", user_id=user_id or uuid4(), owned=["0xabc"]
    )


def test_config_exposes_only_public_values() -> None:
    app = _app(WORLD_ON)
    with TestClient(app) as client:
        response = client.get("/v0/world/config")
    assert response.status_code == 200, response.text
    body = response.json()
    raw = response.text
    assert SIGNING_KEY not in raw
    assert "client-secret-test123" not in raw
    assert "client_test123" not in raw
    assert "signing_key" not in raw
    assert "client_secret" not in raw
    assert body["idkit"]["enabled"] is True
    assert body["idkit"]["app_id"] == "app_test123"
    assert body["idkit"]["rp_id"] == "rp_test123"
    assert body["idkit"]["action"] == WORLD_ON.world_trial_action
    assert body["idkit"]["preset"] == WORLD_ON.world_trial_preset
    # IDKit's own request config defaults `environment` to "production"; a staging/sandbox deployment whose
    # widget did not know better would make every proof for the wrong environment (`wrong_environment`).
    assert body["idkit"]["environment"] == "staging"
    assert set(body["idkit"]) == {"enabled", "app_id", "rp_id", "action", "preset", "environment"}
    assert body["agent_pass"]["enabled"] is True


def test_config_reports_disabled_when_unconfigured() -> None:
    app = _app(SETTINGS)
    with TestClient(app) as client:
        response = client.get("/v0/world/config")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["idkit"]["enabled"] is False
    assert body["idkit"]["rp_id"] is None
    assert body["idkit"]["environment"] == "production"
    assert body["agent_pass"]["enabled"] is False


def test_rp_context_needs_a_session() -> None:
    app = _app(WORLD_ON)
    with TestClient(app) as client:
        response = client.post("/v0/world/rp-context")
    assert response.status_code == 401, response.text


def test_rp_context_refuses_unknown_actions() -> None:
    app = _app(WORLD_ON)
    _signed_in(app)
    with TestClient(app) as client:
        response = client.post("/v0/world/rp-context", json={"action": "something-else"})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("body", [None, {"action": "mergit-free-trial"}])
def test_rp_context_is_signed_for_the_trial_action(body: dict[str, str] | None) -> None:
    app = _app(WORLD_ON)
    _signed_in(app)
    with TestClient(app) as client:
        response = client.post("/v0/world/rp-context", json=body)
    assert response.status_code == 200, response.text
    context = response.json()
    assert set(context) == {"sig", "nonce", "created_at", "expires_at"}

    nonce = bytes.fromhex(context["nonce"][2:])
    message = _compute_rp_signature_message(
        nonce, context["created_at"], context["expires_at"], "mergit-free-trial"
    )
    signable = encode_defunct(primitive=message)
    sig_bytes = bytes.fromhex(context["sig"][2:])
    recovered = Account.recover_message(signable, signature=sig_bytes)
    signer = Account.from_key(bytes.fromhex(SIGNING_KEY)).address
    assert recovered == signer
