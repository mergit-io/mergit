"""Drafts: a retried or double-clicked request makes one plan, a draft can be discarded, and the repository
and branch must exist (publicly) before a plan is drafted. Run with `pytest -m postgres`."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import psycopg
import pytest
import respx
from fastapi.testclient import TestClient

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.cp_fakes import FakeLLM, result
from tests.test_plans import APPROVE, BODY, create, planned, sign_in

pytestmark = pytest.mark.postgres

API = "https://api.github.com/repos/mergit-io/demo-repo"


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM([result(planned()) for _ in range(20)])


@pytest.fixture
def checked(settings: Settings) -> Settings:
    return settings.model_copy(update={"verify_repos": True})


@pytest.fixture
def client(settings: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    with TestClient(create_app(settings, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "TRUNCATE plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces CASCADE"
        )


@pytest.fixture
def checking_client(checked: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    with TestClient(create_app(checked, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(checked.database_url) as conn:
        conn.execute(
            "TRUNCATE plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces CASCADE"
        )


def rows(settings: Settings, sql: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(settings.database_url) as conn:
        return conn.execute(sql).fetchall()


def post(client: TestClient, key: str | None = None, **over: Any) -> httpx.Response:
    headers = {} if key is None else {"Idempotency-Key": key}
    return client.post("/v0/plans", json=BODY | over, headers=headers)


# --- the repository and branch must exist ---------------------------------------------------------------


@respx.mock
def test_a_missing_or_private_repository_is_refused_before_anything_is_drafted(
    settings: Settings, checking_client: TestClient, llm: FakeLLM
) -> None:
    sign_in(checking_client)
    respx.get(f"{API}/commits/main").mock(return_value=httpx.Response(404, json={}))
    respx.get(API).mock(return_value=httpx.Response(404, json={}))
    r = post(checking_client)
    assert r.status_code == 422
    assert r.json()["detail"]["problems"] == ["mergit-io/demo-repo was not found, or it is private"]
    assert llm.calls == []  # no model money spent on a plan that cannot run
    assert rows(settings, "SELECT 1 FROM plans") == []
    assert rows(settings, "SELECT 1 FROM planning_attempts") == []


@respx.mock
@pytest.mark.parametrize("status", [404, 422])
def test_a_branch_that_does_not_exist_is_refused(
    settings: Settings, checking_client: TestClient, status: int
) -> None:
    sign_in(checking_client)
    respx.get(f"{API}/commits/main").mock(return_value=httpx.Response(status, json={}))
    respx.get(API).mock(return_value=httpx.Response(200, json={"private": False}))
    r = post(checking_client)
    assert r.status_code == 422
    assert r.json()["detail"]["problems"] == ["main is not a branch, tag or commit of mergit-io/demo-repo"]
    assert rows(settings, "SELECT 1 FROM plans") == []


@respx.mock
def test_a_public_repository_and_branch_are_drafted(settings: Settings, checking_client: TestClient) -> None:
    sign_in(checking_client)
    route = respx.get(f"{API}/commits/main").mock(return_value=httpx.Response(200, json={"sha": "a" * 40}))
    assert post(checking_client).status_code == 201
    assert route.call_count == 1  # one call on the happy path


@respx.mock
@pytest.mark.parametrize("status", [403, 429, 500])
def test_github_being_unavailable_does_not_stop_planning(
    settings: Settings, checking_client: TestClient, status: int
) -> None:
    """GitHub rate-limits unauthenticated callers by address, and this server holds no token on purpose. A
    refusal to answer is not a missing repository, so planning goes on and the worker finds out later."""
    sign_in(checking_client)
    respx.get(url__startswith=API).mock(return_value=httpx.Response(status, json={}))
    assert post(checking_client).status_code == 201


@respx.mock
def test_an_unreachable_github_does_not_stop_planning(
    settings: Settings, checking_client: TestClient
) -> None:
    sign_in(checking_client)
    respx.get(url__startswith=API).mock(side_effect=httpx.ConnectError("down"))
    assert post(checking_client).status_code == 201


@respx.mock
def test_a_branch_with_a_slash_is_looked_up_as_written(
    settings: Settings, checking_client: TestClient
) -> None:
    sign_in(checking_client)
    route = respx.get(f"{API}/commits/fix/refund").mock(return_value=httpx.Response(200, json={}))
    assert post(checking_client, ref="fix/refund").status_code == 201
    assert route.call_count == 1


# --- one request, one plan ------------------------------------------------------------------------------


def test_the_same_idempotency_key_returns_the_same_draft(
    settings: Settings, client: TestClient, llm: FakeLLM
) -> None:
    sign_in(client)
    first = post(client, "key-1")
    again = post(client, "key-1")
    assert first.status_code == 201 and again.status_code == 201
    assert again.json()["plan_uuid"] == first.json()["plan_uuid"]
    assert len(llm.calls) == 1  # the retry did not pay for a second plan
    assert len(rows(settings, "SELECT 1 FROM plans")) == 1
    assert len(rows(settings, "SELECT 1 FROM planning_attempts")) == 1


def test_different_keys_or_no_key_make_different_plans(settings: Settings, client: TestClient) -> None:
    sign_in(client)
    ids = {post(client, "a").json()["plan_uuid"], post(client, "b").json()["plan_uuid"]}
    ids |= {post(client).json()["plan_uuid"], post(client).json()["plan_uuid"]}
    assert len(ids) == 4


def test_a_key_belongs_to_the_person_who_used_it(settings: Settings, client: TestClient) -> None:
    sign_in(client)
    mine = post(client, "shared-key").json()["plan_uuid"]
    sign_in(client)  # someone else
    theirs = post(client, "shared-key").json()
    assert theirs["plan_uuid"] != mine


@pytest.mark.parametrize("key", ["", "x" * 101, "has space", "semi;colon"])
def test_a_malformed_idempotency_key_is_refused(settings: Settings, client: TestClient, key: str) -> None:
    sign_in(client)
    assert post(client, key).status_code == 422


# --- discarding a draft ---------------------------------------------------------------------------------


def test_the_owner_discards_a_draft_and_its_tasks(settings: Settings, client: TestClient) -> None:
    sign_in(client)
    plan = create(client)
    assert client.delete(f"/v0/plans/{plan['plan_uuid']}").status_code == 204
    assert rows(settings, "SELECT 1 FROM plans") == []
    assert rows(settings, "SELECT 1 FROM tasks") == []
    assert client.delete(f"/v0/plans/{plan['plan_uuid']}").status_code == 404


def test_only_the_owner_discards_a_draft(settings: Settings, client: TestClient) -> None:
    sign_in(client)
    plan = create(client)
    sign_in(client)  # someone else
    assert client.delete(f"/v0/plans/{plan['plan_uuid']}").status_code == 403
    assert len(rows(settings, "SELECT 1 FROM plans")) == 1


def test_discarding_needs_a_session(settings: Settings, client: TestClient) -> None:
    assert client.delete("/v0/plans/00000000-0000-4000-8000-000000000000").status_code == 401


def test_an_approved_plan_cannot_be_discarded(settings: Settings, client: TestClient) -> None:
    sign_in(client)
    plan = create(client)
    assert client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE).status_code == 200
    assert client.delete(f"/v0/plans/{plan['plan_uuid']}").status_code == 409
    assert len(rows(settings, "SELECT 1 FROM plans")) == 1


def test_a_browser_on_another_origin_may_send_the_idempotency_key(
    settings: Settings, client: TestClient
) -> None:
    r = client.options(
        "/v0/plans",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,idempotency-key",
        },
    )
    assert r.status_code == 200
    assert "idempotency-key" in r.headers["access-control-allow-headers"].lower()
