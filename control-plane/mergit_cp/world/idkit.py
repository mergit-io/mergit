"""IDKit verification (plan sec 1.2/1.3): forwards a World ID proof to World's cloud verify endpoint,
checks it was issued for Mergit's own action and environment, and claims its nullifier -- the mechanism
behind "one free trial per human" (`accounts.credits_forfeited` only catches a deleted account's own
sign-in methods; a World nullifier survives account deletion because `world_nullifiers` has no FK cascade
on `user_id`, only `ON DELETE SET NULL`).

The `proof` dict this module's caller passes in is exactly what IDKit's widget hands `handleVerify` on a
successful verification -- its `ISuccessResult`: `merkle_root`, `proof`, `nullifier_hash` and
`credential_type` ("orb" | "device" | ...). It is forwarded to World's verify endpoint byte-for-byte;
nothing here edits or augments it before sending. World's JSON reply is what is trusted to say which
`action` and `environment` the proof was actually checked against (never values the caller merely
asserts), whether it says `success`, and optionally a `sybil_score`; those are the only fields this module
reads from the reply. `credential_type` comes off the proof itself -- it is a property of what the human
already verified with, not something World's check re-derives.

Fails closed throughout: a transport error talking to World becomes `ProofRejected("world_unreachable")`,
never a bare `httpx.HTTPError` escaping to a caller, the same contract `world/idp.py` upholds for Agent
Pass's token exchange and JWKS fetch.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

import httpx
from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from ..config import Settings

Conn = AsyncConnection[TupleRow]

VERIFY_PATH = "/api/v4/verify"


class ProofRejected(Exception):
    """The World ID proof cannot be trusted for this action. `reason` is one of `world_rejected`
    (World said the proof itself does not check out), `wrong_environment`, `wrong_action` (World checked
    it against a different action or environment than the one Mergit asked about), `sybil_score` (above
    `world_max_sybil_score`), `malformed_proof` (missing or unparseable fields), or `world_unreachable`."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class VerifiedProof:
    nullifier: int
    credential: str
    environment: str
    sybil_score: int | None


def _parse_nullifier(raw: object) -> int:
    """World's `nullifier_hash` is a hex-encoded field element (e.g. `"0x1a2b..."`), big enough that it
    never fits an int8 -- hence `world_nullifiers.nullifier` is `numeric(78,0)`, not `bigint`."""
    if isinstance(raw, bool):  # bool is an int subclass; never a valid nullifier
        raise ProofRejected("malformed_proof")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and raw:
        try:
            return int(raw, 16) if raw.lower().startswith("0x") else int(raw)
        except ValueError as exc:
            raise ProofRejected("malformed_proof") from exc
    raise ProofRejected("malformed_proof")


async def verify_proof(
    settings: Settings, http: httpx.AsyncClient, proof: dict[str, Any], *, action: str
) -> VerifiedProof:
    """Posts `proof` to World's `POST {world_verify_base}/api/v4/verify/{world_rp_id}` unchanged and
    returns what World verified it as. Enforces `world_max_sybil_score` only when it is set *and* World's
    reply actually carries a `sybil_score` -- a deployment that never set the cap, or a reply that is
    silent on the field, is not rejected on it."""
    assert settings.world_rp_id, "world_idkit_enabled must be checked before calling this"
    url = f"{settings.world_verify_base.rstrip('/')}{VERIFY_PATH}/{settings.world_rp_id}"
    try:
        reply = await http.post(url, json=proof, timeout=10)
    except httpx.HTTPError as exc:
        raise ProofRejected("world_unreachable") from exc
    try:
        raw_body: Any = reply.json()
    except ValueError as exc:
        raise ProofRejected("world_rejected") from exc
    body = cast("dict[str, Any]", raw_body) if isinstance(raw_body, dict) else {}
    if reply.status_code != 200 or body.get("success") is not True:
        raise ProofRejected("world_rejected")

    environment = body.get("environment")
    if not isinstance(environment, str) or environment != settings.world_environment:
        raise ProofRejected("wrong_environment")

    reply_action = body.get("action")
    if not isinstance(reply_action, str) or reply_action != action:
        raise ProofRejected("wrong_action")

    nullifier = _parse_nullifier(body.get("nullifier_hash"))

    credential = proof.get("credential_type")
    if not isinstance(credential, str) or not credential:
        raise ProofRejected("malformed_proof")

    sybil_score_raw = body.get("sybil_score")
    sybil_score: int | None = None
    if isinstance(sybil_score_raw, (int, float)) and not isinstance(sybil_score_raw, bool):
        sybil_score = int(sybil_score_raw)
    if (
        settings.world_max_sybil_score is not None
        and sybil_score is not None
        and sybil_score > settings.world_max_sybil_score
    ):
        raise ProofRejected("sybil_score")

    return VerifiedProof(
        nullifier=nullifier, credential=credential, environment=environment, sybil_score=sybil_score
    )


async def claim_nullifier(conn: Conn, action: str, proof: VerifiedProof, user_id: UUID) -> bool:
    """Claims `proof.nullifier` for `user_id` under `action`. False when that (action, nullifier) pair is
    already claimed -- by anyone, including a now-deleted account (the row has no FK cascade, so it
    outlives the account that made it) -- which is exactly the sybil case this whole module exists to
    catch. Callers that want idempotent retries by the *same* human should check `has_claimed` first."""
    cur = await conn.execute(
        "INSERT INTO world_nullifiers (action, nullifier, user_id, credential, environment)"
        " VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING 1",
        (action, proof.nullifier, user_id, proof.credential, proof.environment),
    )
    return await cur.fetchone() is not None


async def has_claimed(conn: Conn, action: str, user_id: UUID) -> bool:
    """Whether `user_id` has already claimed a nullifier for `action`."""
    cur = await conn.execute(
        "SELECT 1 FROM world_nullifiers WHERE action = %s AND user_id = %s LIMIT 1", (action, user_id)
    )
    return await cur.fetchone() is not None
