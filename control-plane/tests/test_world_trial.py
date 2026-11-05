"""The free trial's one-human gate (plan sec 1.2/1.3/1.7): once IDKit is configured, starting the free
trial -- and funding a plan's approval from credits -- needs a World ID proof whose nullifier has not
already been claimed by a *different* account, including one that has since been deleted. Driven entirely
through HTTP, the same way `test_world_approve_gate.py` drives the Agent Pass half. Run with
`pytest -m postgres`.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import psycopg
import pytest
import respx
from eth_account import Account
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.cp_fakes import FakeLLM, result
from tests.test_accounts import _nonce, _signed_by, github_login, me
from tests.test_merge import conflict, merge
from tests.test_plans import BODY, planned, sign_in
from tests.world_fakes_idkit import a_proof, respx_world_verify, verify_response

pytestmark = pytest.mark.postgres

VERIFY_BASE = "https://verify.world.test"
RP_ID = "test-rp-id"
ALREADY_USED = "the free credits were already used by this person"


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM([result(planned(n=1)) for _ in range(20)])


@pytest.fixture
def settings(settings: Settings) -> Settings:
    """IDKit configured (sec 1.2/1.3); Agent Pass left off so the plan-approve gate under test here is
    only the credits/nullifier one, not a fresh human-approval popup too."""
    return settings.model_copy(
        update={
            "github_client_id": "gh-id",
            "github_client_secret": SecretStr("gh-secret"),
            "world_app_id": "app_test",
            "world_rp_id": RP_ID,
            "world_signing_key": SecretStr("0" * 64),
            "world_verify_base": VERIFY_BASE,
            "world_environment": "staging",
        }
    )


def _truncate(settings: Settings) -> None:
    with psycopg.connect(settings.database_url) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
        ).fetchall()
        if tables:
            conn.execute("TRUNCATE " + ", ".join(t[0] for t in tables) + " CASCADE")


@pytest.fixture
def world_client(settings: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    app = create_app(settings, llm=llm, deliver_events=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as c:
        yield c
    _truncate(settings)


def do_trial(
    client: TestClient,
    settings: Settings,
    *,
    nullifier: str = "0xaaa111",
    success: bool = True,
    sybil_score: int = 0,
    body: dict[str, Any] | None = None,
) -> httpx.Response:
    """Posts `/v0/account/trial` with a World proof (an IDKit 4.x Selfie Check result, the default preset),
    World's verify endpoint mocked to answer for it. `body=...` overrides the request body outright (e.g.
    to send no proof at all)."""
    assert settings.world_rp_id
    with respx.mock(assert_all_called=False) as router:
        respx_world_verify(
            router,
            verify_base=settings.world_verify_base,
            rp_id=settings.world_rp_id,
            response=verify_response(
                success=success,
                environment=settings.world_environment,
                action=settings.world_trial_action,
                nullifier=nullifier,
            ),
        )
        sent = (
            body
            if body is not None
            else {
                "world_proof": a_proof(
                    nullifier=nullifier,
                    sybil_score=sybil_score,
                    action=settings.world_trial_action,
                    environment=settings.world_environment,
                )
            }
        )
        return client.post("/v0/account/trial", json=sent)


def nullifier_count(settings: Settings) -> int:
    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("SELECT count(*) FROM world_nullifiers").fetchone()
        assert row is not None
        return int(row[0])


def trial_started_at(settings: Settings) -> object:
    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("SELECT trial_started_at FROM users").fetchone()
        assert row is not None
        return row[0]


# --- the trial gate ---------------------------------------------------------------------------------------


def test_trial_needs_a_world_proof_when_idkit_is_on(world_client: TestClient) -> None:
    github_login(world_client)
    response = world_client.post("/v0/account/trial")
    assert response.status_code == 428, response.text
    assert response.json()["detail"] == "world_proof_required"


def test_trial_starts_with_a_valid_proof(world_client: TestClient, settings: Settings) -> None:
    github_login(world_client)
    response = do_trial(world_client, settings)
    assert response.status_code == 200, response.text
    assert response.json()["started_at"]
    assert me(world_client)["trial"] is not None
    assert nullifier_count(settings) == 1


def test_same_human_on_a_second_account_is_refused(world_client: TestClient, settings: Settings) -> None:
    github_login(world_client, subject=1, login="human-one")
    assert do_trial(world_client, settings, nullifier="0xaaaaaa1").status_code == 200
    world_client.cookies.clear()

    github_login(world_client, subject=2, login="human-two")
    response = do_trial(world_client, settings, nullifier="0xaaaaaa1")
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == ALREADY_USED
    assert me(world_client)["trial"] is None
    assert nullifier_count(settings) == 1


def test_trial_refused_for_same_nullifier_after_account_deletion(
    world_client: TestClient, settings: Settings
) -> None:
    github_login(world_client, subject=1, login="human-one")
    assert do_trial(world_client, settings, nullifier="0xbbbbbb1").status_code == 200
    assert world_client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    world_client.cookies.clear()

    github_login(world_client, subject=2, login="human-two")
    response = do_trial(world_client, settings, nullifier="0xbbbbbb1")
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == ALREADY_USED
    assert me(world_client)["trial"] is None


def test_cancelled_verification_leaves_the_trial_unstarted(
    world_client: TestClient, settings: Settings
) -> None:
    """World is never even called when there is no proof to send it (the widget was cancelled before it
    produced one): 428, and nothing about the trial or a nullifier claim is touched."""
    github_login(world_client)
    response = do_trial(world_client, settings, body={})
    assert response.status_code == 428, response.text
    assert trial_started_at(settings) is None
    assert nullifier_count(settings) == 0


def test_a_rejected_proof_leaves_the_trial_unstarted(world_client: TestClient, settings: Settings) -> None:
    """World reachable, but it says the proof does not check out: 403, and -- the thing that matters here
    -- the nullifier claim and `accounts.start_trial` never ran at all, since the rejection happens before
    the transaction even opens."""
    github_login(world_client)
    response = do_trial(world_client, settings, success=False)
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["reason"] == "world_rejected"
    assert trial_started_at(settings) is None
    assert nullifier_count(settings) == 0


def test_a_sybil_score_above_the_cap_leaves_the_trial_unstarted(
    world_client: TestClient, settings: Settings
) -> None:
    capped = settings.model_copy(update={"world_max_sybil_score": 5})
    app = create_app(capped, llm=FakeLLM([result(planned(n=1))]), deliver_events=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as client:
        github_login(client)
        response = do_trial(client, capped, sybil_score=6)
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["reason"] == "sybil_score"
        assert trial_started_at(capped) is None
    _truncate(capped)


def test_retrying_with_the_same_proof_is_idempotent(world_client: TestClient, settings: Settings) -> None:
    github_login(world_client)
    first = do_trial(world_client, settings, nullifier="0xccccccc1")
    assert first.status_code == 200, first.text
    second = do_trial(world_client, settings, nullifier="0xccccccc1")
    assert second.status_code == 200, second.text
    assert second.json()["started_at"] == first.json()["started_at"]
    assert nullifier_count(settings) == 1


# --- credits funding on plan approval needs the same claimed nullifier -------------------------------------


def _approve_with_credits(client: TestClient, plan: dict[str, Any]) -> httpx.Response:
    tasks = {str(t["index"]): ["1"] for t in plan["tasks"]}
    return client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json={"agents": tasks, "funding": "credits"})


def test_credits_funding_without_a_claim_asks_for_a_world_proof(world_client: TestClient) -> None:
    """No claim yet is "verify first" (the same 428 `/trial` answers), never the false "the free credits
    were already used by this person": nobody has used anything."""
    sign_in(world_client)
    plan = world_client.post("/v0/plans", json=BODY).json()
    response = _approve_with_credits(world_client, plan)
    assert response.status_code == 428, response.text
    assert response.json()["detail"] == "world_proof_required"


def test_credits_funding_succeeds_once_the_nullifier_is_claimed(
    world_client: TestClient, settings: Settings
) -> None:
    sign_in(world_client)
    assert do_trial(world_client, settings, nullifier="0xddddddd1").status_code == 200
    plan = world_client.post("/v0/plans", json=BODY).json()
    response = _approve_with_credits(world_client, plan)
    assert response.status_code == 200, response.text


def test_a_trial_started_before_idkit_can_still_verify_and_keeps_its_start_date(
    world_client: TestClient, settings: Settings, llm: FakeLLM
) -> None:
    """An account whose trial began while IDKit was off (`trial_started_at` set, no nullifier claim) is
    asked to verify when it funds a plan from credits -- not told its credits were already used -- and
    `/trial` then takes the proof, claims the nullifier and keeps the original start date."""
    off = settings.model_copy(update={"world_app_id": None, "world_rp_id": None, "world_signing_key": None})
    with TestClient(
        create_app(off, llm=llm, deliver_events=False), base_url="https://testserver", follow_redirects=False
    ) as before:
        github_login(before)
        assert before.post("/v0/account/trial").status_code == 200
        started = me(before)["trial"]["started_at"]
        session = dict(before.cookies)
    world_client.cookies.update(session)

    plan = world_client.post("/v0/plans", json=BODY).json()
    refused = _approve_with_credits(world_client, plan)
    assert refused.status_code == 428, refused.text
    assert refused.json()["detail"] == "world_proof_required"

    verified = do_trial(world_client, settings, nullifier="0xeeeeee1")
    assert verified.status_code == 200, verified.text
    assert verified.json()["started_at"] == started
    assert nullifier_count(settings) == 1

    assert _approve_with_credits(world_client, plan).status_code == 200


def test_a_forfeited_account_is_still_told_the_credits_were_used(
    world_client: TestClient, settings: Settings
) -> None:
    """The 428 is only for "not verified yet". A sign-in method that belonged to a deleted account that
    already took the trial is refused outright, as before."""
    github_login(world_client, subject=7, login="once")
    assert do_trial(world_client, settings, nullifier="0xfffff1").status_code == 200
    assert world_client.request("DELETE", "/v0/account", json={"confirm": "delete"}).status_code == 204
    world_client.cookies.clear()

    github_login(world_client, subject=7, login="once")  # same GitHub identity, fresh account
    wallet = Account.create()
    linked = world_client.post("/v0/auth/wallet/link", json=_signed_by(wallet, _nonce(world_client)))
    assert linked.status_code == 200, linked.text
    plan = world_client.post("/v0/plans", json=BODY)
    assert plan.status_code == 201, plan.text
    response = _approve_with_credits(world_client, plan.json())
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == ALREADY_USED


# --- merging two accounts keeps the verified human's claim -----------------------------------------------


def _claims(settings: Settings) -> list[tuple[object, ...]]:
    with psycopg.connect(settings.database_url) as conn:
        return conn.execute("SELECT nullifier, user_id FROM world_nullifiers ORDER BY nullifier").fetchall()


def _trial_account_with_wallet(client: TestClient, settings: Settings, nullifier: str | None) -> Account:
    """Signs in as a fresh GitHub account (subject 1), optionally verifies with World ID (`nullifier`),
    links a new wallet to it, and signs out: the account that a later merge will absorb."""
    github_login(client, subject=1, login="absorbed")
    if nullifier is not None:
        assert do_trial(client, settings, nullifier=nullifier).status_code == 200
    wallet = Account.create()
    linked = client.post("/v0/auth/wallet/link", json=_signed_by(wallet, _nonce(client)))
    assert linked.status_code == 200, linked.text
    client.post("/v0/auth/logout")
    client.cookies.clear()
    return wallet


def test_a_merge_moves_the_absorbed_accounts_world_claim_to_the_kept_one(
    world_client: TestClient, settings: Settings
) -> None:
    """Before this was fixed, deleting the absorbed account `SET NULL`ed its claim, and the kept account --
    which inherited `trial_started_at` -- could never claim again: the orphaned row still held the
    nullifier, so the same human re-verifying was refused as someone else."""
    wallet = _trial_account_with_wallet(world_client, settings, "0x1a1a1a")

    github_login(world_client, subject=2, login="kept")
    kept = me(world_client)["user_id"]
    assert merge(world_client, conflict(world_client, wallet)["merge_token"]) == 200

    assert [(str(n), str(u)) for n, u in _claims(settings)] == [(str(0x1A1A1A), kept)]
    # The same human, verifying again on the kept account, is recognised as already verified here.
    again = do_trial(world_client, settings, nullifier="0x1a1a1a")
    assert again.status_code == 200, again.text
    plan = world_client.post("/v0/plans", json=BODY).json()
    assert _approve_with_credits(world_client, plan).status_code == 200


def test_a_merge_keeps_the_kept_accounts_own_claim_when_both_have_one(
    world_client: TestClient, settings: Settings
) -> None:
    """Two claims for one action cannot both belong to one account (`world_nullifiers_one_per_user`): the
    kept account keeps its own, and the absorbed one's stays behind, orphaned, so that nullifier still
    can never be claimed again -- and the merge itself does not fail on the unique index."""
    wallet = _trial_account_with_wallet(world_client, settings, "0x2b2b2b")

    github_login(world_client, subject=2, login="kept")
    assert do_trial(world_client, settings, nullifier="0x3c3c3c").status_code == 200
    kept = me(world_client)["user_id"]
    assert merge(world_client, conflict(world_client, wallet)["merge_token"]) == 200

    assert {(str(n), None if u is None else str(u)) for n, u in _claims(settings)} == {
        (str(0x2B2B2B), None),
        (str(0x3C3C3C), kept),
    }
    world_client.post("/v0/auth/logout")
    world_client.cookies.clear()
    github_login(world_client, subject=3, login="third")
    refused = do_trial(world_client, settings, nullifier="0x2b2b2b")
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == ALREADY_USED


def test_a_merge_into_an_unverified_account_needs_no_claim_of_its_own(
    world_client: TestClient, settings: Settings
) -> None:
    """Neither account verified: nothing to move, and the merge goes through as before."""
    wallet = _trial_account_with_wallet(world_client, settings, None)
    github_login(world_client, subject=2, login="kept")
    assert merge(world_client, conflict(world_client, wallet)["merge_token"]) == 200
    assert _claims(settings) == []


# --- unconfigured World: unchanged -------------------------------------------------------------------------


def test_trial_is_unchanged_when_world_is_off(settings: Settings, llm: FakeLLM) -> None:
    off = settings.model_copy(update={"world_app_id": None, "world_rp_id": None, "world_signing_key": None})
    assert not off.world_idkit_enabled
    app = create_app(off, llm=llm, deliver_events=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as client:
        github_login(client)
        response = client.post("/v0/account/trial")
        assert response.status_code == 200, response.text
        assert me(client)["trial"] is not None
    _truncate(off)
