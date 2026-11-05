"""IDKit verification (plan sec 1.2/1.3): forwards a World ID proof to World's cloud verify endpoint,
checks it was issued for Mergit's own action, environment, protocol version and credential, and claims its
nullifier -- the mechanism behind "one free trial per human" (`accounts.credits_forfeited` only catches a
deleted account's own sign-in methods; a World nullifier survives account deletion because
`world_nullifiers` has no FK cascade on `user_id`, only `ON DELETE SET NULL`).

The contract, as World publishes it (checked 2026-11-06 against `@worldcoin/idkit-core@4.6.0`'s
`IDKitResultV4` type and `https://docs.world.org/api-reference/developer-portal/verify`, whose examples are
kept verbatim in `tests/fixtures/world_verify_examples.json`):

* The `proof` this module's caller passes in is exactly what IDKit 4.x's widget hands `handleVerify`, an
  `IDKitResult`: `{protocol_version: "4.0", nonce, action, environment, responses: [{identifier,
  issuer_schema_id, nullifier, proof: [5 strings], expires_at_min, signal_hash?, sybil_score?}],
  integrity_bundle?}`. There is no `credential_type`, `merkle_root` or `nullifier_hash` -- those were the
  pre-4.x `ISuccessResult`. It is forwarded byte-for-byte ("Forward the complete IDKit result without
  remapping"); nothing here edits it before sending.
* World's `200` reply is `{success: true, action, nullifier, environment, created_at, session_id?,
  message?, results: [{identifier, success, nullifier, code?, detail?}]}`. A `200` means "at least one
  proof verified successfully", so a reply where any item of `results` is not `success: true` is treated
  as not verified here: Mergit only ever asks for one credential, and a partial pass is not a pass.

What is trusted, and from where:

* `action`, `environment`, the nullifier and the credential `identifier` come from World's *reply* -- what
  World says it actually checked -- never from the client-supplied `proof`.
* `protocol_version` comes from the forwarded proof, but only because World verifies the proof *as* the
  version it declares (its request schema is a `oneOf` of 3.0 and 4.0 shapes) and its reply does not echo
  it. Only `"4.0"` is accepted: a legacy 3.0 proof carries a different nullifier for the same human, so
  accepting both would let one person claim the trial twice (World's own migration guide: "Track both
  nullifiers"). That is refused before World is even asked.
* `sybil_score` is read from World's per-result entry if World ever includes it there; World's published
  `VerifyV4Result` schema does not, so it otherwise comes from the forwarded proof's matching `responses`
  item. That value is covered by the Selfie Check `integrity_bundle` (version 2) World checks as part of
  verification, so it is only read once World said `success` -- the docs: "only use the score after
  verification succeeds". It is required for a Selfie Check credential and not applicable to Orb.

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

PROTOCOL_VERSION = "4.0"
"""The only IDKit protocol version accepted (`IDKitResultV4.protocol_version`)."""

SELFIE = "selfie"
PROOF_OF_HUMAN = "proof_of_human"

PRESET_IDENTIFIER: dict[str, str] = {"selfie_check": SELFIE, "proof_of_human": PROOF_OF_HUMAN}
"""`settings.world_trial_preset` -> the one credential `identifier` World must report having verified.
These are the identifiers IDKit 4.6.0 itself compiles each preset to (`compileRequest` in
`@worldcoin/idkit-core`'s `dist/index.js`: `SelfieCheck` -> `item("selfie")`, issuer schema 11;
`ProofOfHuman` -> `item("proof_of_human")`, issuer schema 1), which are also the identifiers in World's own
verify examples. A Selfie Check deployment does not also accept `proof_of_human`: its preset never asks
for one, and World does not document whether the two credentials' nullifiers for one human coincide, so
accepting both could open a second claim per human."""


class ProofRejected(Exception):
    """The World ID proof cannot be trusted for this action. `reason` is one of `world_rejected`
    (World said the proof itself, or any one of its credentials, does not check out), `legacy_proof` (a
    World ID 3.0 proof -- only 4.0 is accepted), `wrong_environment`, `wrong_action` (World checked it
    against a different action or environment than the one Mergit asked about), `wrong_credential` (World
    verified a different credential than `world_trial_preset` asks for), `sybil_score` (above
    `world_max_sybil_score`), `malformed_proof` (missing or unparseable fields), or
    `world_unreachable`."""

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
    """World's nullifier is a 256-bit field element -- per World's docs "0x-prefixed hex strings
    representing 256-bit integers", though IDKit 4.6.0's own type comments call the v4 one "decimal", so
    both are read -- big enough that it never fits an int8: hence `world_nullifiers.nullifier` is
    `numeric(78,0)`, not `bigint`, exactly as World's integration guide recommends."""
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


def _as_dict(value: object) -> dict[str, Any] | None:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _as_dicts(value: object) -> list[dict[str, Any] | None]:
    """A JSON list's items, each as a dict or None (not an object); an empty list for a non-list."""
    return [_as_dict(item) for item in cast("list[object]", value)] if isinstance(value, list) else []


def _sybil_score(result: dict[str, Any], proof: dict[str, Any], identifier: str) -> int | None:
    """The verified credential's `sybil_score` (see the module docstring for where it is read from), or
    None for a credential that has none. A Selfie Check credential without a usable one is malformed:
    World's schema requires it whenever `issuer_schema_id` is 11."""
    raw: object = result.get("sybil_score")
    if raw is None:
        items = _as_dicts(proof.get("responses"))
        matching = [r for r in items if r is not None and r.get("identifier") == identifier]
        raw = matching[0].get("sybil_score") if len(matching) == 1 else None
    if identifier != SELFIE:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ProofRejected("malformed_proof")
    return raw


async def verify_proof(
    settings: Settings, http: httpx.AsyncClient, proof: dict[str, Any], *, action: str
) -> VerifiedProof:
    """Posts `proof` to World's `POST {world_verify_base}/api/v4/verify/{world_rp_id}` unchanged and
    returns what World verified it as. Enforces `world_max_sybil_score` only when it is set; a Selfie
    Check credential always carries a score, an Orb (`proof_of_human`) one never does."""
    assert settings.world_rp_id, "world_idkit_enabled must be checked before calling this"
    if proof.get("protocol_version") != PROTOCOL_VERSION:
        raise ProofRejected("legacy_proof")
    # World's own integration guide rejects a proof made for another environment before verifying it; the
    # reply's `environment` is still checked below, and is what is trusted. An absent field is World's
    # documented default, "production".
    if proof.get("environment", "production") != settings.world_environment:
        raise ProofRejected("wrong_environment")

    url = f"{settings.world_verify_base.rstrip('/')}{VERIFY_PATH}/{settings.world_rp_id}"
    try:
        reply = await http.post(url, json=proof, timeout=10)
    except httpx.HTTPError as exc:
        raise ProofRejected("world_unreachable") from exc
    try:
        raw_body: Any = reply.json()
    except ValueError as exc:
        raise ProofRejected("world_rejected") from exc
    body = _as_dict(raw_body) or {}
    if reply.status_code != 200 or body.get("success") is not True:
        raise ProofRejected("world_rejected")

    results = _as_dicts(body.get("results"))
    if not results or any(r is None or r.get("success") is not True for r in results):
        raise ProofRejected("world_rejected")
    if len(results) != 1:
        raise ProofRejected("malformed_proof")  # Mergit asks for exactly one credential
    result = results[0]
    assert result is not None

    environment = body.get("environment")
    if not isinstance(environment, str) or environment != settings.world_environment:
        raise ProofRejected("wrong_environment")

    reply_action = body.get("action")
    if not isinstance(reply_action, str) or reply_action != action:
        raise ProofRejected("wrong_action")

    identifier = result.get("identifier")
    if not isinstance(identifier, str) or not identifier:
        raise ProofRejected("malformed_proof")
    if identifier != PRESET_IDENTIFIER[settings.world_trial_preset]:
        raise ProofRejected("wrong_credential")

    per_result, top_level = result.get("nullifier"), body.get("nullifier")
    if per_result is None and top_level is None:
        raise ProofRejected("malformed_proof")
    nullifiers = {_parse_nullifier(n) for n in (per_result, top_level) if n is not None}
    if len(nullifiers) != 1:
        raise ProofRejected("world_rejected")  # World contradicted itself about which nullifier it checked
    nullifier = nullifiers.pop()

    sybil_score = _sybil_score(result, proof, identifier)
    if (
        settings.world_max_sybil_score is not None
        and sybil_score is not None
        and sybil_score > settings.world_max_sybil_score
    ):
        raise ProofRejected("sybil_score")

    return VerifiedProof(
        nullifier=nullifier, credential=identifier, environment=environment, sybil_score=sybil_score
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
