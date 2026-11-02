"""GitHub and Google sign-in: OAuth 2.0 authorization code with PKCE, run entirely on the server.

The browser is sent to the provider and comes back to ``/v0/auth/{provider}/callback``. Two things stop a
login from being completed by anyone but the browser that started it: the ``state`` is single use and
expires, and it must also match an HttpOnly cookie set when the flow began. Every failure sends the browser
back to ``/signin?error=<code>`` and never reveals what the provider said.
"""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Response
from fastapi.responses import RedirectResponse

from . import accounts
from .auth import MaybePrincipalDep, PoolDep, SettingsDep
from .config import Settings

STATE_COOKIE = "mergit_oauth"
Name = Literal["github", "google"]

router = APIRouter(prefix="/v0/auth", tags=["auth"])


class LoginFailed(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class Person:
    subject: str
    label: str
    name: str | None
    email: str | None
    avatar: str | None


@dataclass(frozen=True, slots=True)
class Provider:
    name: Name
    authorize_url: str
    token_url: str
    scope: str
    extra_authorize: dict[str, str]


PROVIDERS: dict[str, Provider] = {
    "github": Provider(
        "github",
        "https://github.com/login/oauth/authorize",
        "https://github.com/login/oauth/access_token",
        "read:user user:email",
        {"allow_signup": "true"},
    ),
    "google": Provider(
        "google",
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "openid email profile",
        {"response_type": "code", "prompt": "select_account"},
    ),
}


def credentials(settings: Settings, name: str) -> tuple[str, str] | None:
    if name == "github" and settings.github_enabled:
        assert settings.github_client_id and settings.github_client_secret
        return settings.github_client_id, settings.github_client_secret.get_secret_value()
    if name == "google" and settings.google_enabled:
        assert settings.google_client_id and settings.google_client_secret
        return settings.google_client_id, settings.google_client_secret.get_secret_value()
    return None


def _redirect_uri(settings: Settings, name: str) -> str:
    return f"{settings.public_origin}/v0/auth/{name}/callback"


def _back(settings: Settings, to: str) -> RedirectResponse:
    response = RedirectResponse(f"{settings.public_origin}{to}", status_code=302)
    response.delete_cookie(
        STATE_COOKIE,
        path="/v0/auth",
        domain=settings.cookie_domain,
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


def _failed(settings: Settings, code: str) -> RedirectResponse:
    return _back(settings, f"/signin?error={code}")


@router.get("/providers")
async def providers(settings: SettingsDep) -> dict[str, bool]:
    return {
        "wallet": True,
        "github": settings.github_enabled,
        "google": settings.google_enabled,
        "email": settings.email_enabled,
    }


@router.get("/{provider}/start")
async def start(
    provider: str, settings: SettingsDep, pool: PoolDep, intent: accounts.Intent = "register"
) -> RedirectResponse:
    spec = PROVIDERS.get(provider)
    creds = credentials(settings, provider)
    if spec is None or creds is None:
        raise HTTPException(status_code=404, detail="that sign-in method is not set up")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    expires = datetime.now(UTC) + timedelta(seconds=settings.oauth_state_ttl_s)
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO oauth_states (state, provider, code_verifier, expires_at, intent)"
            " VALUES (%s, %s, %s, %s, %s)",
            (state, provider, verifier, expires, intent),
        )
    query = urlencode(
        {
            "client_id": creds[0],
            "redirect_uri": _redirect_uri(settings, provider),
            "scope": spec.scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            **spec.extra_authorize,
        }
    )
    response = RedirectResponse(f"{spec.authorize_url}?{query}", status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=settings.oauth_state_ttl_s,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/v0/auth",
        # Shared by both hostnames: a sign-in started on one comes back on the callback hostname, which is
        # the other one if it began there.
        domain=settings.cookie_domain,
    )
    return response


async def _exchange(
    spec: Provider, creds: tuple[str, str], settings: Settings, code: str, verifier: str
) -> str:
    async with httpx.AsyncClient(timeout=10) as http:
        reply = await http.post(
            spec.token_url,
            headers={"Accept": "application/json"},
            data={
                "client_id": creds[0],
                "client_secret": creds[1],
                "code": code,
                "redirect_uri": _redirect_uri(settings, spec.name),
                "code_verifier": verifier,
                "grant_type": "authorization_code",
            },
        )
        token = reply.json().get("access_token")
    if reply.status_code != 200 or not isinstance(token, str) or not token:
        raise LoginFailed("oauth_failed")
    return token


async def _github_person(token: str) -> Person:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=10, headers=headers) as http:
        user = (await http.get("https://api.github.com/user")).raise_for_status().json()
        email: str | None = None
        try:
            # Only an address GitHub marks primary and verified; the public profile email is not enough.
            listed = (await http.get("https://api.github.com/user/emails")).raise_for_status().json()
            email = next((e["email"] for e in listed if e.get("primary") and e.get("verified")), None)
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            email = None
    login = str(user["login"])
    return Person(str(user["id"]), login, user.get("name") or login, email, user.get("avatar_url"))


async def _google_person(token: str) -> Person:
    async with httpx.AsyncClient(timeout=10) as http:
        reply = await http.get(
            "https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {token}"}
        )
    info = reply.raise_for_status().json()
    if info.get("email_verified") is not True or not info.get("email"):
        raise LoginFailed("email_unverified")
    email = str(info["email"]).lower()
    return Person(str(info["sub"]), email, info.get("name"), email, info.get("picture"))


@router.get("/{provider}/callback")
async def callback(
    provider: str,
    settings: SettingsDep,
    pool: PoolDep,
    principal: MaybePrincipalDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    mergit_oauth: Annotated[str | None, Cookie()] = None,
) -> Response:
    spec = PROVIDERS.get(provider)
    creds = credentials(settings, provider)
    if spec is None or creds is None:
        raise HTTPException(status_code=404, detail="that sign-in method is not set up")
    try:
        if error:
            raise LoginFailed("oauth_denied")
        if not code or not state or not mergit_oauth or not hmac.compare_digest(state, mergit_oauth):
            raise LoginFailed("oauth_state")
        async with pool.connection() as conn:
            cur = await conn.execute(
                "UPDATE oauth_states SET used_at = now() WHERE state = %s AND provider = %s"
                " AND used_at IS NULL AND expires_at > now() RETURNING code_verifier, intent",
                (state, provider),
            )
            row = await cur.fetchone()
        if row is None:
            raise LoginFailed("oauth_state")
        try:
            token = await _exchange(spec, creds, settings, code, row[0])
            person = await (_github_person if provider == "github" else _google_person)(token)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise LoginFailed("oauth_failed") from exc

        link_to = principal.user_id if principal else None
        async with pool.connection() as conn, conn.transaction():
            if (
                row[1] == "login"
                and link_to is None
                and not await accounts.identity_exists(conn, spec.name, person.subject)
            ):
                raise LoginFailed("no_account")
            try:
                user_id = await accounts.sign_in_identity(
                    conn,
                    spec.name,
                    person.subject,
                    label=person.label,
                    name=person.name,
                    email=person.email,
                    avatar=person.avatar,
                    link_to=link_to,
                )
            except accounts.IdentityTaken as taken:
                raise LoginFailed("identity_taken") from taken
            token_value = None
            if principal is None or principal.user_id != user_id:
                address = await accounts.default_address(conn, user_id)
                token_value = await accounts.create_session(conn, settings, user_id, address)
    except LoginFailed as failure:
        return _failed(settings, failure.code)
    response = _back(settings, "/app")
    if token_value is not None:
        accounts.set_session_cookie(response, settings, token_value)
    return response
