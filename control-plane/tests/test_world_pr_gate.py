"""The World Agent Pass human-approval gate on `POST /v0/plans/{id}/open-pr` (plan sec 1.7), driven
entirely through HTTP, mirroring `test_world_approve_gate.py`'s coverage of the sibling `approve` gate:
428 when a fresh approval is needed, the popup's `/start` -> World login -> `/callback` journey with a
minted ID token, and the `X-World-Approval` header redeeming it against the `open_pr` action_hash
(`plan_uuid`, `diff_sha256` -- plan sec 1.6). Run with `pytest -m postgres`.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import mergit_receipt
import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from mergit_cp import auth
from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.cp_fakes import FakeLLM, result
from tests.test_plans import create, planned, sign_in
from tests.test_world_approve_gate import start_world, world_callback
from tests.world_fakes_idp import rsa_key

pytestmark = pytest.mark.postgres


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM([result(planned()) for _ in range(20)])


@pytest.fixture
def settings(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "world_idp_client_id": "test-client",
            "world_idp_client_secret": SecretStr("test-client-secret"),
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
def app_client(settings: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    app = create_app(settings, llm=llm, deliver_events=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as c:
        yield c
    _truncate(settings)


def finish_plan(settings: Settings, plan_uuid: str, patches: tuple[str, ...] = ("patch0", "patch1")) -> None:
    """Drives a plan straight to `done`, with a passing, patch-bearing job per task -- the state
    `pr_gate.blockers` requires before `open-pr` may be gated or queued at all. Bypasses the real
    dispatch/outcome pipeline (irrelevant to this gate) the same way `tests/test_pr_store.py` seeds its
    rows directly."""
    plan_id = mergit_receipt.plan_id(plan_uuid)
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "UPDATE plans SET state = 'done', funding = 'wallet',"
            " total_budget_usdc_units = budget_usdc_units, approved_at = now() WHERE plan_uuid = %s",
            (plan_uuid,),
        )
        for index, patch in enumerate(patches):
            task_id = mergit_receipt.task_id(plan_id, index, 1)
            conn.execute(
                'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, phi_holds, patch)'
                " VALUES (%s, %s, %s, 1, '1', 'done', true, %s)",
                (task_id, plan_uuid, index, patch),
            )


def require_pr_approval(client: TestClient, plan_uuid: str) -> dict[str, Any]:
    response = client.post(f"/v0/plans/{plan_uuid}/open-pr")
    assert response.status_code == 428, response.text
    return response.json()["detail"]


def test_open_pr_needs_a_fresh_approval(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])

    detail = require_pr_approval(app_client, plan["plan_uuid"])
    assert detail["code"] == "human_approval_required"
    assert detail["start_url"] == f"/v0/world/approvals/{detail['approval_id']}/start"
    assert detail["summary"]["repo_url"] == plan["repo_url"]
    assert "diff_sha256" in detail["summary"]
    assert len(detail["summary"]["diff_sha256"]) == 64


def test_approved_open_pr_queues_the_request(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])

    detail = require_pr_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]
    state, nonce = start_world(app_client, approval_id)
    key = rsa_key()
    callback = world_callback(app_client, key, state=state, nonce=nonce)
    assert callback.status_code == 302
    assert "status=approved" in callback.headers["location"]

    approved = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/open-pr", headers={"X-World-Approval": approval_id}
    )
    assert approved.status_code == 202, approved.text
    body = approved.json()
    assert body["status"] == "queued"

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT status FROM world_approvals WHERE approval_id = %s", (approval_id,)
        ).fetchone()
    assert row == ("consumed",)

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT status FROM pr_requests WHERE plan_uuid = %s", (plan["plan_uuid"],)
        ).fetchone()
    assert row == ("queued",)


def test_diff_changed_after_approval_is_refused(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"], patches=("patch0", "patch1"))

    detail = require_pr_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]
    state, nonce = start_world(app_client, approval_id)
    key = rsa_key()
    assert world_callback(app_client, key, state=state, nonce=nonce).status_code == 302

    # The underlying diff changes after the approval was minted (a task's stored patch is rewritten) --
    # the recomputed `diff_sha256` at redemption time no longer matches the approved `action_hash`.
    with psycopg.connect(settings.database_url) as conn:
        plan_id = mergit_receipt.plan_id(plan["plan_uuid"])
        task_id = mergit_receipt.task_id(plan_id, 0, 1)
        conn.execute("UPDATE jobs SET patch = 'patch0-changed' WHERE task_id = %s", (task_id,))

    mismatched = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/open-pr", headers={"X-World-Approval": approval_id}
    )
    assert mismatched.status_code == 403
    assert mismatched.json()["detail"] == {"code": "human_approval_invalid", "reason": "action_mismatch"}

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT count(*) FROM pr_requests WHERE plan_uuid = %s", (plan["plan_uuid"],)
        ).fetchone()
    assert row == (0,)


# --- the closure's own reject paths (Important #1 of the review round) ---------------------------------


def test_unknown_approval_header_gets_a_fresh_428(app_client: TestClient, settings: Settings) -> None:
    """A header naming an approval_id that does not exist at all gets the same 428 retry path as no header
    at all -- not a 403 -- mirroring `test_world_approve_gate.py`'s
    `test_unknown_approval_header_gets_a_fresh_428_not_403` for the sibling gate."""
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])
    bogus = str(uuid.uuid4())

    response = app_client.post(f"/v0/plans/{plan['plan_uuid']}/open-pr", headers={"X-World-Approval": bogus})
    assert response.status_code == 428, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "human_approval_required"
    assert detail["approval_id"] != bogus  # a freshly created approval, not the bogus id echoed back

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT status FROM world_approvals WHERE approval_id = %s", (detail["approval_id"],)
        ).fetchone()
    assert row == ("pending",)  # the fresh-428 path really did persist a new row


def test_an_approval_for_someone_elses_plan_still_gets_403_not_yours(
    app_client: TestClient, settings: Settings
) -> None:
    """The distinction `unknown` vs `not_yours` preserves: an approval_id that *does* exist, but was minted
    for a different plan (here, also under a different account, the same way
    `test_world_approve_gate.py::test_an_approval_that_exists_for_someone_else_still_gets_403` drives it),
    is a 403 `not_yours` -- only a genuinely unknown id gets the 428 treatment."""
    sign_in(app_client)
    owners_plan = create(app_client)
    finish_plan(settings, owners_plan["plan_uuid"])
    owners_detail = require_pr_approval(app_client, owners_plan["plan_uuid"])

    sign_in(app_client)  # a second, different account (fresh wallet) on the same client
    other_plan = create(app_client)
    finish_plan(settings, other_plan["plan_uuid"])

    response = app_client.post(
        f"/v0/plans/{other_plan['plan_uuid']}/open-pr",
        headers={"X-World-Approval": owners_detail["approval_id"]},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "human_approval_invalid", "reason": "not_yours"}


def test_malformed_approval_header_gets_a_fresh_428_not_a_crash(
    app_client: TestClient, settings: Settings
) -> None:
    """`X-World-Approval` is typed `str | None` here (not `UUID`, unlike the sibling `approve` route), so a
    value that is not even a UUID is handled inside the gate, not left to blow up as an unhandled parse
    error or a bare 500."""
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])

    response = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/open-pr", headers={"X-World-Approval": "garbage"}
    )
    assert response.status_code == 428, response.text
    assert response.json()["detail"]["code"] == "human_approval_required"


def test_gate_rejects_when_the_requester_does_not_match_the_signed_in_session(
    app_client: TestClient, settings: Settings
) -> None:
    """Important #2 of the review round: the gate's own authenticated identity (resolved from the request's
    session cookie) must actually cover the `requester` the route hands it, not just happen to agree with it
    by construction. `auth.current_address` is overridden here to make the route compute a `requester` the
    signed-in session does not own, which nothing in today's real dependency wiring can produce on its own
    (`get_requester` and the gate's own lookup both derive from the same cookie) -- this proves the gate's
    own check is what would catch a future divergence (e.g. an agent-token path), not incidental agreement.
    `own_plan`'s ownership check is unaffected: it is driven by `auth.owned_addresses_dep` (not overridden
    here), which still resolves the real session's addresses, so the request reaches the gate at all."""
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])

    other_address = "0x" + "9" * 40
    app_client.app.dependency_overrides[auth.current_address] = lambda: other_address  # type: ignore[attr-defined]
    try:
        response = app_client.post(f"/v0/plans/{plan['plan_uuid']}/open-pr")
    finally:
        app_client.app.dependency_overrides.pop(auth.current_address, None)  # type: ignore[attr-defined]

    assert response.status_code == 403, response.text

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("SELECT count(*) FROM world_approvals").fetchone()
    assert row == (0,)  # rejected before any approval was ever created for the mismatched identity


def test_already_opened_pr_needs_no_new_approval(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    finish_plan(settings, plan["plan_uuid"])

    detail = require_pr_approval(app_client, plan["plan_uuid"])
    approval_id = detail["approval_id"]
    state, nonce = start_world(app_client, approval_id)
    key = rsa_key()
    assert world_callback(app_client, key, state=state, nonce=nonce).status_code == 302
    opened = app_client.post(
        f"/v0/plans/{plan['plan_uuid']}/open-pr", headers={"X-World-Approval": approval_id}
    )
    assert opened.status_code == 202, opened.text

    # The worker finishes the request out from under the gate.
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "UPDATE pr_requests SET status = 'done', branch = 'mergit/x', commit_sha = 'c0ffee',"
            " pr_number = 9, pr_url = 'https://github.com/acme/widgets/pull/9'"
            " WHERE plan_uuid = %s",
            (plan["plan_uuid"],),
        )

    with psycopg.connect(settings.database_url) as conn:
        before = conn.execute("SELECT count(*) FROM world_approvals").fetchone()
    assert before is not None
    count_before = before[0]

    # No `X-World-Approval` header at all: if the gate ran, this would 428 (a fresh approval is always
    # needed without one). A plain 200 with no new approval row proves the already-`done` short-circuit
    # skipped the gate entirely rather than happening to satisfy it.
    again = app_client.post(f"/v0/plans/{plan['plan_uuid']}/open-pr")
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "done"

    with psycopg.connect(settings.database_url) as conn:
        after = conn.execute("SELECT count(*) FROM world_approvals").fetchone()
    assert after is not None
    assert after[0] == count_before  # no new approval row was created either


def test_gate_is_off_when_agent_pass_is_not_configured(settings: Settings) -> None:
    off = settings.model_copy(update={"world_idp_client_id": None, "world_idp_client_secret": None})
    assert not off.world_idp_enabled
    llm = FakeLLM([result(planned())])
    with TestClient(create_app(off, llm=llm, deliver_events=False), base_url="https://testserver") as client:
        sign_in(client)
        plan = create(client)
        finish_plan(off, plan["plan_uuid"])
        response = client.post(f"/v0/plans/{plan['plan_uuid']}/open-pr")
        assert response.status_code == 202, response.text
    _truncate(off)
