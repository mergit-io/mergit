"""World ID (plan `docs/superpowers/plans/2026-11-05-world-human-checkpoints.md`): IDKit proof-of-human for
the free trial and Agent Pass OIDC human-approval checkpoints before a plan is approved or a PR is opened.

This PR lands the Agent Pass half of plan sec 1.7: a protected action (`routes_plans.approve_plan`, and
later `open-pr`) creates a pending `world_approvals` row and tells the browser where to send the human
(`start_url`); these three routes carry that row through World's login and report the outcome back. The
browser never sees an ID token or the client secret — it only ever carries an opaque `approval_id`.
"""

import hmac
import time
from datetime import UTC, datetime
from typing import Annotated, cast
from uuid import UUID

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from .auth import PoolDep, PrincipalDep, SettingsDep
from .config import Settings
from .world import approvals, idp, rp_sign

router = APIRouter(prefix="/v0/world", tags=["world"])

STATE_COOKIE = "mergit_world"


def _invalid(invalid: approvals.ApprovalInvalid) -> HTTPException:
    return HTTPException(status_code=403, detail={"code": "human_approval_invalid", "reason": invalid.reason})


def _jwks_cache(request: Request, settings: Settings) -> idp.JwksCache:
    """One `JwksCache` per running app (`request.app.state`), so World's signing keys are fetched at most
    once per ten minutes per process rather than once per callback. Tests build a fresh `FastAPI` app (and so
    a fresh, empty `app.state`) per test, which keeps this cache from leaking JWKS responses between tests."""
    cache = getattr(request.app.state, "world_jwks", None)
    if not isinstance(cache, idp.JwksCache):
        cache = idp.JwksCache(settings.world_idp_issuer)
        request.app.state.world_jwks = cache
    return cache


@router.get("/approvals/{approval_id}/start")
async def start_approval(
    approval_id: UUID, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> RedirectResponse:
    """Sends the browser to World for a fresh (`max_age=0`, `prompt=login`) sign-in, with an HttpOnly cookie
    binding this browser to the `state` the callback must see again (plan sec 1.7)."""
    if not settings.world_idp_enabled:
        raise HTTPException(status_code=404, detail="agent pass is not configured")
    if principal.user_id is None:
        raise HTTPException(status_code=401, detail="sign in again")
    async with pool.connection() as conn, conn.transaction():
        try:
            state, nonce, verifier = await approvals.begin(conn, approval_id, principal.user_id)
        except approvals.ApprovalInvalid as invalid:
            raise _invalid(invalid) from invalid
    url = idp.authorize_url(
        settings, state=state, nonce=nonce, code_challenge=approvals.pkce_challenge(verifier)
    )
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=settings.world_approval_ttl_s,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/v0/world",
        # Shared by every hostname the site is served on, the same as `oauth.start`'s state cookie: the popup
        # opens `/start` on whichever host the page is on (mergit.site or app.mergit.site), but World sends it
        # back to `public_origin` (app_domain) only. Host-only, the cookie set on mergit.site never reaches
        # the callback on app.mergit.site and every approval started there fails the state check.
        domain=settings.cookie_domain,
    )
    return response


def _back_to_popup(settings: Settings, approval_id: UUID, status: str) -> RedirectResponse:
    response = RedirectResponse(
        f"{settings.public_origin}/world/approved?approval={approval_id}&status={status}", status_code=302
    )
    # A cookie set with a domain is only cleared by a deletion naming the same domain (and path).
    response.delete_cookie(
        STATE_COOKIE,
        path="/v0/world",
        domain=settings.cookie_domain,
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


@router.get("/callback")
async def callback(
    request: Request,
    settings: SettingsDep,
    pool: PoolDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    mergit_world: Annotated[str | None, Cookie()] = None,
) -> RedirectResponse:
    """Validates, records, then redirects to the SPA route that `postMessage`s the result back to the popup's
    opener (plan sec 1.7). No inline script and no ID token are ever served by this endpoint.

    No pool connection is held while World is on the line: the code exchange and a JWKS fetch can each take
    up to ten seconds, and holding a connection (and an open transaction) across them would let a burst of
    callbacks, or one slow World, starve every other endpoint of the pool -- the bug `approve_plan` already
    had fixed. So: one short read (the PKCE verifier, and whether this approval is still undecided), the
    network calls with no connection checked out, then a second short transaction for the write. `record`
    re-reads the row `FOR UPDATE` and leaves an already-decided one alone, so a duplicate callback whose own
    exchange failed cannot turn an approval another request already recorded into `failed`."""
    if not state or not mergit_world or not hmac.compare_digest(state, mergit_world):
        raise HTTPException(status_code=400, detail="missing or mismatched World sign-in state")

    now = datetime.now(UTC)
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT approval_id, status, code_verifier FROM world_approvals WHERE state = %s", (state,)
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=400, detail="unknown World sign-in state")
    approval_id, status, verifier = cast(UUID, row[0]), cast(str, row[1]), cast("str | None", row[2])
    if status != "pending":
        # Already decided (a re-delivered or duplicate callback): report that decision, and do not spend a
        # second code exchange on it -- World would refuse a reused code anyway.
        return _back_to_popup(settings, approval_id, status)

    claims: idp.IdClaims | None = None
    world_error = error
    if world_error is None:
        if not code:
            world_error = "no_code"
        elif verifier is None:
            raise HTTPException(status_code=400, detail="unknown World sign-in state")
        else:
            try:
                async with httpx.AsyncClient(timeout=10) as http:
                    id_token = await idp.exchange_code(settings, http, code, verifier)
                claims = await idp.verify_id_token(
                    settings, _jwks_cache(request, settings), id_token, now=int(time.time())
                )
            except idp.TokenInvalid as invalid:
                world_error = invalid.reason

    async with pool.connection() as conn, conn.transaction():
        try:
            approval_id, status = await approvals.record(conn, state, claims, world_error, settings, now)
        except approvals.ApprovalInvalid as invalid:
            raise HTTPException(status_code=400, detail="unknown World sign-in state") from invalid

    return _back_to_popup(settings, approval_id, status)


@router.get("/approvals/{approval_id}")
async def approval_status(approval_id: UUID, principal: PrincipalDep, pool: PoolDep) -> dict[str, object]:
    """For polling when the popup cannot `postMessage` back (plan sec 1.7). Owner only: a 404 whether the
    approval does not exist or belongs to someone else, never revealing which."""
    if principal.user_id is None:
        raise HTTPException(status_code=401, detail="sign in again")
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT status, reason, expires_at FROM world_approvals WHERE approval_id = %s AND user_id = %s",
            (approval_id, principal.user_id),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="no such approval")
    return {"status": row[0], "reason": row[1], "expires_at": row[2]}


@router.get("/config")
async def world_config(settings: SettingsDep) -> dict[str, dict[str, object]]:
    """Public, no session required: what the frontend needs to decide whether to show IDKit's free-trial
    sybil check or Agent Pass's human-approval popup at all, before anyone is signed in. Carries only
    IDKit's public params (sec 1.2/1.3 -- `app_id`, `rp_id`, `action`, `preset`, none of them secret) and a
    bare bool for Agent Pass. `rp_id` identifies the IDKit app to World's client-side SDK the same way
    `app_id` does, and the installed `@worldcoin/idkit` widget requires it to open at all. Never
    `world_signing_key`, `world_idp_client_id` or `world_idp_client_secret`: the client secret stays
    server-side and the browser never needs the OIDC client id, since `/approvals/{id}/start` builds
    World's authorize URL itself."""
    return {
        "idkit": {
            "enabled": settings.world_idkit_enabled,
            "app_id": settings.world_app_id,
            "rp_id": settings.world_rp_id,
            "action": settings.world_trial_action,
            "preset": settings.world_trial_preset,
        },
        "agent_pass": {"enabled": settings.world_idp_enabled},
    }


class RpContextRequest(BaseModel):
    """`action`, when given, must name the free trial's own action -- the only action this endpoint will
    ever sign for. Anything else is refused outright (422) rather than silently coerced, so this can never
    become a way for a caller to mint a signature for an action of their choosing."""

    action: str | None = None


@router.post("/rp-context")
async def rp_context(
    principal: PrincipalDep, settings: SettingsDep, body: RpContextRequest | None = None
) -> dict[str, str | int]:
    """Signs a fresh World ID RP context (sec 1.2/2.x) for the free trial's sybil check. Requires a live
    session (`PrincipalDep`) purely to keep this from being a free, unauthenticated signing oracle --
    the signature itself says nothing about who is signed in, and World checks the proof, not this call."""
    if principal.user_id is None:
        raise HTTPException(status_code=401, detail="sign in again")
    action = body.action if body is not None else None
    if action is not None and action != settings.world_trial_action:
        raise HTTPException(status_code=422, detail="unsupported action")
    if not settings.world_idkit_enabled:
        raise HTTPException(status_code=404, detail="world id is not configured")
    assert settings.world_signing_key is not None  # guaranteed by world_idkit_enabled
    context = rp_sign.sign_rp_request(
        settings.world_signing_key.get_secret_value(), settings.world_trial_action, now=int(time.time())
    )
    return context.to_json()
