"""Fakes for the IDKit half (plan sec 1.2/1.3: proof forwarding, nullifier claim, the free-trial sybil
gate).

`a_proof()` is a minimal, valid IDKit `ISuccessResult` -- what the widget hands `handleVerify` on a
successful verification. It is forwarded to World's verify endpoint byte-for-byte, so the respx route
registered by `respx_world_verify()` can assert it was sent unchanged. `verify_response()` is what World's
`POST {world_verify_base}/api/v4/verify/{rp_id}` would reply with for that proof.
"""

from __future__ import annotations

from typing import Any

import respx

from mergit_cp.world.idkit import VERIFY_PATH


def a_proof(*, credential_type: str = "orb", nullifier_hash: str = "0xabc123") -> dict[str, Any]:
    return {
        "merkle_root": "0xroot",
        "nullifier_hash": nullifier_hash,
        "proof": "0xzkproof",
        "credential_type": credential_type,
    }


def verify_response(
    *,
    success: bool = True,
    environment: str = "staging",
    action: str = "mergit-free-trial",
    nullifier_hash: str = "0xabc123",
    sybil_score: int | None = None,
) -> dict[str, Any]:
    """What World's verify endpoint would reply for `a_proof()`: confirms `success`, and which `action`
    and `environment` the proof was actually checked against, plus an optional `sybil_score`."""
    body: dict[str, Any] = {
        "success": success,
        "environment": environment,
        "action": action,
        "nullifier_hash": nullifier_hash,
    }
    if sybil_score is not None:
        body["sybil_score"] = sybil_score
    return body


def respx_world_verify(
    router: respx.MockRouter, *, verify_base: str, rp_id: str, response: dict[str, Any]
) -> respx.Route:
    """Mocks World's verify endpoint; returns the route so a test can inspect the request it received
    (e.g. assert the proof was forwarded unchanged)."""
    return router.post(f"{verify_base.rstrip('/')}{VERIFY_PATH}/{rp_id}").respond(json=response)
