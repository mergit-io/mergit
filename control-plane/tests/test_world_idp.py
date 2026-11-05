"""Agent Pass OIDC client (plan sec 1.3/1.8): the authorize URL, the code exchange, and ID-token
verification against World's JWKS. No database and no FastAPI app here — `routes_world.py` wires this module
into the approval endpoints in a later task; this file only has to trust `idp.py` on its own.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from pydantic import SecretStr

from mergit_cp.config import Settings
from mergit_cp.world import idp
from tests.world_fakes_idp import (
    TEST_ISSUER,
    jwks_json,
    mint_id_token,
    respx_world_idp,
    rsa_key,
)

JWKS_URL = f"{TEST_ISSUER}{idp.JWKS_PATH}"

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
    world_idp_client_id="test-client",
    world_idp_client_secret=SecretStr("test-client-secret"),
)
assert SETTINGS.world_idp_enabled


# --- authorize_url --------------------------------------------------------------------------------------


def test_authorize_url_forces_fresh_login() -> None:
    url = idp.authorize_url(SETTINGS, state="state-1", nonce="nonce-1", code_challenge="challenge-1")
    parsed = urlsplit(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == f"{TEST_ISSUER}{idp.AUTHORIZE_PATH}"
    query = parse_qs(parsed.query)
    assert query["response_type"] == ["code"]
    assert query["scope"] == ["openid"]
    assert query["max_age"] == ["0"]
    assert query["prompt"] == ["login"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] == ["challenge-1"]
    assert query["state"] == ["state-1"]
    assert query["nonce"] == ["nonce-1"]
    assert query["client_id"] == ["test-client"]
    assert query["redirect_uri"] == [f"{SETTINGS.public_origin}/v0/world/callback"]


# --- exchange_code ---------------------------------------------------------------------------------------


def test_exchange_posts_the_secret_in_the_body() -> None:
    async def go() -> str:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_idp(router, "minted-id-token")
            result = await idp.exchange_code(SETTINGS, http, "auth-code-1", "verifier-1")
            sent = httpx.QueryParams(router.calls.last.request.content.decode())
            assert sent["client_id"] == "test-client"
            assert sent["client_secret"] == "test-client-secret"
            assert sent["code"] == "auth-code-1"
            assert sent["code_verifier"] == "verifier-1"
            assert sent["grant_type"] == "authorization_code"
            assert sent["redirect_uri"] == f"{SETTINGS.public_origin}/v0/world/callback"
            return result

    assert asyncio.run(go()) == "minted-id-token"


# --- verify_id_token --------------------------------------------------------------------------------------


def test_valid_token_returns_claims() -> None:
    key = rsa_key()
    moment = 1_700_000_000
    token = mint_id_token(key, sub="sub-42", nonce="nonce-7", jti="jti-7", acr="orb", amr=["pop"], now=moment)

    async def go() -> idp.IdClaims:
        with respx.mock(assert_all_called=False) as router:
            router.get(JWKS_URL).respond(json=jwks_json(key))
            cache = idp.JwksCache(TEST_ISSUER)
            return await idp.verify_id_token(SETTINGS, cache, token, now=moment)

    claims = asyncio.run(go())
    assert claims == idp.IdClaims(
        sub="sub-42", auth_time=moment, acr="orb", amr=("pop",), jti="jti-7", nonce="nonce-7"
    )


@pytest.mark.parametrize("alg", ["HS256", "none"])
def test_callback_rejects_hs256_and_none_alg(alg: str) -> None:
    """A forged token whose `kid` names a real RS256 key, signed instead with `alg` — proves PyJWT's
    `algorithms=["RS256"]` allowlist refuses it on the algorithm alone, not merely that our code doesn't
    crash on it."""
    key = rsa_key()
    moment = 1_700_000_000
    token = mint_id_token(key, alg=alg, now=moment)

    async def go() -> None:
        with respx.mock(assert_all_called=False) as router:
            router.get(JWKS_URL).respond(json=jwks_json(key))
            cache = idp.JwksCache(TEST_ISSUER)
            await idp.verify_id_token(SETTINGS, cache, token, now=moment)

    with pytest.raises(idp.TokenInvalid):
        asyncio.run(go())


@pytest.mark.parametrize(
    "mutate",
    [
        lambda key, moment: mint_id_token(key, iss="https://evil.example", now=moment),
        lambda key, moment: mint_id_token(key, aud="someone-elses-client", now=moment),
        lambda key, moment: mint_id_token(key, now=moment, exp_in=-120),
    ],
    ids=["wrong_issuer", "wrong_audience", "expired"],
)
def test_wrong_issuer_audience_or_expired_is_rejected(
    mutate: Callable[[RSAPrivateKey, int], str],
) -> None:
    key = rsa_key()
    moment = 1_700_000_000
    token = mutate(key, moment)

    async def go() -> None:
        with respx.mock(assert_all_called=False) as router:
            router.get(JWKS_URL).respond(json=jwks_json(key))
            cache = idp.JwksCache(TEST_ISSUER)
            await idp.verify_id_token(SETTINGS, cache, token, now=moment)

    with pytest.raises(idp.TokenInvalid):
        asyncio.run(go())


def test_unknown_kid_refetches_jwks_once() -> None:
    old_key, rotated_key = rsa_key(), rsa_key()
    moment = 1_700_000_000
    token = mint_id_token(rotated_key, kid="rotated-key", now=moment)

    async def go() -> tuple[idp.IdClaims, int]:
        with respx.mock(assert_all_called=False) as router:
            route = router.get(JWKS_URL).mock(
                side_effect=[
                    httpx.Response(200, json=jwks_json(old_key)),
                    httpx.Response(200, json=jwks_json(rotated_key, kid="rotated-key")),
                ]
            )
            cache = idp.JwksCache(TEST_ISSUER)
            await cache.key_for("test-key-1")  # warms the cache with the first (soon-to-be-stale) key set
            claims = await idp.verify_id_token(SETTINGS, cache, token, now=moment)
            return claims, route.call_count

    claims, call_count = asyncio.run(go())
    assert call_count == 2
    assert claims.sub == "world-sub-1"


def test_callback_fails_closed_when_jwks_is_unreachable() -> None:
    key = rsa_key()
    moment = 1_700_000_000
    token = mint_id_token(key, now=moment)

    async def go() -> None:
        with respx.mock(assert_all_called=False) as router:
            router.get(JWKS_URL).mock(side_effect=httpx.ConnectError("boom"))
            cache = idp.JwksCache(TEST_ISSUER)
            await idp.verify_id_token(SETTINGS, cache, token, now=moment)

    with pytest.raises(idp.TokenInvalid) as excinfo:
        asyncio.run(go())
    assert excinfo.value.reason == "jwks_unreachable"


@pytest.mark.parametrize(
    "malformed_key",
    [
        {"kty": "RSA", "kid": "test-key-1", "use": "sig", "alg": "RS256", "e": "AQAB"},  # missing `n`
        {"kid": "test-key-1", "use": "sig", "alg": "RS256", "n": "AQAB", "e": "AQAB"},  # missing `kty`
        {"kty": "RSA", "kid": "test-key-1", "use": "sig", "alg": "RS256", "n": "@@@@", "e": "AQAB"},  # bad n
    ],
    ids=["missing_n", "missing_kty", "bad_n"],
)
def test_malformed_jwks_key_is_rejected_not_raised(malformed_key: dict[str, str]) -> None:
    """`PyJWK.from_dict` raises `InvalidKeyError` for a missing `kty`/`n` and `PyJWKError` for others, and
    neither is a subclass of the other — a `JwksCache` that only caught one of them would leak a raw PyJWT
    exception out of `verify_id_token` instead of failing closed with `TokenInvalid`."""
    key = rsa_key()
    moment = 1_700_000_000
    token = mint_id_token(key, now=moment)

    async def go() -> None:
        with respx.mock(assert_all_called=False) as router:
            router.get(JWKS_URL).respond(json={"keys": [malformed_key]})
            cache = idp.JwksCache(TEST_ISSUER)
            await idp.verify_id_token(SETTINGS, cache, token, now=moment)

    with pytest.raises(idp.TokenInvalid) as excinfo:
        asyncio.run(go())
    assert excinfo.value.reason == "malformed_jwks_key"
