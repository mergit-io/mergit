"""Redeem codes: one-time, hashed at rest, rate limited, and credited through the event outbox in the same
transaction that burns the code. Plus the account's credits view and the ledger key on plan.approved."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from typing import Any

import httpx
import psycopg
import pytest
import respx
from fastapi.testclient import TestClient

from mergit_cp import redeem, redeem_admin
from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.cp_fakes import FakeLLM, result
from tests.test_plans import APPROVE, create, event_validator, outbox, planned, sign_in

pytestmark = pytest.mark.postgres

TABLES = (
    "plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces, redeem_codes, redeem_attempts"
)
SECRET = b"test-secret-at-least-32-bytes-long!!"


@pytest.fixture
def rclient(settings: Settings) -> Iterator[TestClient]:
    llm = FakeLLM([result(planned()) for _ in range(5)])
    with TestClient(create_app(settings, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(f"TRUNCATE {TABLES} CASCADE")


def new_codes(
    settings: Settings, amount: int = 20_000_000, count: int = 1, **kw: Any
) -> list[tuple[str, str]]:
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        return redeem_admin.create_codes(conn, SECRET, amount, count, kw.pop("note", ""), **kw)


def user_id(client: TestClient) -> str:
    return client.get("/v0/auth/me").json()["user_id"]


def grants(settings: Settings) -> list[dict[str, Any]]:
    return [e for e in outbox(settings) if e["type"] == "credits.grant"]


# --- the code itself ----------------------------------------------------------------------------------


def test_a_code_has_the_documented_shape_and_is_not_repeated() -> None:
    codes = {redeem.new_code() for _ in range(200)}
    assert len(codes) == 200
    for c in codes:
        assert len(c) == len("MRG-XXXX-XXXX-XXXX-XXXX") and c.startswith("MRG-")
        assert set(c.replace("-", "")[3:]) <= set(redeem.ALPHABET)


def test_normalising_forgives_case_spaces_hyphens_and_look_alike_letters() -> None:
    assert redeem.normalise("mrg-abcd-efgh-jkmn-pqrs") == redeem.normalise(" MRG ABCD EFGH JKMN PQRS ")
    # Crockford: O reads as 0 and I or L as 1, so a code read aloud still works.
    assert redeem.normalise("MRG-0O1I-L000-0000-0000") == redeem.normalise("MRG-0011-1000-0000-0000")
    assert redeem.normalise("MRG-0O1I-L000-0000-0000") is not None
    for bad in (
        "",
        "abc",
        "MRG-ABCD",
        "XYZ-ABCD-EFGH-JKMN-PQRS",
        "MRG-ABCD-EFGH-JKMN-PQRS-TVWX",
        "MRG-UUUU-UUUU-UUUU-UUUU",
    ):
        assert redeem.normalise(bad) is None, bad


def test_codes_are_stored_only_as_hashes(settings: Settings, rclient: TestClient) -> None:
    [(code_id, code)] = new_codes(settings, note="for a tester")
    plain = redeem.normalise(code)
    assert plain is not None
    rows = _rows(settings, "SELECT code_id::text, code_hash, note FROM redeem_codes")
    assert [(r[0], bytes(r[1]), r[2]) for r in rows] == [
        (code_id, redeem.code_hash(SECRET, plain), "for a tester")
    ]
    dump = json.dumps(_rows(settings, "SELECT row_to_json(c)::text FROM redeem_codes c"))
    assert code not in dump and plain not in dump and plain[3:] not in dump


def _rows(settings: Settings, sql: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(settings.database_url) as conn:
        return conn.execute(sql).fetchall()  # type: ignore[arg-type]


# --- redeeming ----------------------------------------------------------------------------------------


def test_redeeming_credits_the_account_through_the_outbox(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    [(code_id, code)] = new_codes(settings, 20_000_000)
    r = rclient.post("/v0/account/redeem", json={"code": code})
    assert r.status_code == 200, r.text
    assert r.json() == {"amount_usdc_units": "20000000"}
    [event] = grants(settings)
    event_validator().validate(event)
    assert event["payload"] == {
        "account": user_id(rclient),
        "amount_usdc_units": "20000000",
        "ref": f"redeem-{code_id}",
    }


def test_a_code_works_once_for_anyone(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    [(_, code)] = new_codes(settings)
    assert rclient.post("/v0/account/redeem", json={"code": code}).status_code == 200
    again = rclient.post("/v0/account/redeem", json={"code": code})
    assert again.status_code == 409 and again.json()["detail"]["error"] == "already_redeemed"
    assert len(grants(settings)) == 1, "no second grant"
    # Another person with the same code gets the same answer.
    other = TestClient(rclient.app, base_url="https://testserver")
    sign_in(other)
    assert other.post("/v0/account/redeem", json={"code": code}).status_code == 409
    assert len(grants(settings)) == 1


def test_a_person_can_redeem_several_different_codes(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    codes = new_codes(settings, 1_000_000, count=3)
    for _, c in codes:
        assert rclient.post("/v0/account/redeem", json={"code": c}).status_code == 200
    assert len(grants(settings)) == 3
    assert len({e["payload"]["ref"] for e in grants(settings)}) == 3


def test_unknown_malformed_revoked_and_expired_codes_are_refused(
    settings: Settings, rclient: TestClient
) -> None:
    sign_in(rclient)
    post = lambda c: rclient.post("/v0/account/redeem", json={"code": c})  # noqa: E731
    assert post("MRG-AAAA-AAAA-AAAA-AAAA").json()["detail"]["error"] == "invalid_code"
    assert post("not a code").json()["detail"]["error"] == "invalid_code"
    [(revoked_id, revoked)] = new_codes(settings)
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        redeem_admin.revoke(conn, revoked_id)
    assert post(revoked).status_code == 400 and post(revoked).json()["detail"]["error"] == "invalid_code"
    [(expired_id, expired)] = new_codes(settings)
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute(
            "UPDATE redeem_codes SET expires_at = now() - interval '1 minute' WHERE code_id = %s",
            (expired_id,),
        )
    r = post(expired)
    assert r.status_code == 410 and r.json()["detail"]["error"] == "expired"
    assert grants(settings) == []


def test_redeeming_needs_a_signed_in_account(settings: Settings, rclient: TestClient) -> None:
    [(_, code)] = new_codes(settings)
    assert rclient.post("/v0/account/redeem", json={"code": code}).status_code == 401
    assert grants(settings) == []


def test_extra_fields_and_oversized_codes_are_rejected(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    assert rclient.post("/v0/account/redeem", json={"code": "x", "amount": 5}).status_code == 422
    assert rclient.post("/v0/account/redeem", json={"code": "x" * 500}).status_code == 422


def test_guessing_is_rate_limited_and_the_limit_hides_valid_codes(settings: Settings) -> None:
    limited = settings.model_copy(update={"redeem_attempts_per_hour": 3})
    [(_, code)] = new_codes(limited)
    llm = FakeLLM([])
    with TestClient(create_app(limited, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        sign_in(c)
        for _ in range(3):
            assert c.post("/v0/account/redeem", json={"code": "MRG-AAAA-AAAA-AAAA-AAAA"}).status_code == 400
        r = c.post("/v0/account/redeem", json={"code": code})
        assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
        assert grants(limited) == []
    with psycopg.connect(limited.database_url) as conn:
        conn.execute(f"TRUNCATE {TABLES} CASCADE")


def test_two_simultaneous_redemptions_of_one_code_credit_it_once(
    settings: Settings, rclient: TestClient
) -> None:
    [(_, code)] = new_codes(settings)
    clients = [TestClient(rclient.app, base_url="https://testserver") for _ in range(4)]
    for c in clients:
        sign_in(c)
    statuses: list[int] = []
    barrier = threading.Barrier(len(clients))

    def go(c: TestClient) -> None:
        barrier.wait()
        statuses.append(c.post("/v0/account/redeem", json={"code": code}).status_code)

    threads = [threading.Thread(target=go, args=(c,)) for c in clients]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [200, 409, 409, 409]
    assert len(grants(settings)) == 1


def test_a_browser_on_another_origin_may_read_how_long_to_wait(rclient: TestClient) -> None:
    """Retry-After is hidden from cross-origin scripts unless the API exposes it, and the app tells people how
    long to wait from it."""
    response = rclient.get("/v0/auth/providers", headers={"origin": "http://localhost:5173"})
    exposed = response.headers.get("access-control-expose-headers", "").lower()
    assert "retry-after" in exposed


def test_the_grant_is_retried_for_days_not_minutes(settings: Settings, rclient: TestClient) -> None:
    """A code burned with no credit delivered would be a loss, so the event outlives a long gateway outage."""
    sign_in(rclient)
    [(_, code)] = new_codes(settings)
    rclient.post("/v0/account/redeem", json={"code": code})
    [(left_s,)] = _rows(
        settings, "SELECT extract(epoch FROM give_up_at - now()) FROM outbox WHERE type = 'credits.grant'"
    )
    assert float(left_s) > 6 * 24 * 3600


def test_redeeming_works_while_the_gateway_is_down(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    [(_, code)] = new_codes(settings)
    with respx.mock:  # nothing is mocked, so any call to the gateway would raise
        assert rclient.post("/v0/account/redeem", json={"code": code}).status_code == 200


# --- the admin side -----------------------------------------------------------------------------------


def test_creating_codes_validates_the_amount_and_count(settings: Settings) -> None:
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        for amount, count in ((0, 1), (-5, 1), (10**13, 1), (1, 0), (1, 1001)):
            with pytest.raises(ValueError):
                redeem_admin.create_codes(conn, SECRET, amount, count, "")


def test_listing_never_shows_a_code_and_shows_who_redeemed(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    [(code_id, code)] = new_codes(settings, 7_500_000, note="demo")
    rclient.post("/v0/account/redeem", json={"code": code})
    with psycopg.connect(settings.database_url) as conn:
        rows = redeem_admin.list_codes(conn)
    text = json.dumps(rows, default=str)
    assert code not in text and redeem.normalise(code) not in text
    [row] = rows
    assert str(row["code_id"]) == code_id and row["state"] == "redeemed" and row["note"] == "demo"
    assert row["redeemed_by"] == user_id(rclient)


def test_the_amount_argument_is_in_usdc_and_exact() -> None:
    assert redeem_admin.usdc_to_units("20") == 20_000_000
    assert redeem_admin.usdc_to_units("7.5") == 7_500_000
    assert redeem_admin.usdc_to_units("0.000001") == 1
    for bad in ("0", "-1", "1.0000001", "abc", "", "1e3"):
        with pytest.raises(ValueError):
            redeem_admin.usdc_to_units(bad)


# --- the account's credits ------------------------------------------------------------------------------


@respx.mock
def test_account_credits_come_from_the_gateway_for_this_user_only(
    settings: Settings, rclient: TestClient
) -> None:
    sign_in(rclient)
    uid = user_id(rclient)
    body = {
        "granted_usdc_units": "25000000",
        "spent_usdc_units": "0",
        "remaining_usdc_units": "25000000",
        "plans_today": 0,
    }
    route = respx.get(f"http://gateway.invalid/v0/credits/account/{uid}").mock(
        return_value=httpx.Response(200, json=body)
    )
    r = rclient.get("/v0/account/credits")
    assert r.status_code == 200 and r.json() == body
    assert route.call_count == 1


def test_account_credits_need_a_session(rclient: TestClient) -> None:
    assert rclient.get("/v0/account/credits").status_code == 401


@respx.mock
def test_account_credits_say_so_when_the_gateway_is_unreachable(
    settings: Settings, rclient: TestClient
) -> None:
    sign_in(rclient)
    respx.get(url__regex=r"http://gateway.invalid/.*").mock(side_effect=httpx.ConnectError("down"))
    r = rclient.get("/v0/account/credits")
    assert r.status_code == 502 and r.json()["detail"]["error"] == "credits_unavailable"
    respx.get(url__regex=r"http://gateway.invalid/.*").mock(return_value=httpx.Response(500, text="boom"))
    assert rclient.get("/v0/account/credits").status_code == 502


# --- the ledger key on plan.approved -------------------------------------------------------------------


def test_a_credits_plan_names_the_account_that_pays(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    plan = create(rclient)
    body = {"agents": APPROVE["agents"], "funding": "credits"}
    assert rclient.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=body).status_code == 200
    [event] = [e for e in outbox(settings) if e["type"] == "plan.approved"]
    event_validator().validate(event)
    assert event["payload"]["credit_account"] == user_id(rclient)


def test_a_wallet_plan_names_no_credit_account(settings: Settings, rclient: TestClient) -> None:
    sign_in(rclient)
    plan = create(rclient)
    assert rclient.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE).status_code == 200
    [event] = [e for e in outbox(settings) if e["type"] == "plan.approved"]
    assert "credit_account" not in event["payload"]
