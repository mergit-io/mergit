"""IDKit proof verification (plan sec 1.2/1.3): forwarding a proof to World unchanged, and every way a
proof can fail to count towards the free-trial sybil gate. No database and no FastAPI app here --
`test_world_trial.py` covers the full gate through Postgres and HTTP; this file only has to trust
`idkit.verify_proof` on its own.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import respx
from pydantic import SecretStr

from mergit_cp.config import Settings
from mergit_cp.world import idkit
from tests.world_fakes_idkit import a_proof, respx_world_verify, verify_response

VERIFY_BASE = "https://verify.world.test"
RP_ID = "test-rp-id"
VERIFY_URL = f"{VERIFY_BASE}{idkit.VERIFY_PATH}/{RP_ID}"
ACTION = "mergit-free-trial"


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


def _run(coro):  # type: ignore[no-untyped-def]
    return asyncio.run(coro)


# --- verify_proof: the happy path -------------------------------------------------------------------------


def test_verify_forwards_the_proof_unchanged_and_returns_the_nullifier(world_settings: Settings) -> None:
    proof = a_proof(nullifier_hash="0xdeadbeef", credential_type="orb")

    async def go() -> idkit.VerifiedProof:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            route = respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(
                    environment="staging", action=ACTION, nullifier_hash="0xdeadbeef", sybil_score=2
                ),
            )
            result = await idkit.verify_proof(world_settings, http, proof, action=ACTION)
            assert route.called
            sent_url = str(route.calls.last.request.url)
            assert sent_url == VERIFY_URL
            assert json.loads(route.calls.last.request.content) == proof
            return result

    result = _run(go())
    assert result == idkit.VerifiedProof(
        nullifier=0xDEADBEEF, credential="orb", environment="staging", sybil_score=2
    )


def test_verify_ignores_the_sybil_cap_when_unset_or_the_field_is_absent(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 10})

    async def go(settings: Settings) -> idkit.VerifiedProof:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(environment="staging", action=ACTION),  # no sybil_score field
            )
            return await idkit.verify_proof(settings, http, a_proof(), action=ACTION)

    # Uncapped settings: never even looks at the field.
    assert _run(go(world_settings)).sybil_score is None
    # Capped settings, but World's reply is silent on the field: not rejected on it either.
    assert _run(go(capped)).sybil_score is None


def test_verify_rejects_a_sybil_score_above_the_cap(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 5})

    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(environment="staging", action=ACTION, sybil_score=6),
            )
            await idkit.verify_proof(capped, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "sybil_score"


def test_verify_allows_a_sybil_score_at_or_below_the_cap(world_settings: Settings) -> None:
    capped = world_settings.model_copy(update={"world_max_sybil_score": 5})

    async def go() -> idkit.VerifiedProof:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(environment="staging", action=ACTION, sybil_score=5),
            )
            return await idkit.verify_proof(capped, http, a_proof(), action=ACTION)

    assert _run(go()).sybil_score == 5


# --- verify_proof: every way a proof can be refused -------------------------------------------------------


def test_verify_rejects_success_false(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(success=False, environment="staging", action=ACTION),
            )
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "world_rejected"


def test_verify_rejects_the_wrong_environment(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                # world_settings.world_environment is "staging"; World says it checked production.
                response=verify_response(environment="production", action=ACTION),
            )
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "wrong_environment"


def test_verify_rejects_the_wrong_action(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router,
                verify_base=VERIFY_BASE,
                rp_id=RP_ID,
                response=verify_response(environment="staging", action="some-other-action"),
            )
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "wrong_action"


def test_verify_is_rejected_when_world_is_unreachable(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            router.post(VERIFY_URL).mock(side_effect=httpx.ConnectError("boom"))
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "world_unreachable"


def test_verify_rejects_a_non_200_reply(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            router.post(VERIFY_URL).respond(status_code=500, json={"success": True})
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "world_rejected"


def test_verify_rejects_a_proof_with_no_credential_type(world_settings: Settings) -> None:
    broken_proof = a_proof()
    del broken_proof["credential_type"]

    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            respx_world_verify(
                router, verify_base=VERIFY_BASE, rp_id=RP_ID, response=verify_response(action=ACTION)
            )
            await idkit.verify_proof(world_settings, http, broken_proof, action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "malformed_proof"


def test_verify_rejects_an_unparseable_nullifier(world_settings: Settings) -> None:
    async def go() -> None:
        async with httpx.AsyncClient() as http, respx.mock(assert_all_called=False) as router:
            router.post(VERIFY_URL).respond(
                json={
                    "success": True,
                    "environment": "staging",
                    "action": ACTION,
                    "nullifier_hash": "not-a-number",
                }
            )
            await idkit.verify_proof(world_settings, http, a_proof(), action=ACTION)

    with pytest.raises(idkit.ProofRejected) as excinfo:
        _run(go())
    assert excinfo.value.reason == "malformed_proof"


# --- claim_nullifier / has_claimed: pure functions need a real connection, covered in test_world_trial.py -
