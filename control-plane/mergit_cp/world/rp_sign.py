"""IDKit RP (relying-party) request signing (plan sec 2.x): the signature Mergit's backend attaches to
every World ID proof request so World can tell the request really came from Mergit, not an impersonator.

There is no Python SDK for this — IDKit ships it only as JS/Go/pseudocode
(https://docs.world.org/world-id/idkit/signatures). This module hand-rolls the same algorithm from that
page and is checked against the page's own published test vectors
(`tests/fixtures/world_rp_vectors.json`, copied verbatim from the page on 2026-11-06):

    hash_to_field(bytes)       = (keccak256(bytes) as uint256) >> 8, as a 32-byte big-endian value
                                  (the right-shift zeroes the top byte, which is why every
                                  `hash_to_field` output below starts with 0x00)
    compute_rp_signature_message(nonce, created_at, expires_at, action?)
                               = 0x01 || nonce(32) || created_at(8, BE) || expires_at(8, BE)
                                 [|| hash_to_field(action.encode())(32) if action is not None]
    sign_request(...)          = EIP-191-prefix the message ("\\x19Ethereum Signed Message:\\n" +
                                 decimal_len + message), Keccak-256 it, sign with recoverable
                                 secp256k1 ECDSA, and pack r(32) || s(32) || v(1).

Only the "with action" variant is exposed here (`sign_rp_request` always takes an `action`): Mergit
always proves an action-scoped uniqueness ("is this the same human who already took their free trial")
rather than a bare session proof, so the page's no-action vector isn't reachable through this function
— see the note next to it in `tests/test_world_rp_sign.py`.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils.crypto import keccak

_VERSION_BYTE = 0x01
_NONCE_LEN = 32


def _hash_to_field(data: bytes) -> bytes:
    """World's `hash_to_field`: Keccak-256 (NOT SHA3-256 — different padding) of `data`, right-shifted
    8 bits so the 32-byte result always starts with 0x00."""
    digest = keccak(data)
    shifted = int.from_bytes(digest, "big") >> 8
    return shifted.to_bytes(32, "big")


def _compute_rp_signature_message(
    nonce: bytes, created_at: int, expires_at: int, action: str | None
) -> bytes:
    """World's `compute_rp_signature_message`: 49 bytes without `action`, 81 bytes with it."""
    msg = bytearray()
    msg.append(_VERSION_BYTE)
    msg.extend(nonce)
    msg.extend(created_at.to_bytes(8, "big"))
    msg.extend(expires_at.to_bytes(8, "big"))
    if action is not None:
        msg.extend(_hash_to_field(action.encode()))
    return bytes(msg)


def _parse_32_bytes(value: str, *, label: str) -> bytes:
    hex_part = value[2:] if value.lower().startswith("0x") else value
    try:
        raw = bytes.fromhex(hex_part)
    except ValueError as exc:
        raise ValueError(f"{label} must be a hex string") from exc
    if len(raw) != _NONCE_LEN:
        raise ValueError(f"{label} must be 32 bytes (64 hex chars)")
    return raw


@dataclass(frozen=True)
class RpContext:
    sig: str
    nonce: str
    created_at: int
    expires_at: int

    def to_json(self) -> dict[str, str | int]:
        """The shape World's own backend example returns from its RP-signature route
        (https://docs.world.org/world-id/idkit/integrate, step 3: `{sig, nonce, created_at, expires_at}`).
        It is *not* IDKit's `RpContext` as-is: `@worldcoin/idkit@4.6.0`'s `RpContext` is `{rp_id, nonce,
        created_at, expires_at, signature}` -- the signature under `signature`, not `sig`, plus `rp_id`,
        which this signature does not carry. The browser builds that object itself (`TrialVerify`),
        renaming `sig` to `signature` and taking `rp_id` from `GET /v0/world/config`."""
        return {
            "sig": self.sig,
            "nonce": self.nonce,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
        }


def sign_rp_request(
    signing_key_hex: str,
    action: str,
    *,
    now: int,
    nonce: str | None = None,
    ttl_s: int = 300,
) -> RpContext:
    """Sign a World ID proof request for `action` as of `now`, per World's `sign_request` algorithm.

    `nonce`, when given, is used as-is as the message's 32-byte nonce field (already in
    `hash_to_field`'s output form — e.g. a fixed vector's nonce for reproducible tests). When omitted, a
    fresh nonce is drawn from `secrets.token_bytes(32)` and passed through `hash_to_field`, exactly as
    the spec's `sign_request` does for `random`.
    """
    key_bytes = _parse_32_bytes(signing_key_hex, label="signing_key_hex")

    nonce_bytes = (
        _hash_to_field(secrets.token_bytes(32)) if nonce is None else _parse_32_bytes(nonce, label="nonce")
    )

    created_at = now
    expires_at = created_at + ttl_s
    message = _compute_rp_signature_message(nonce_bytes, created_at, expires_at, action)

    signable = encode_defunct(primitive=message)
    signed = Account.sign_message(signable, private_key=key_bytes)
    sig_bytes = signed.r.to_bytes(32, "big") + signed.s.to_bytes(32, "big") + bytes([signed.v])

    return RpContext(
        sig="0x" + sig_bytes.hex(),
        nonce="0x" + nonce_bytes.hex(),
        created_at=created_at,
        expires_at=expires_at,
    )
