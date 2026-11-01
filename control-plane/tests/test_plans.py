"""Plans: draft, edit, approve (plan task O3). Only the requester edits or approves, and an approved plan
never changes. Run with `pytest -m postgres`."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import jsonschema
import mergit_receipt
import psycopg
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient
from siwe import SiweMessage

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from tests.conftest import APP_DOMAIN
from tests.cp_fakes import FakeLLM, result

pytestmark = pytest.mark.postgres

SPEC = Path(__file__).resolve().parents[2] / "spec" / "schemas"
GOAL = "Fix the failing refund test"
BODY = {
    "goal": GOAL,
    "repo_url": "https://github.com/mergit-io/demo-repo",
    "ref": "main",
    "budget_usdc_units": "2000000",
    "category": "test-repair",
}


def phi(**over: Any) -> dict[str, Any]:
    return {
        "kind": "exec/0",
        "command": ["pytest", "tests/test_refund.py", "-q"],
        "expected_exit": 0,
        "workdir": ".",
        "allowed_paths": ["payments/**"],
        "artifact_hashes": None,
        "timeout_s": 600,
    } | over


def planned(n: int = 2) -> str:
    tasks = [
        {
            "title": f"Task {i}",
            "instructions": "Do the work.",
            "phi": phi(),
            "budget_usdc_units": 500_000,
            "depends_on": [i - 1] if i else [],
        }
        for i in range(n)
    ]
    return json.dumps({"tasks": tasks})


def sign_in(client: TestClient) -> str:
    account = Account.create()
    nonce = client.get("/v0/auth/nonce").json()["nonce"]
    message = SiweMessage.model_validate(
        {
            "domain": APP_DOMAIN,
            "address": account.address,
            "uri": f"https://{APP_DOMAIN}",
            "version": "1",
            "chain_id": 84532,
            "issued_at": "2026-10-28T10:00:00.000Z",
            "nonce": nonce,
        }
    ).prepare_message()
    signature = account.sign_message(encode_defunct(text=message)).signature.to_0x_hex()
    assert (
        client.post("/v0/auth/verify", json={"message": message, "signature": signature}).status_code == 200
    )
    return account.address.lower()


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM([result(planned()) for _ in range(20)])


@pytest.fixture
def settings(settings: Settings, tmp_path: Path) -> Settings:
    """Two agents, so a requester can list a retry agent."""
    chain = tmp_path / "two-agents.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": i,
                        "name": f"agent-{i}",
                        "operator": "0x" + "1" * 40,
                        "runtime_key": "0x" + "2" * 40,
                    }
                    for i in ("1", "2")
                ]
            }
        )
    )
    config = tmp_path / "two-agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        + "".join(
            f'[agents.agent-{i}]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n'
            for i in ("1", "2")
        )
    )
    return settings.model_copy(update={"agents_file": str(chain), "agents_config": str(config)})


@pytest.fixture
def app_client(settings: Settings, llm: FakeLLM) -> Iterator[TestClient]:
    with TestClient(create_app(settings, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "TRUNCATE plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces CASCADE"
        )


def create(client: TestClient, **over: Any) -> dict[str, Any]:
    response = client.post("/v0/plans", json=BODY | over)
    assert response.status_code == 201, response.text
    return response.json()


def outbox(settings: Settings) -> list[dict[str, Any]]:
    with psycopg.connect(settings.database_url) as conn:
        return [row[0] for row in conn.execute("SELECT body FROM outbox ORDER BY id").fetchall()]


def event_validator() -> jsonschema.Draft202012Validator:
    from referencing import Registry, Resource

    schemas = [json.loads(p.read_text()) for p in SPEC.glob("*.json")]
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
    event = next(s for s in schemas if s["$id"].endswith("/event.json"))
    return jsonschema.Draft202012Validator(event, registry=registry)


APPROVE = {"agents": {"0": ["1"], "1": ["1"]}, "funding": "wallet"}


# --- create ---------------------------------------------------------------------------------------


def test_create_requires_session(app_client: TestClient) -> None:
    assert app_client.post("/v0/plans", json=BODY).status_code == 401


def test_create_stores_a_draft_with_spec_plan_id(app_client: TestClient) -> None:
    requester = sign_in(app_client)
    plan = create(app_client)
    assert plan["state"] == "draft"
    assert plan["requester"] == requester
    assert plan["plan_id"] == mergit_receipt.plan_id(plan["plan_uuid"])
    assert plan["budget_usdc_units"] == "2000000"
    assert [t["index"] for t in plan["tasks"]] == [0, 1]
    assert plan["tasks"][1]["depends_on"] == [0]
    assert plan["tasks"][0]["budget_usdc_units"] == "500000"


@pytest.mark.parametrize(
    "over",
    [
        {"budget_usdc_units": 2000000},  # a number, not a decimal string
        {"budget_usdc_units": "0"},
        {"budget_usdc_units": "-5"},
        {"repo_url": "http://github.com/a/b"},
        {"repo_url": "https://evil.example/a/b"},
        {"repo_url": "file:///etc"},
        {"ref": "../../etc"},
        {"ref": "-c core.sshCommand=x"},
        {"category": "Test Repair!"},
        {"goal": ""},
    ],
)
def test_create_rejects_bad_input_before_spending_on_the_model(
    app_client: TestClient, llm: FakeLLM, over: dict[str, Any]
) -> None:
    sign_in(app_client)
    assert app_client.post("/v0/plans", json=BODY | over).status_code == 422
    assert llm.calls == []


def test_planning_failure_returns_the_problems(settings: Settings) -> None:
    bad = json.dumps(
        {
            "tasks": [
                {
                    "title": "t",
                    "instructions": "i",
                    "phi": phi(command=["true"]),
                    "budget_usdc_units": 1,
                    "depends_on": [],
                }
            ]
        }
    )
    with TestClient(
        create_app(settings, llm=FakeLLM([result(bad), result(bad)]), deliver_events=False),
        base_url="https://testserver",
    ) as client:
        sign_in(client)
        response = client.post("/v0/plans", json=BODY)
    assert response.status_code == 422
    assert any("cannot fail" in p for p in response.json()["detail"]["problems"])
    with psycopg.connect(settings.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM plans").fetchone() == (0,)
        assert conn.execute("SELECT count(*) FROM planner_costs").fetchone() == (2,)
        conn.execute("TRUNCATE planning_attempts, planner_costs, sessions, auth_nonces")


def test_planner_calls_are_rate_limited_per_requester(settings: Settings, llm: FakeLLM) -> None:
    limited = settings.model_copy(update={"plans_per_hour": 2})
    with TestClient(create_app(limited, llm=llm, deliver_events=False), base_url="https://testserver") as c:
        sign_in(c)
        create(c)
        create(c)
        assert c.post("/v0/plans", json=BODY).status_code == 429
    assert len(llm.calls) == 2
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            "TRUNCATE plans, outbox, planning_attempts, planner_costs, sessions, auth_nonces CASCADE"
        )


# --- edit -----------------------------------------------------------------------------------------


def tasks_body(n: int = 2, **phi_over: Any) -> dict[str, Any]:
    return {
        "tasks": [
            {
                "title": f"Edited {i}",
                "instructions": "Edited instructions.",
                "phi": phi(**phi_over),
                "budget_usdc_units": "600000",
                "depends_on": [0] if i else [],
            }
            for i in range(n)
        ]
    }


def test_requester_edits_tasks_while_draft(app_client: TestClient) -> None:
    sign_in(app_client)
    plan = create(app_client)
    response = app_client.patch(f"/v0/plans/{plan['plan_uuid']}", json=tasks_body(3))
    assert response.status_code == 200, response.text
    edited = response.json()
    assert [t["title"] for t in edited["tasks"]] == ["Edited 0", "Edited 1", "Edited 2"]
    assert edited["tasks"][2]["budget_usdc_units"] == "600000"


@pytest.mark.parametrize(
    "body",
    [
        tasks_body(command=["true"]),  # predicate that cannot fail
        tasks_body(3)
        | {"tasks": [t | {"budget_usdc_units": "900000"} for t in tasks_body(3)["tasks"]]},  # over
        {"tasks": [tasks_body(1)["tasks"][0] | {"depends_on": [0]}]},  # self-dependency
        {"tasks": []},
        {"tasks": [tasks_body(1)["tasks"][0] | {"budget_usdc_units": 5}]},  # number, not string
    ],
)
def test_edit_is_checked_like_a_planner_answer(app_client: TestClient, body: dict[str, Any]) -> None:
    sign_in(app_client)
    plan = create(app_client)
    assert app_client.patch(f"/v0/plans/{plan['plan_uuid']}", json=body).status_code == 422


def test_only_requester_can_edit_or_approve(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    app_client.cookies.clear()
    sign_in(app_client)  # a different wallet
    uid = plan["plan_uuid"]
    assert app_client.patch(f"/v0/plans/{uid}", json=tasks_body()).status_code == 403
    assert app_client.post(f"/v0/plans/{uid}/approve", json=APPROVE).status_code == 403
    assert outbox(settings) == []


def test_unknown_plan_is_404(app_client: TestClient) -> None:
    sign_in(app_client)
    uid = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b"
    assert app_client.patch(f"/v0/plans/{uid}", json=tasks_body()).status_code == 404
    assert app_client.post(f"/v0/plans/{uid}/approve", json=APPROVE).status_code == 404


# --- approve --------------------------------------------------------------------------------------


def test_approve_sends_plan_approved_with_spec_plan_id(app_client: TestClient, settings: Settings) -> None:
    requester = sign_in(app_client)
    plan = create(app_client)
    response = app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "plan_id": mergit_receipt.plan_id(plan["plan_uuid"]),
        "total_budget_usdc_units": "1000000",
    }
    [event] = outbox(settings)
    event_validator().validate(event)
    assert event["type"] == "plan.approved"
    assert event["payload"] == {
        "plan_id": mergit_receipt.plan_id(plan["plan_uuid"]),
        "plan_uuid": plan["plan_uuid"],
        "requester": requester,
        "total_budget_usdc_units": "1000000",
        "funding": "wallet",
    }


def test_approval_freezes_phi_hash_and_agent_picks(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    picks = {"agents": {"0": ["2", "1"], "1": ["1"]}, "funding": "credits"}
    assert app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=picks).status_code == 200
    with psycopg.connect(settings.database_url) as conn:
        rows = conn.execute(
            'SELECT "index", phi, phi_hash, agents FROM tasks WHERE plan_uuid = %s ORDER BY "index"',
            (plan["plan_uuid"],),
        ).fetchall()
        state = conn.execute(
            "SELECT state, funding FROM plans WHERE plan_uuid = %s", (plan["plan_uuid"],)
        ).fetchone()
    assert state == ("approved", "credits")
    assert [r[3] for r in rows] == [["2", "1"], ["1"]]
    for _, stored_phi, stored_hash, _ in rows:
        assert stored_hash == mergit_receipt.phi_hash(json.dumps(stored_phi))


def test_approve_accepts_auto_and_rejects_options_on_picks(
    app_client: TestClient, settings: Settings
) -> None:
    sign_in(app_client)
    plan = create(app_client)
    body = {"agents": {"0": "auto", "1": ["1"]}, "funding": "wallet"}
    assert app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=body).status_code == 200

    plan2 = create(app_client)  # a second draft, still owned by the same signed-in requester
    bad = {
        "agents": {"0": ["1"], "1": ["1"]},
        "routing": {"0": {"explore": False}},
        "funding": "wallet",
    }
    response = app_client.post(f"/v0/plans/{plan2['plan_uuid']}/approve", json=bad)
    assert response.status_code == 422
    assert any(
        p == "task 0: routing options are only valid when agents is 'auto'"
        for p in response.json()["detail"]["problems"]
    )


def test_approve_auto_leaves_agents_null(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    body = {"agents": {"0": "auto", "1": ["1"]}, "funding": "wallet"}
    assert app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=body).status_code == 200
    with psycopg.connect(settings.database_url) as conn:
        rows = conn.execute(
            'SELECT "index", agents, routing FROM tasks WHERE plan_uuid = %s ORDER BY "index"',
            (plan["plan_uuid"],),
        ).fetchall()
    assert rows[0] == (0, None, "auto")
    assert rows[1] == (1, ["1"], "pick")


def test_approve_requires_agent_for_every_task(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    for picks in ({"0": ["1"]}, {"0": ["1"], "1": []}, {"0": ["1"], "1": ["1"], "2": ["1"]}):
        response = app_client.post(
            f"/v0/plans/{plan['plan_uuid']}/approve", json={"agents": picks, "funding": "wallet"}
        )
        assert response.status_code == 422, picks
    assert outbox(settings) == []


def test_approve_rejects_unknown_agent_id(app_client: TestClient) -> None:
    sign_in(app_client)
    plan = create(app_client)
    picks = {"agents": {"0": ["1"], "1": ["99"]}, "funding": "wallet"}
    assert app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=picks).status_code == 422


def test_approve_rejects_duplicate_or_too_many_agents(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    for picks in ({"0": ["1", "1"], "1": ["1"]}, {"0": ["1", "2", "1", "2"], "1": ["1"]}):
        assert (
            app_client.post(
                f"/v0/plans/{plan['plan_uuid']}/approve", json={"agents": picks, "funding": "wallet"}
            ).status_code
            == 422
        )


def test_approve_rejects_unknown_funding(app_client: TestClient) -> None:
    sign_in(app_client)
    plan = create(app_client)
    assert (
        app_client.post(
            f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE | {"funding": "card"}
        ).status_code
        == 422
    )


def test_approved_plan_is_immutable(app_client: TestClient, settings: Settings) -> None:
    sign_in(app_client)
    plan = create(app_client)
    uid = plan["plan_uuid"]
    assert app_client.post(f"/v0/plans/{uid}/approve", json=APPROVE).status_code == 200
    assert app_client.patch(f"/v0/plans/{uid}", json=tasks_body()).status_code == 409
    assert app_client.post(f"/v0/plans/{uid}/approve", json=APPROVE).status_code == 409
    assert len(outbox(settings)) == 1


def test_approve_rejects_plan_with_failing_predicate_check(
    app_client: TestClient, settings: Settings
) -> None:
    """A Φ that slipped into the table past the PATCH checks is still caught at approval."""
    sign_in(app_client)
    plan = create(app_client)
    with psycopg.connect(settings.database_url) as conn:
        conn.execute(
            'UPDATE tasks SET phi = %s WHERE plan_uuid = %s AND "index" = 1',
            (json.dumps(phi(command=["sh", "-c", "exit 0"])), plan["plan_uuid"]),
        )
    response = app_client.post(f"/v0/plans/{plan['plan_uuid']}/approve", json=APPROVE)
    assert response.status_code == 422
    assert any("cannot fail" in p for p in response.json()["detail"]["problems"])
    assert outbox(settings) == []


def test_worker_reads_an_approved_plan(app_client: TestClient, settings: Settings) -> None:
    """The columns Soham's worker reads (tests/jobs_schema.sql) exist in the real migrations."""
    sign_in(app_client)
    plan = create(app_client)
    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            "SELECT p.plan_id, p.requester, p.category, p.repo_url, p.ref, p.goal, p.state,"
            ' t."index", t.title, t.instructions, t.phi, t.budget_usdc_units'
            ' FROM plans p JOIN tasks t USING (plan_uuid) WHERE p.plan_uuid = %s AND t."index" = 0',
            (plan["plan_uuid"],),
        ).fetchone()
    assert row is not None and row[4] == "main" and row[5] == GOAL and row[10]["kind"] == "exec/0"


def test_model_outage_is_502_and_stores_nothing(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    from mergit_cp.llm import LLMUnavailable

    class Down:
        async def complete(self, *args: Any, **kwargs: Any) -> Any:
            raise LLMUnavailable("connection refused")

    with TestClient(
        create_app(settings, llm=Down(), deliver_events=False), base_url="https://testserver"
    ) as c:
        sign_in(c)
        assert c.post("/v0/plans", json=BODY).status_code == 502
    # The reason reaches the operator's log even though the client only sees "unavailable".
    assert "planner model unavailable: connection refused" in caplog.text
    with psycopg.connect(settings.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM plans").fetchone() == (0,)
        conn.execute("TRUNCATE planning_attempts, sessions, auth_nonces")
