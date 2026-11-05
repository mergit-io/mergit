"""Fakes for the Agent Pass OIDC half (plan sec 1.2/1.3/1.8: authorize, callback, ID-token verification, the
human-approval checkpoints). Filled in by whoever builds that half; empty for now so this PR's layout matches
what both halves will import from.

``rsa_key()`` is World's (fake) signing key for a test; ``jwks_json()`` is what its JWKS endpoint would
publish for that key; ``mint_id_token()`` signs an ID token with it, including the forged variants
(``alg="none"``, ``alg="HS256"``) a fail-closed test needs. ``respx_world_idp()`` registers the token-endpoint
route; the JWKS route is registered by the test itself (via ``jwks_json()``) since different tests need
different sequences of responses (a working fetch, an unreachable one, a rotated key).
"""

import time
from typing import Any

import respx
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from jwt import encode as jwt_encode
from jwt.utils import to_base64url_uint

TEST_ISSUER = "https://auth.world.org"
TEST_KID = "test-key-1"
TOKEN_URL = f"{TEST_ISSUER}/api/v1/token"


def rsa_key() -> RSAPrivateKey:
    """A freshly generated RSA keypair standing in for World's signing key."""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def jwks_json(key: RSAPrivateKey, *, kid: str = TEST_KID) -> dict[str, Any]:
    """The JSON body World's `/.well-known/jwks.json` would serve for `key`."""
    numbers = key.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": kid,
                "use": "sig",
                "alg": "RS256",
                "n": to_base64url_uint(numbers.n).decode(),
                "e": to_base64url_uint(numbers.e).decode(),
            }
        ]
    }


def mint_id_token(
    key: RSAPrivateKey,
    *,
    kid: str = TEST_KID,
    alg: str = "RS256",
    sub: str = "world-sub-1",
    iss: str = TEST_ISSUER,
    aud: str = "test-client",
    now: int | None = None,
    exp_in: int = 300,
    nonce: str = "test-nonce",
    jti: str = "test-jti",
    auth_time: int | None = None,
    acr: str | None = "orb",
    amr: list[str] | None = None,
    **extra_claims: Any,
) -> str:
    """Signs a World Agent Pass ID token. The default `alg="RS256"` signs with `key` (the matching keypair
    for `jwks_json(key)`); pass `alg="none"` or `alg="HS256"` to mint the forged tokens a fail-closed test
    needs — the `kid` still names a real RS256 key in the JWKS, since the point of that test is that the
    algorithm allowlist refuses them even when the key lookup would otherwise succeed."""
    moment = now if now is not None else int(time.time())
    payload: dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "exp": moment + exp_in,
        "iat": moment,
        "nonce": nonce,
        "jti": jti,
        "auth_time": auth_time if auth_time is not None else moment,
        "amr": amr if amr is not None else ["pop"],
        **extra_claims,
    }
    if acr is not None:
        payload["acr"] = acr
    signing_key: Any
    if alg == "RS256":
        signing_key = key
    elif alg == "none":
        signing_key = None
    else:
        # Any HMAC secret works for this: the test only needs *some* validly-signed HS256 token, since
        # `algorithms=["RS256"]` must refuse it before the signature is even checked.
        signing_key = "forged-hmac-secret-at-least-32-bytes-long!!"
    return jwt_encode(payload, signing_key, algorithm=alg, headers={"kid": kid})


def respx_world_idp(router: respx.MockRouter, token: str) -> None:
    """Mocks World's token endpoint to hand back `token` as the `id_token`."""
    router.post(TOKEN_URL).respond(json={"access_token": "unused", "token_type": "bearer", "id_token": token})
