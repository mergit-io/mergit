"""Agent Pass: the World ID OIDC client (plan sec 1.3/1.8).

A human-approval checkpoint sends the browser to World's `/authorize` with a fresh-login requirement
(`max_age=0`, `prompt=login`) and PKCE; World sends it back with a `code`; the server (never the browser)
exchanges that code for an ID token and verifies it against World's JWKS. This module stops at a verified
`IdClaims` — it does not know about plans, approvals or the database. The checks it makes are exactly the
ones that need no database row: the token's algorithm, issuer, audience, expiry and signature (plan
sec 1.8). Everything else that rule lists (nonce equality, `auth_time` freshness, the `acr` allowlist,
`"pop" in amr`, `jti` reuse) needs the pending approval row and belongs to whatever calls this module.

Fails closed throughout: a JWKS fetch that errors, times out or returns something malformed becomes
``TokenInvalid("jwks_unreachable")``, never an unhandled ``httpx`` or ``json`` exception.
"""

import time
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlencode

import httpx
import jwt

from ..config import Settings

AUTHORIZE_PATH = "/api/v1/authorize"
EXCHANGE_PATH = "/api/v1/token"
JWKS_PATH = "/.well-known/jwks.json"
JWKS_TTL_S = 600.0


class TokenInvalid(Exception):
    """The ID token (or the code exchange that produced it) cannot be trusted. ``reason`` is a short,
    stable code a caller can branch or log on, e.g. ``"jwks_unreachable"``, ``"world_unreachable"``,
    ``"unknown_kid"``, ``"token_expired"``, ``"token_invalid"``, ``"code_exchange_failed"``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class IdClaims:
    sub: str
    auth_time: int
    acr: str | None
    amr: tuple[str, ...]
    jti: str
    nonce: str


def _redirect_uri(settings: Settings) -> str:
    return f"{settings.public_origin}/v0/world/callback"


def authorize_url(settings: Settings, *, state: str, nonce: str, code_challenge: str) -> str:
    """The URL to send the browser to for a step-up approval. Always a fresh login (``max_age=0``,
    ``prompt=login``): a passkey session from ten minutes ago does not count as a new human decision."""
    assert settings.world_idp_client_id, "world_idp_enabled must be checked before building this URL"
    query = urlencode(
        {
            "client_id": settings.world_idp_client_id,
            "redirect_uri": _redirect_uri(settings),
            "response_type": "code",
            "scope": "openid",
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "max_age": "0",
            "prompt": "login",
        }
    )
    return f"{settings.world_idp_issuer}{AUTHORIZE_PATH}?{query}"


async def exchange_code(settings: Settings, http: httpx.AsyncClient, code: str, verifier: str) -> str:
    """Trades the authorization code for an ID token. World's client is registered `client_secret_post`
    (plan Global Constraints), so the secret goes in the form body, not a header.

    Fails closed the same way `JwksCache._fetch` does: a connection error, timeout or other transport
    failure talking to World becomes `TokenInvalid("world_unreachable")` rather than a bare `httpx.HTTPError`
    escaping to the caller (fix-round Important #2 — this used to propagate past the callback's `except
    TokenInvalid`, leaving the approval `pending` and the browser with a raw 500 instead of a `failed`
    redirect)."""
    assert settings.world_idp_client_id and settings.world_idp_client_secret
    try:
        reply = await http.post(
            f"{settings.world_idp_issuer}{EXCHANGE_PATH}",
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.world_idp_client_id,
                "client_secret": settings.world_idp_client_secret.get_secret_value(),
                "code": code,
                "redirect_uri": _redirect_uri(settings),
                "code_verifier": verifier,
                "grant_type": "authorization_code",
            },
        )
    except httpx.HTTPError as exc:
        raise TokenInvalid("world_unreachable") from exc
    try:
        raw_body: Any = reply.json()
    except ValueError as exc:
        raise TokenInvalid("code_exchange_failed") from exc
    body = cast("dict[str, Any]", raw_body) if isinstance(raw_body, dict) else {}
    id_token = body.get("id_token")
    if reply.status_code != 200 or not isinstance(id_token, str) or not id_token:
        raise TokenInvalid("code_exchange_failed")
    return id_token


class JwksCache:
    """World's signing keys, fetched from ``{issuer}/.well-known/jwks.json`` and cached for ten minutes.
    A ``kid`` the cache has not seen (key rotation) triggers exactly one refetch; still missing after that
    is treated as unknown, not retried further."""

    def __init__(self, issuer: str, *, ttl_s: float = JWKS_TTL_S) -> None:
        self._issuer = issuer
        self._ttl_s = ttl_s
        self._keys: dict[str, dict[str, Any]] | None = None
        self._fetched_at: float = 0.0

    def _stale(self) -> bool:
        return self._keys is None or (time.monotonic() - self._fetched_at) >= self._ttl_s

    async def _fetch(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=10) as http:
                reply = await http.get(f"{self._issuer}{JWKS_PATH}")
            reply.raise_for_status()
            raw_body: Any = reply.json()
            raw_keys = cast(Any, raw_body["keys"]) if isinstance(raw_body, dict) else None
            if not isinstance(raw_keys, list):
                raise TypeError("jwks response has no `keys` list")
            keys = cast("list[Any]", raw_keys)
            fetched: dict[str, dict[str, Any]] = {
                cast(str, key["kid"]): cast("dict[str, Any]", key)
                for key in keys
                if isinstance(key, dict) and isinstance(cast(Any, key).get("kid"), str)
            }
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
            raise TokenInvalid("jwks_unreachable") from exc
        self._keys = fetched
        self._fetched_at = time.monotonic()

    async def key_for(self, kid: str) -> jwt.PyJWK:
        if self._stale():
            await self._fetch()
        if self._keys is not None and kid not in self._keys:
            await self._fetch()  # the key may have rotated in since our last fetch; try exactly once more
        raw = (self._keys or {}).get(kid)
        if raw is None:
            raise TokenInvalid("unknown_kid")
        try:
            return jwt.PyJWK.from_dict(raw)
        except jwt.PyJWTError as exc:
            # `PyJWK.from_dict` raises `InvalidKeyError` for most malformed shapes (missing `kty`, a
            # non-base64 `n`, wrong curve fields, ...) and `PyJWKError` for others; neither is a subclass
            # of the other, so the common base is what actually makes this catch-all fail closed.
            raise TokenInvalid("malformed_jwks_key") from exc


async def verify_id_token(settings: Settings, jwks: JwksCache, token: str, *, now: int) -> IdClaims:
    """Checks of plan sec 1.8 that need no database row: RS256 only (an `alg: none` or `alg: HS256` token
    is refused by the `algorithms=["RS256"]` allowlist below, whatever its `kid` claims), `iss`, `aud`,
    signature, and expiry judged against the caller's own clock (`now`) rather than this process's, so a
    caller can replay a fixed moment consistently across a whole approval decision."""
    assert settings.world_idp_client_id
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise TokenInvalid("malformed_token") from exc
    kid = header.get("kid")
    if not isinstance(kid, str):
        raise TokenInvalid("missing_kid")
    key = await jwks.key_for(kid)
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.world_idp_client_id,
            issuer=settings.world_idp_issuer,
            leeway=60,
            options={"verify_exp": False},  # exp is checked below, against the caller's `now`
        )
    except jwt.InvalidTokenError as exc:
        raise TokenInvalid("token_invalid") from exc

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp <= now - 60:
        raise TokenInvalid("token_expired")

    sub, jti, nonce = payload.get("sub"), payload.get("jti"), payload.get("nonce")
    auth_time = payload.get("auth_time")
    if not isinstance(sub, str) or not isinstance(jti, str) or not isinstance(nonce, str):
        raise TokenInvalid("claims_missing")
    if not isinstance(auth_time, (int, float)):
        raise TokenInvalid("claims_missing")
    acr = payload.get("acr")
    amr_raw: Any = payload.get("amr")
    amr = tuple(str(value) for value in cast("list[Any]", amr_raw)) if isinstance(amr_raw, list) else ()
    return IdClaims(
        sub=sub,
        auth_time=int(auth_time),
        acr=acr if isinstance(acr, str) else None,
        amr=amr,
        jti=jti,
        nonce=nonce,
    )
