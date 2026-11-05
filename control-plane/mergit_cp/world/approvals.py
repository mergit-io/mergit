"""Agent Pass approval lifecycle (plan sec 1.5-1.8): the `pending -> approved|denied|failed -> consumed`
state machine for a human-approval checkpoint before an agent spends. This module owns the database and the
application-level checks on a verified ID token (nonce, freshness, acr allowlist, proof-of-presence, jti
reuse, the `world_links` sub-to-account binding); it does not know what a plan or a pull request is — callers
(`routes_plans.approve_plan`, and later an `open-pr` route) pass in `kind`/`plan_uuid`/`fields` and get back
an opaque approval to gate on.

Fails closed throughout: anything that is not a clean, freshly-verified, correctly-bound approval is
`denied` or `failed`, never silently treated as `approved`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from uuid import UUID

import psycopg.errors
from fastapi import HTTPException
from psycopg import AsyncConnection
from psycopg.rows import TupleRow
from psycopg.types.json import Jsonb

from ..config import Settings
from ..db import Pool
from ..oauth import pkce_pair
from .idp import IdClaims

Conn = AsyncConnection[TupleRow]

# Agent Pass accepts any verified class (plan sec 1.2): Orb or Selfie Check, device or face flow.
ACR_ALLOWLIST = frozenset({"orb", "orb-face", "selfie", "selfie-face"})

# `create_approval`/`consume` take `kind: str` per the brief; `action_hash` takes the narrower literal that
# the schema's CHECK constraint also enforces. The cast below bridges the two without loosening either.
Kind = Literal["approve_plan", "open_pr"]


class ApprovalInvalid(Exception):
    """The approval named by `X-World-Approval` cannot be used for this action right now. `reason` is one of
    `expired | denied | failed | used | action_mismatch | not_yours` (plan sec 1.7), stable enough for a
    caller to map straight onto the `403 human_approval_invalid` body."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class PendingApproval:
    approval_id: UUID
    expires_at: datetime
    summary: dict[str, Any]

    def required_error(self) -> HTTPException:
        """The `428` body of plan sec 1.7, telling the browser where to send the human."""
        return HTTPException(
            status_code=428,
            detail={
                "code": "human_approval_required",
                "approval_id": str(self.approval_id),
                "start_url": f"/v0/world/approvals/{self.approval_id}/start",
                "expires_at": self.expires_at.isoformat(),
                "summary": self.summary,
            },
        )


def action_hash(kind: Kind, fields: dict[str, Any]) -> str:
    """`sha256(json.dumps({"kind": kind, **fields}, sort_keys=True, separators=(",", ":")))` hex (plan sec
    1.6): the same action approved twice hashes the same; any changed field (budget, agents, funding, the
    diff for `open_pr`) hashes differently, which is what makes `consume` refuse a changed action."""
    canonical = json.dumps({"kind": kind, **fields}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def pkce_challenge(verifier: str) -> str:
    """The S256 PKCE challenge for a verifier `begin` already generated and persisted. `begin`'s return type
    is fixed at `(state, nonce, verifier)` (so its one caller, `GET /start`, can build the authorize URL),
    so the challenge is recomputed here from the verifier rather than threaded through as a fourth value;
    the S256 formula is deterministic, so this costs one extra SHA-256, nothing else."""
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


async def create_approval(
    pool: Pool,
    settings: Settings,
    *,
    user_id: UUID,
    kind: str,
    plan_uuid: UUID,
    fields: dict[str, Any],
    summary: dict[str, Any],
) -> PendingApproval:
    """Opens its own connection and transaction (Review Focus 1): the caller raises `428` from inside its
    own transaction right after this returns, and that transaction may roll back (nothing was approved), but
    this row must still be there afterwards so the browser's retry against `start_url` has something to
    find."""
    computed_hash = action_hash(cast(Kind, kind), fields)
    expires_at = datetime.now(UTC) + timedelta(seconds=settings.world_approval_ttl_s)
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "INSERT INTO world_approvals (user_id, kind, plan_uuid, action_hash, summary, expires_at)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING approval_id, expires_at",
            (user_id, kind, plan_uuid, computed_hash, Jsonb(summary), expires_at),
        )
        row = await cur.fetchone()
    assert row is not None
    return PendingApproval(approval_id=cast(UUID, row[0]), expires_at=cast(datetime, row[1]), summary=summary)


_BEGIN_REASON = {"approved": "used", "consumed": "used", "denied": "denied", "failed": "failed"}


async def begin(conn: Conn, approval_id: UUID, user_id: UUID) -> tuple[str, str, str]:
    """`GET /start` hands the browser off to World. Sets a fresh OIDC `state`/`nonce` and PKCE `verifier` on
    the approval row and returns them, so the callback can look the row up by `state` later. Only the owner
    may start a flow for an approval, and only while it is still `pending` and unexpired."""
    cur = await conn.execute(
        "SELECT status, expires_at, user_id FROM world_approvals WHERE approval_id = %s FOR UPDATE",
        (approval_id,),
    )
    row = await cur.fetchone()
    if row is None or row[2] != user_id:
        raise ApprovalInvalid("not_yours")
    status, expires_at = cast(str, row[0]), cast(datetime, row[1])
    if status == "pending" and expires_at <= datetime.now(UTC):
        raise ApprovalInvalid("expired")
    if status != "pending":
        raise ApprovalInvalid(_BEGIN_REASON[status])
    state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    verifier, _ = pkce_pair()
    await conn.execute(
        "UPDATE world_approvals SET state = %s, nonce = %s, code_verifier = %s WHERE approval_id = %s",
        (state, nonce, verifier, approval_id),
    )
    return state, nonce, verifier


async def _link_sub(conn: Conn, user_id: UUID, sub: str) -> str | None:
    """The first approval links `sub` to the account; a later one must present the same `sub`; a `sub`
    already linked to a *different* account is denied, never silently re-linked (plan sec 1.8). Returns a
    denial reason, or `None` on a clean link-or-match."""
    cur = await conn.execute("SELECT sub FROM world_links WHERE user_id = %s", (user_id,))
    row = await cur.fetchone()
    if row is not None:
        return None if row[0] == sub else "different_human"
    try:
        # A savepoint: a `UniqueViolation` here must not poison the outer transaction that the rest of
        # `record` still has work to do in (the final status/reason UPDATE).
        async with conn.transaction():
            await conn.execute("INSERT INTO world_links (user_id, sub) VALUES (%s, %s)", (user_id, sub))
    except psycopg.errors.UniqueViolation:
        return "linked_to_another_account"
    return None


async def _finish(
    conn: Conn,
    approval_id: UUID,
    *,
    status: str,
    reason: str | None,
    sub: str | None,
    acr: str | None,
    auth_time: datetime | None,
    jti: str | None,
    now: datetime,
) -> str:
    """Commits the decision. `world_approvals.jti` is `UNIQUE`: a token that already decided one approval
    cannot also decide another, however clean everything else about it looks, so a conflict here overrides
    whatever `status` was about to be recorded — including `approved` — with `denied`/`replayed_jti`."""
    try:
        async with conn.transaction():  # savepoint, same reason as `_link_sub`
            await conn.execute(
                "UPDATE world_approvals SET status = %s, reason = %s, sub = %s, acr = %s,"
                " auth_time = %s, jti = %s, decided_at = %s WHERE approval_id = %s",
                (status, reason, sub, acr, auth_time, jti, now, approval_id),
            )
    except psycopg.errors.UniqueViolation:
        status, reason, jti = "denied", "replayed_jti", None
        await conn.execute(
            "UPDATE world_approvals SET status = %s, reason = %s, sub = %s, acr = %s,"
            " auth_time = %s, jti = %s, decided_at = %s WHERE approval_id = %s",
            (status, reason, sub, acr, auth_time, jti, now, approval_id),
        )
    return status


async def record(
    conn: Conn, state: str, claims: IdClaims | None, error: str | None, settings: Settings, now: datetime
) -> tuple[UUID, str]:
    """Applies the callback's outcome to the pending row named by `state` (plan sec 1.8):
    - `error` (no `claims`): `access_denied` (the human cancelled at World) is `denied`; anything else
      (a non-2xx code exchange, World unreachable, `idp.TokenInvalid`) is `failed` — fail closed.
    - `claims`: nonce must equal the row's, `acr` must be in the allowlist, `"pop"` must be in `amr`,
      `auth_time` must be fresh (`>= created_at - 5s` and `now - auth_time <= world_max_auth_age_s`), and the
      token's `sub` must link-or-match `world_links` for this account — any failure here is `denied`, not
      `failed`: the token itself was genuine, the human (or the binding) just isn't the right one.
    Re-delivery of an already-decided `state` (a duplicate callback hit) is a no-op that returns the
    existing decision rather than re-running any of this.
    """
    cur = await conn.execute(
        "SELECT approval_id, user_id, nonce, created_at, status FROM world_approvals"
        " WHERE state = %s FOR UPDATE",
        (state,),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApprovalInvalid("not_yours")
    approval_id = cast(UUID, row[0])
    user_id = cast(UUID, row[1])
    nonce = cast(str, row[2])
    created_at = cast(datetime, row[3])
    status = cast(str, row[4])
    if status != "pending":
        return approval_id, status

    if claims is None:
        new_status = "denied" if error == "access_denied" else "failed"
        reason = error or "world_unreachable"
        await conn.execute(
            "UPDATE world_approvals SET status = %s, reason = %s, decided_at = %s WHERE approval_id = %s",
            (new_status, reason, now, approval_id),
        )
        return approval_id, new_status

    denial: str | None = None
    if claims.nonce != nonce:
        denial = "nonce_mismatch"
    elif claims.acr not in ACR_ALLOWLIST:
        denial = "acr_not_allowed"
    elif "pop" not in claims.amr:
        denial = "missing_pop"
    auth_time_dt = datetime.fromtimestamp(claims.auth_time, tz=UTC)
    if denial is None and auth_time_dt < created_at - timedelta(seconds=5):
        denial = "stale_auth_time"
    if denial is None and now - auth_time_dt > timedelta(seconds=settings.world_max_auth_age_s):
        denial = "stale_auth_time"
    if denial is None:
        denial = await _link_sub(conn, user_id, claims.sub)

    final_status = await _finish(
        conn,
        approval_id,
        status="approved" if denial is None else "denied",
        reason=denial,
        sub=claims.sub,
        acr=claims.acr,
        auth_time=auth_time_dt,
        jti=claims.jti,
        now=now,
    )
    return approval_id, final_status


async def consume(
    conn: Conn,
    approval_id: UUID,
    *,
    user_id: UUID,
    kind: str,
    plan_uuid: UUID,
    fields: dict[str, Any],
    now: datetime,
) -> None:
    """Redeems the approval inside the caller's own transaction for the protected action (plan sec 1.8): one
    atomic `UPDATE ... WHERE status = 'approved' ...` so two concurrent redemptions cannot both succeed — the
    loser's `WHERE` simply matches zero rows once the winner's update has landed. On that miss, a read-only
    follow-up query works out *why*, for a precise `ApprovalInvalid.reason`."""
    computed_hash = action_hash(cast(Kind, kind), fields)
    cur = await conn.execute(
        "UPDATE world_approvals SET status = 'consumed', consumed_at = %s"
        " WHERE approval_id = %s AND status = 'approved' AND expires_at > %s"
        " AND action_hash = %s AND user_id = %s AND kind = %s AND plan_uuid = %s"
        " RETURNING approval_id",
        (now, approval_id, now, computed_hash, user_id, kind, plan_uuid),
    )
    if await cur.fetchone() is not None:
        return

    cur = await conn.execute(
        "SELECT status, expires_at, action_hash, user_id, kind, plan_uuid FROM world_approvals"
        " WHERE approval_id = %s",
        (approval_id,),
    )
    row = await cur.fetchone()
    if row is None:
        raise ApprovalInvalid("not_yours")
    status, expires_at, stored_hash = cast(str, row[0]), cast(datetime, row[1]), cast(str, row[2])
    stored_user, stored_kind, stored_plan = cast(UUID, row[3]), cast(str, row[4]), cast(UUID, row[5])
    if stored_user != user_id or stored_kind != kind or stored_plan != plan_uuid:
        raise ApprovalInvalid("not_yours")
    if status == "consumed":
        raise ApprovalInvalid("used")
    if status == "approved" and stored_hash != computed_hash:
        raise ApprovalInvalid("action_mismatch")
    if expires_at <= now:
        raise ApprovalInvalid("expired")
    if status == "denied":
        raise ApprovalInvalid("denied")
    if status == "failed":
        raise ApprovalInvalid("failed")
    # `status == "pending"` (not decided yet) or `"approved"` with a matching hash that still missed the
    # atomic update above (a concurrent redemption won the race): neither is one of the named reasons, and
    # both mean "not a usable, decided-and-matching approval right now".
    raise ApprovalInvalid("failed")
