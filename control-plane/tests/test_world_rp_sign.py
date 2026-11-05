"""Tests for `mergit_cp.world.rp_sign`, checked against World's own published test vectors
(https://docs.world.org/world-id/idkit/signatures, "Test vectors" section, fetched 2026-11-06, copied
verbatim into `tests/fixtures/world_rp_vectors.json`).

The page publishes vectors for three layers of the algorithm — `hash_to_field`,
`compute_rp_signature_message`, and the full `sign_request` — and this file checks all three, not just
the end-to-end signature, so a mismatch is traceable to the exact step that broke.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mergit_cp.world.rp_sign import (
    _compute_rp_signature_message,
    _hash_to_field,
    sign_rp_request,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures/world_rp_vectors.json").read_text())


@pytest.mark.parametrize("v", VECTORS["hash_to_field"], ids=lambda v: v["name"])
def test_hash_to_field_vectors(v: dict[str, Any]) -> None:
    assert _hash_to_field(bytes.fromhex(v["input_hex"])) == bytes.fromhex(v["output"][2:])


@pytest.mark.parametrize("v", VECTORS["compute_rp_signature_message"], ids=lambda v: v["name"])
def test_compute_rp_signature_message_vectors(v: dict[str, Any]) -> None:
    nonce = bytes.fromhex(v["nonce"][2:])
    msg = _compute_rp_signature_message(nonce, v["created_at"], v["expires_at"], v["action"])
    assert msg.hex() == v["expected_message"]


@pytest.mark.parametrize(
    "v",
    [v for v in VECTORS["sign_request"] if v["action"] is not None],
    ids=lambda v: v["name"],
)
def test_signature_matches_worlds_vectors(v: dict[str, Any]) -> None:
    ctx = sign_rp_request(v["signing_key"], v["action"], now=v["created_at"], nonce=v["nonce"])
    assert ctx.sig == v["expected_sig"]
    assert ctx.nonce == v["nonce"]
    assert ctx.created_at == v["created_at"]
    assert ctx.expires_at == v["created_at"] + 300


def test_fixture_sig_matches_the_pinned_literal() -> None:
    """NOT a cryptographic check. The page's other `sign_request` vector (no `action`, a bare session
    proof) can't be driven through `sign_rp_request`, because that function's `action` parameter is
    required — Mergit only ever signs action-scoped uniqueness proofs. So unlike every other vector in
    this file, this one's `expected_sig` is never independently re-derived anywhere in the test suite —
    it is only compared against a second hardcoded copy of the same literal, pinning the fixture against
    silent edits. Its authenticity rests on transcription from the page alone. Only the message-layout
    bytes it shares with the action variant (the part `sign_rp_request` actually exercises) are
    cryptographically checked, separately, by `test_compute_rp_signature_message_vectors`."""
    no_action = next(v for v in VECTORS["sign_request"] if v["action"] is None)
    assert no_action["expected_sig"] == (
        "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9"
        "e4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b"
    )


def test_a_fresh_nonce_each_call() -> None:
    a = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    b = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    assert a.nonce != b.nonce


def test_rp_context_to_json_matches_idkit_field_names() -> None:
    ctx = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    assert ctx.to_json() == {
        "sig": ctx.sig,
        "nonce": ctx.nonce,
        "created_at": ctx.created_at,
        "expires_at": ctx.expires_at,
    }


def test_accepts_signing_key_and_nonce_without_0x_prefix() -> None:
    v = next(v for v in VECTORS["sign_request"] if v["action"] is not None)
    ctx = sign_rp_request(
        v["signing_key"][2:],
        v["action"],
        now=v["created_at"],
        nonce=v["nonce"][2:],
    )
    assert ctx.sig == v["expected_sig"]


def test_rp_context_is_frozen() -> None:
    ctx = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    with pytest.raises(AttributeError):
        ctx.sig = "0x00"  # type: ignore[misc]
