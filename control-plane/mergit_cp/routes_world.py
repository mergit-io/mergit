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
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Request
from fastapi.responses import RedirectResponse

from .auth import PoolDep, PrincipalDep, SettingsDep
from .config import Settings
from .world import approvals, idp

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
    opener (plan sec 1.7). No inline script and no ID token are ever served by this endpoint."""
    if not state or not mergit_world or not hmac.compare_digest(state, mergit_world):
        raise HTTPException(status_code=400, detail="missing or mismatched World sign-in state")

    now = datetime.now(UTC)
    claims: idp.IdClaims | None = None
    world_error = error

    async with pool.connection() as conn, conn.transaction():
        if world_error is None:
            if not code:
                world_error = "no_code"
            else:
                cur = await conn.execute(
                    "SELECT code_verifier FROM world_approvals WHERE state = %s", (state,)
                )
                row = await cur.fetchone()
                if row is None or row[0] is None:
                    raise HTTPException(status_code=400, detail="unknown World sign-in state")
                verifier = row[0]
                try:
                    async with httpx.AsyncClient(timeout=10) as http:
                        id_token = await idp.exchange_code(settings, http, code, verifier)
                    claims = await idp.verify_id_token(
                        settings, _jwks_cache(request, settings), id_token, now=int(time.time())
                    )
                except idp.TokenInvalid as invalid:
                    world_error = invalid.reason
        try:
            approval_id, status = await approvals.record(conn, state, claims, world_error, settings, now)
        except approvals.ApprovalInvalid as invalid:
            raise HTTPException(status_code=400, detail="unknown World sign-in state") from invalid

    response = RedirectResponse(
        f"{settings.public_origin}/world/approved?approval={approval_id}&status={status}", status_code=302
    )
    response.delete_cookie(STATE_COOKIE, path="/v0/world")
    return response


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
