"""IDKit proof verification (plan sec 1.2/1.3): forwarding a proof to World unchanged, and every way a
proof can fail to count towards the free-trial sybil gate. No database and no FastAPI app here --
`test_world_trial.py` covers the full gate through Postgres and HTTP; this file only has to trust
`idkit.verify_proof` on its own.

The first tests run World's own published request examples (`tests/fixtures/world_verify_examples.json`,
extracted verbatim from https://docs.world.org/api-reference/developer-portal/verify) through
`verify_proof` unmodified, with a reply built to World's published `VerifyV4SuccessResponse` schema: those
are the tests that pin this module to the real contract rather than to fakes that merely agree with it.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx
from pydantic import SecretStr

from mergit_cp.config import Settings
from mergit_cp.world import idkit
from tests.world_fakes_idkit import EXAMPLES, a_proof, documented_request, respx_world_verify, verify_response

VERIFY_BASE = "https://verify.world.test"
RP_ID = "test-rp-id"
VERIFY_URL = f"{VERIFY_BASE}{idkit.VERIFY_PATH}/{RP_ID}"
ACTION = "mergit-free-trial"

DOCUMENTED_NULLIFIER = "0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8"


@pytest.fixture
def world_settings() -> Settings:
    return Settings(
        database_url="unused",
        app_domain="app.mergit.test",
        session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
        gateway_url="http://gateway.invalid",
        store_url="http://store.invalid",
        agents_file="unused",
        planner_model="claude-opus-5",
        planner_provider="anthropic",
        events_token=SecretStr("test-events-token"),
        chain_events_token=SecretStr("test-chain-events-token"),
        worker_token=SecretStr("test-worker-token"),
        world_app_id="app_test",
        world_rp_id=RP_ID,
        world_signing_key=SecretStr("0" * 64),
        world_verify_base=VERIFY_BASE,
        world_environment="staging",
        world_trial_action=ACTION,
    )


def _verify(
    settings: Settings,
    proof: dict[str, Any],
    reply: dict[str, Any],
    *,
    action: str = ACTION,
    status_code: int | None = None,
) -> tuple[idkit.VerifiedProof | idkit.ProofRejected, respx.Route]:
    """Runs `verify_proof` against a mocked World; returns its result (or the rejection) and the route."""

    async def go() -> tuple[idkit.VerifiedProof | idkit.ProofRejected, respx.Route]:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            route = respx_world_verify(
                router, verify_base=VERIFY_BASE, rp_id=RP_ID, response=reply, status_code=status_code
            )
            try:
                return await idkit.verify_proof(settings, http, proof, action=action), route
            except idkit.ProofRejected as rejected:
                return rejected, route

    return asyncio.run(go())


def _rejected(outcome: object) -> str:
    assert isinstance(outcome, idkit.ProofRejected), f"expected a rejection, got {outcome!r}"
    return outcome.reason


# --- World's own published examples, unmodified -----------------------------------------------------------


def test_worlds_documented_selfie_check_example_verifies(world_settings: Settings) -> None:
    """World's `selfie_check_v4` request example, forwarded as-is. It carries no `credential_type` and no
    `nullifier_hash` (pre-4.x names); the module this replaced rejected every proof of this shape."""
    proof = documented_request("selfie_check_v4")
    settings = world_settings.model_copy(update={"world_environment": "production"})  # example omits it
    reply = verify_response(
        environment="production", action=proof["action"], nullifier=DOCUMENTED_NULLIFIER, identifier="selfie"
    )

    outcome, route = _verify(settings, proof, reply, action=proof["action"])

    assert outcome == idkit.VerifiedProof(
        nullifier=int(DOCUMENTED_NULLIFIER, 16), credential="selfie", environment="production", sybil_score=10
    )
    assert str(route.calls.last.request.url) == VERIFY_URL
    assert json.loads(route.calls.last.request.content) == documented_request("selfie_check_v4")


def test_worlds_documented_proof_of_human_example_verifies(world_settings: Settings) -> None:
    proof = documented_request("uniqueness_v4")
    settings = world_settings.model_copy(
        update={"world_environment": "production", "world_trial_preset": "proof_of_human"}
    )
    reply = verify_response(
        environment="production",
        action=proof["action"],
        nullifier=DOCUMENTED_NULLIFIER,
        identifier="proof_of_human",
    )

    outcome, _ = _verify(settings, proof, reply, action=proof["action"])

    assert outcome == idkit.VerifiedProof(
        nullifier=int(DOCUMENTED_NULLIFIER, 16),
        credential="proof_of_human",
        environment="production",
        sybil_score=None,
    )


def test_worlds_documented_legacy_example_is_refused_before_world_is_asked(world_settings: Settings) -> None:
    """A World ID 3.0 proof's nullifier differs from the same human's 4.0 one: accepting both would let
    one person claim the trial twice, so a 3.0 proof is never counted -- not even forwarded."""
    proof = documented_request("uniqueness_v3")
    settings = world_settings.model_copy(update={"world_environment": "production"})
    reply = verify_response(environment="production", action=proof["action"], identifier="orb")

    outcome, route = _verify(settings, proof, reply, action=proof["action"])

    assert _rejected(outcome) == "legacy_proof"
    assert not route.called


def test_worlds_documented_failure_reply_is_a_rejection(world_settings: Settings) -> None:
    reply = EXAMPLES["error_examples"]["all_verifications_failed"]
    outcome, _ = _verify(world_settings, a_proof(), reply, status_code=400)
    assert _rejected(outcome) == "world_rejected"


# --- the happy path ---------------------------------------------------------------------------------------


def test_verify_forwards_the_proof_unchanged_and_trusts_worlds_reply(world_settings: Settings) -> None:
    proof = a_proof(nullifier="0xdeadbeef", sybil_score=2)
    outcome, route = _verify(world_settings, proof, verify_response(nullifier="0xdeadbeef"))

    assert outcome == idkit.VerifiedProof(
        nullifier=0xDEADBEEF, credential="selfie", environment="staging", sybil_score=2
    )
    assert json.loads(route.calls.last.request.content) == proof


def test_the_nullifier_is_read_from_the_per_result_or_the_top_level_field(world_settings: Settings) -> None:
    per_result_only = verify_response(nullifier="0x1234")
    del per_result_only["nullifier"]
    top_level_only = verify_response(nullifier="0x1234")
    del top_level_only["results"][0]["nullifier"]

    for reply in (per_result_only, top_level_only):
        outcome, _ = _verify(world_settings, a_proof(), reply)
        assert isinstance(outcome, idkit.VerifiedProof)
        assert outcome.nullifier == 0x1234


def test_a_decimal_nullifier_is_read_as_decimal(world_settings: Settings) -> None:
    """IDKit 4.6.0's own type comment calls the v4 nullifier "decimal"; World's docs say 0x-hex. Both
    spellings of one number must land on the same `numeric(78,0)` value."""
    outcome, _ = _verify(world_settings, a_proof(), verify_response(nullifier=str(0xABCDEF)))
    assert isinstance(outcome, idkit.VerifiedProof)
    assert outcome.nullifier == 0xABCDEF


def test_the_credential_comes_from_worlds_reply_not_the_proof(world_settings: Settings) -> None:
    """The client's proof says `selfie`; World says it verified `proof_of_human`. World wins -- and on a
    Selfie Check deployment, that is the wrong credential."""
    outcome, _ = _verify(
        world_settings, a_proof(identifier="selfie"), verify_response(identifier="proof_of_human")
    )
    assert _rejected(outcome) == "wrong_credential"


# --- the configured credential preset ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("preset", "verified"),
    [
        ("selfie_check", "proof_of_human"),
        ("selfie_check", "orb"),  # a 3.0 identifier
        ("selfie_check", "passport"),
        ("proof_of_human", "selfie"),
        ("proof_of_human", "orb"),
    ],
)
def test_only_the_configured_presets_credential_is_accepted(
    world_settings: Settings, preset: str, verified: str
) -> None:
    settings = world_settings.model_copy(update={"world_trial_preset": preset})
    outcome, _ = _verify(settings, a_proof(identifier=verified), verify_response(identifier=verified))
    assert _rejected(outcome) == "wrong_credential"


# --- partial or ambiguous passes --------------------------------------------------------------------------


def test_a_partial_pass_is_not_a_pass(world_settings: Settings) -> None:
    """World answers 200 when "at least one proof verified successfully": one failed credential next to a
    passing one still is not a verified proof here."""
    reply = verify_response(
        results=[
            {"identifier": "selfie", "success": True, "nullifier": "0xabc123"},
            {"identifier": "proof_of_human", "success": False, "code": "verification_error"},
        ]
    )
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "world_rejected"


def test_a_failed_result_under_a_top_level_success_is_rejected(world_settings: Settings) -> None:
    reply = verify_response(results=[{"identifier": "selfie", "success": False, "nullifier": "0xabc123"}])
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "world_rejected"


@pytest.mark.parametrize("results", [[], None, "not-a-list", [None]])
def test_a_reply_without_usable_results_is_rejected(world_settings: Settings, results: object) -> None:
    reply = verify_response()
    if results is None:
        del reply["results"]
    else:
        reply["results"] = results
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "world_rejected"


def test_the_pre_v4_reply_shape_is_rejected(world_settings: Settings) -> None:
    """The shape this module used to expect (and its fakes used to send): no `results` at all, a
    `nullifier_hash`. Nothing in it says which credential World checked, so it is never trusted."""
    reply = {"success": True, "environment": "staging", "action": ACTION, "nullifier_hash": "0xabc123"}
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "world_rejected"


def test_more_than_one_verified_credential_is_malformed(world_settings: Settings) -> None:
    reply = verify_response(
        results=[
            {"identifier": "selfie", "success": True, "nullifier": "0xabc123"},
            {"identifier": "selfie", "success": True, "nullifier": "0xabc124"},
        ]
    )
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "malformed_proof"


def test_world_contradicting_itself_about_the_nullifier_is_rejected(world_settings: Settings) -> None:
    reply = verify_response(nullifier="0x1111")
    reply["results"][0]["nullifier"] = "0x2222"
    outcome, _ = _verify(world_settings, a_proof(), reply)
    assert _rejected(outcome) == "world_rejected"


def test_a_reply_with_no_nullifier_anywhere_is_malformed(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(), verify_response(nullifier=None))
    assert _rejected(outcome) == "malformed_proof"


def test_an_unparseable_nullifier_is_malformed(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(), verify_response(nullifier="not-a-number"))
    assert _rejected(outcome) == "malformed_proof"


# --- protocol version -------------------------------------------------------------------------------------


@pytest.mark.parametrize("version", ["3.0", None, 4.0, "4"])
def test_anything_but_protocol_4_is_refused_before_world_is_asked(
    world_settings: Settings, version: object
) -> None:
    proof = a_proof()
    if version is None:
        del proof["protocol_version"]
    else:
        proof["protocol_version"] = version
    outcome, route = _verify(world_settings, proof, verify_response())
    assert _rejected(outcome) == "legacy_proof"
    assert not route.called


# --- sybil score ------------------------------------------------------------------------------------------


def test_a_sybil_score_above_the_cap_is_rejected(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 5})
    outcome, _ = _verify(capped, a_proof(sybil_score=6), verify_response())
    assert _rejected(outcome) == "sybil_score"


def test_a_sybil_score_at_the_cap_is_allowed(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 5})
    outcome, _ = _verify(capped, a_proof(sybil_score=5), verify_response())
    assert isinstance(outcome, idkit.VerifiedProof)
    assert outcome.sybil_score == 5


def test_the_sybil_cap_is_not_applied_when_unset(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(sybil_score=10), verify_response())
    assert isinstance(outcome, idkit.VerifiedProof)
    assert outcome.sybil_score == 10


def test_a_per_result_sybil_score_from_world_wins_over_the_proofs(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 5})
    reply = verify_response()
    reply["results"][0]["sybil_score"] = 9
    outcome, _ = _verify(capped, a_proof(sybil_score=1), reply)
    assert _rejected(outcome) == "sybil_score"


def test_a_selfie_check_without_a_sybil_score_is_malformed(world_settings: Settings) -> None:
    """World's schema requires `sybil_score` on every Selfie Check (issuer schema 11) response; one
    without it is never quietly let past an operator's cap."""
    outcome, _ = _verify(world_settings, a_proof(sybil_score=None), verify_response())
    assert _rejected(outcome) == "malformed_proof"


def test_an_orb_credential_has_no_sybil_score_and_ignores_the_cap(world_settings: Settings) -> None:
    settings = world_settings.model_copy(
        update={"world_trial_preset": "proof_of_human", "world_max_sybil_score": 0}
    )
    outcome, _ = _verify(
        settings, a_proof(identifier="proof_of_human"), verify_response(identifier="proof_of_human")
    )
    assert isinstance(outcome, idkit.VerifiedProof)
    assert outcome.sybil_score is None


# --- every other way a proof can be refused ---------------------------------------------------------------


def test_verify_rejects_success_false(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(), verify_response(success=False))
    assert _rejected(outcome) == "world_rejected"


def test_verify_rejects_the_wrong_environment_in_worlds_reply(world_settings: Settings) -> None:
    # world_settings.world_environment is "staging"; World says it checked production.
    outcome, _ = _verify(world_settings, a_proof(), verify_response(environment="production"))
    assert _rejected(outcome) == "wrong_environment"


def test_a_proof_made_for_another_environment_is_refused_before_world_is_asked(
    world_settings: Settings,
) -> None:
    outcome, route = _verify(world_settings, a_proof(environment="production"), verify_response())
    assert _rejected(outcome) == "wrong_environment"
    assert not route.called


def test_verify_rejects_the_wrong_action(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(), verify_response(action="some-other-action"))
    assert _rejected(outcome) == "wrong_action"


def test_verify_is_rejected_when_world_is_unreachable(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            router.post(VERIFY_URL).mock(side_effect=httpx.ConnectError("boom"))
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        asyncio.run(go())
    assert excinfo.value.reason == "world_unreachable"


def test_verify_rejects_a_non_200_reply(world_settings: Settings) -> None:
    outcome, _ = _verify(world_settings, a_proof(), verify_response(), status_code=500)
    assert _rejected(outcome) == "world_rejected"


def test_verify_rejects_a_reply_that_is_not_json(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            router.post(VERIFY_URL).respond(status_code=200, text="<html>")
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        asyncio.run(go())
    assert excinfo.value.reason == "world_rejected"


# --- claim_nullifier / has_claimed: pure functions need a real connection, covered in test_world_trial.py -
