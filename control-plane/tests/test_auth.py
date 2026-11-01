"""Sign-In with Ethereum: every test here is a guard that must fire, except the first."""

from datetime import UTC, datetime

import psycopg
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient
from siwe import SiweMessage

from mergit_cp.config import Settings
from tests.conftest import APP_DOMAIN

pytestmark = pytest.mark.postgres

BASE_SEPOLIA = 84532


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _signed(
    nonce: str, *, domain: str = APP_DOMAIN, chain_id: int = BASE_SEPOLIA
) -> tuple[str, dict[str, str]]:
    account = Account.create()
    message = SiweMessage.model_validate(
        {
            "domain": domain,
            "address": account.address,
            "uri": f"https://{domain}",
            "version": "1",
            "chain_id": chain_id,
            "issued_at": _now(),
            "nonce": nonce,
            "statement": "Sign in to Mergit.",
        }
    ).prepare_message()
    signature = account.sign_message(encode_defunct(text=message)).signature.to_0x_hex()
    return account.address, {"message": message, "signature": signature}


def _nonce(client: TestClient) -> str:
    response = client.get("/v0/auth/nonce")
    assert response.status_code == 200
    return response.json()["nonce"]


def test_verify_accepts_valid_siwe_and_sets_cookie(client: TestClient) -> None:
    address, body = _signed(_nonce(client))
    response = client.post("/v0/auth/verify", json=body)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("mergit_session=")
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=lax" in cookie
    assert "Max-Age=43200" in cookie
    # /me also returns the profile (user_id, wallets, ...); only the address is checked here.
    assert client.get("/v0/auth/me").json()["address"] == address.lower()


def test_verify_rejects_reused_nonce(client: TestClient) -> None:
    nonce = _nonce(client)
    _, first = _signed(nonce)
    assert client.post("/v0/auth/verify", json=first).status_code == 200
    _, replay = _signed(nonce)
    assert client.post("/v0/auth/verify", json=replay).status_code == 401


def test_verify_rejects_nonce_never_issued(client: TestClient) -> None:
    _, body = _signed("notissued123")
    assert client.post("/v0/auth/verify", json=body).status_code == 401


def test_verify_rejects_expired_nonce(client: TestClient, settings: Settings) -> None:
    nonce = _nonce(client)
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce = %s", (nonce,)
        )
    _, body = _signed(nonce)
    assert client.post("/v0/auth/verify", json=body).status_code == 401


def test_verify_rejects_wrong_chain_id(client: TestClient) -> None:
    _, body = _signed(_nonce(client), chain_id=1)
    assert client.post("/v0/auth/verify", json=body).status_code == 401


def test_verify_rejects_wrong_domain(client: TestClient) -> None:
    _, body = _signed(_nonce(client), domain="evil.example")
    assert client.post("/v0/auth/verify", json=body).status_code == 401


def test_verify_rejects_signature_from_another_key(client: TestClient) -> None:
    nonce = _nonce(client)
    _, body = _signed(nonce)
    _, other = _signed(nonce)
    body["signature"] = other["signature"]
    assert client.post("/v0/auth/verify", json=body).status_code == 401


def test_verify_rejects_garbage_message(client: TestClient) -> None:
    response = client.post("/v0/auth/verify", json={"message": "hello", "signature": "0x00"})
    assert response.status_code == 400


def test_me_requires_session(client: TestClient) -> None:
    assert client.get("/v0/auth/me").status_code == 401
    client.cookies.set("mergit_session", "forged-token")
    assert client.get("/v0/auth/me").status_code == 401


def test_expired_session_is_rejected(client: TestClient, settings: Settings) -> None:
    _, body = _signed(_nonce(client))
    assert client.post("/v0/auth/verify", json=body).status_code == 200
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("UPDATE sessions SET expires_at = now() - interval '1 second'")
    assert client.get("/v0/auth/me").status_code == 401


def test_logout_revokes_session_server_side(client: TestClient) -> None:
    _, body = _signed(_nonce(client))
    client.post("/v0/auth/verify", json=body)
    token = client.cookies.get("mergit_session")
    assert token
    assert client.post("/v0/auth/logout").status_code == 204
    # A copy of the cookie kept by an attacker must stop working too.
    client.cookies.set("mergit_session", token)
    assert client.get("/v0/auth/me").status_code == 401


def test_session_token_is_not_stored_in_clear(client: TestClient, settings: Settings) -> None:
    _, body = _signed(_nonce(client))
    client.post("/v0/auth/verify", json=body)
    token = client.cookies.get("mergit_session")
    assert token
    with psycopg.connect(settings.database_url) as conn:
        stored = conn.execute("SELECT token_hash FROM sessions").fetchone()
    assert stored is not None
    assert token.encode() not in bytes(stored[0])


def test_cors_allows_configured_origin_with_credentials(client: TestClient) -> None:
    response = client.options(
        "/v0/auth/me",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers["access-control-allow-credentials"] == "true"
    other = client.options(
        "/v0/auth/me", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert "access-control-allow-origin" not in other.headers


@pytest.mark.parametrize(
    "signature", ["0x" + "00" * 65, "0x" + "ff" * 65, "0x00", "0x", "not hex at all", "0x" + "12" * 64]
)
def test_verify_rejects_a_malformed_signature_with_401_not_a_crash(
    client: TestClient, signature: str
) -> None:
    _, body = _signed(_nonce(client))
    body["signature"] = signature
    response = client.post("/v0/auth/verify", json=body)
    assert response.status_code == 401, (signature, response.status_code, response.text)
    assert client.get("/v0/auth/me").status_code == 401
