"""Fakes for the IDKit half (plan sec 1.2/1.3: proof forwarding, nullifier claim, the free-trial sybil
gate), shaped after World's real contract rather than invented:

* `a_proof()` is an IDKit 4.x `IDKitResultV4` -- what `@worldcoin/idkit@4.6.0`'s widget hands
  `handleVerify` -- built on World's own `selfie_check_v4` / `uniqueness_v4` request examples from
  `https://docs.world.org/api-reference/developer-portal/verify` (kept verbatim in
  `tests/fixtures/world_verify_examples.json`; `test_world_idkit.py` also runs those examples unmodified).
* `verify_response()` is World's reply to `POST {world_verify_base}/api/v4/verify/{rp_id}`, following that
  page's `VerifyV4SuccessResponse` / `VerifyV4Result` schemas (the page publishes no 200 example) and its
  `all_verifications_failed` 400 example: top-level `success`, `action`, `nullifier`, `environment`,
  `created_at`, and a per-credential `results` list of `{identifier, success, nullifier}`.

The proof is forwarded byte-for-byte, so the respx route registered by `respx_world_verify()` lets a test
assert it was sent unchanged.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import respx

from mergit_cp.world.idkit import VERIFY_PATH

EXAMPLES: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures/world_verify_examples.json").read_text()
)

_SCHEMA_ID = {"selfie": 11, "proof_of_human": 1}


def documented_request(name: str) -> dict[str, Any]:
    """One of World's published request examples, unmodified (a deep copy, so a test may edit it)."""
    return copy.deepcopy(EXAMPLES["request_examples"][name])


def a_proof(
    *,
    identifier: str = "selfie",
    nullifier: str = "0xabc123",
    sybil_score: int | None = 0,
    action: str = "mergit-free-trial",
    environment: str = "staging",
    protocol_version: str = "4.0",
) -> dict[str, Any]:
    """An `IDKitResultV4` for one credential. `sybil_score` is only attached to a Selfie Check (`selfie`)
    response, as in World's `selfie_check_v4` example; `None` leaves it off entirely."""
    base = documented_request("selfie_check_v4" if identifier == "selfie" else "uniqueness_v4")
    response = base["responses"][0]
    response["identifier"] = identifier
    response["issuer_schema_id"] = _SCHEMA_ID.get(identifier, response["issuer_schema_id"])
    response["nullifier"] = nullifier
    response.pop("sybil_score", None)
    if identifier == "selfie" and sybil_score is not None:
        response["sybil_score"] = sybil_score
    base.update(protocol_version=protocol_version, action=action, environment=environment)
    return base


def verify_response(
    *,
    success: bool = True,
    environment: str = "staging",
    action: str = "mergit-free-trial",
    nullifier: str | None = "0xabc123",
    identifier: str = "selfie",
    results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """World's reply for `a_proof()`: whether it verified, which `action` and `environment` it was checked
    against, and the per-credential `results`. `nullifier=None` leaves it off both the top level and the
    result; `results=...` replaces the list outright (partial passes, several credentials, ...)."""
    if not success:
        return {
            "success": False,
            "code": "all_verifications_failed",
            "detail": "All proof verifications failed.",
            "results": results
            if results is not None
            else [
                {
                    "identifier": identifier,
                    "success": False,
                    "code": "verification_error",
                    "detail": "On-chain proof verification failed.",
                }
            ],
        }
    item: dict[str, Any] = {"identifier": identifier, "success": True}
    body: dict[str, Any] = {
        "success": True,
        "action": action,
        "environment": environment,
        "created_at": "2026-11-06T00:00:00Z",
    }
    if nullifier is not None:
        item["nullifier"] = nullifier
        body["nullifier"] = nullifier
    body["results"] = results if results is not None else [item]
    return body


def respx_world_verify(
    router: respx.MockRouter,
    *,
    verify_base: str,
    rp_id: str,
    response: dict[str, Any],
    status_code: int | None = None,
) -> respx.Route:
    """Mocks World's verify endpoint; returns the route so a test can inspect the request it received
    (e.g. assert the proof was forwarded unchanged). A `success: false` reply is a 400, as World sends it."""
    status = status_code if status_code is not None else (200 if response.get("success") is True else 400)
    return router.post(f"{verify_base.rstrip('/')}{VERIFY_PATH}/{rp_id}").respond(
        status_code=status, json=response
    )
