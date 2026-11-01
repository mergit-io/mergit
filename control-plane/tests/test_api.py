"""The run API and live stream (plan task O7). Run with `pytest -m postgres`.

Plans are seeded straight into whatever state a test needs (draft/approved/funded/running, with jobs and
chain events already in place) rather than driven there through the planner and a real gateway: O2-O4
already test that path. This file only tests what O7 itself reads and streams.
"""

from __future__ import annotations

import asyncio
import json
import random
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mergit_receipt
import psycopg
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb
from siwe import SiweMessage

from mergit_cp import money
from mergit_cp.app import create_app
from mergit_cp.config import Settings
from mergit_cp.db import Pool, open_pool
from mergit_cp.reputation import ingest_due
from tests.conftest import APP_DOMAIN
from tests.support import make_settings

pytestmark = pytest.mark.postgres


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
def settings(settings: Settings) -> Settings:
    """A short poll so the SSE tests do not sit around waiting on the default 1s cadence."""
    return settings.model_copy(update={"sse_poll_s": 0.1})


def run(database_url: str, body: Any) -> Any:
    async def go() -> Any:
        pool = await open_pool(database_url, 4)
        try:
            return await body(pool)
        finally:
            await pool.close()

    return asyncio.run(go())


async def seed_plan(
    pool: Pool, *, requester: str, state: str = "running", n_tasks: int = 2
) -> tuple[str, str, list[str]]:
    """A plan straight in `state`, with one `done`/passed task and the rest `running`, each with a
    matching `task_dispatches` row (so a chain event naming its `task_id` resolves to this plan)."""
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    task_ids: list[str] = []
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
            " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
            " VALUES (%s, %s, %s, 'fix the refund', 'https://github.com/acme/widgets', 'main',"
            " 'test-repair', 1000000, %s, 'wallet', 1000000, 'claude-opus-5', now())",
            (plan_uuid, plan_id, requester, state),
        )
        for i in range(n_tasks):
            task_id = mergit_receipt.task_id(plan_id, i, 1)
            task_ids.append(task_id)
            task_phi = phi()
            await conn.execute(
                'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, phi_hash,'
                " budget_usdc_units, agents) VALUES (%s, %s, %s, 'do it', %s, %s, 500000, %s)",
                (
                    plan_uuid,
                    i,
                    f"task {i}",
                    Jsonb(task_phi),
                    mergit_receipt.phi_hash(json.dumps(task_phi)),
                    ["1"],
                ),
            )
            await conn.execute(
                'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
                " VALUES (%s, %s, %s, 1, '1')",
                (task_id, plan_uuid, i),
            )
            passed = i == 0
            await conn.execute(
                'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, phi_holds,'
                " receipt_root) VALUES (%s, %s, %s, 1, '1', %s, %s, %s)",
                (
                    task_id,
                    plan_uuid,
                    i,
                    "done" if passed else "running",
                    True if passed else None,
                    "0x" + "a" * 64 if passed else None,
                ),
            )
    return plan_uuid, plan_id, task_ids


async def seed_chain_event(pool: Pool, event_type: str, payload: dict[str, Any]) -> None:
    """What `chain_events.receive` does for a money event: the raw log row, then its ledger row."""
    envelope = {
        "event_id": str(uuid.uuid4()),
        "type": event_type,
        "at": "2026-10-29T00:00:00.000Z",
        "payload": payload,
    }
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO chain_events_seen (event_id, type, payload) VALUES (%s, %s, %s)",
            (envelope["event_id"], event_type, Jsonb(payload)),
        )
        assert await money.record(conn, envelope)


def _rand_hex_address() -> str:
    return "0x" + (uuid.uuid4().hex + uuid.uuid4().hex)[:40]


def _rand_agent_id() -> str:
    """A fresh numeric agent_id (`mergit_cp.agents` requires `^(0|[1-9][0-9]*)$`)."""
    return str(random.randint(10**12, 10**13 - 1))


@dataclass(frozen=True)
class TwoAgents:
    """A second, independent two-agent roster -- for candidates tests, which need more than one agent to
    show a ranking. Overrides conftest.py's single-agent `agents_files`/`settings`/`client`, so this gets
    its own fixtures rather than reusing those, which other tests in this file depend on staying one agent
    (`test_agents_lists_id_name_and_model`)."""

    agent_a: str
    agent_b: str
    operator_a: str
    operator_b: str


@pytest.fixture
def two_agents() -> TwoAgents:
    return TwoAgents(_rand_agent_id(), _rand_agent_id(), _rand_hex_address(), _rand_hex_address())


@pytest.fixture
def two_agent_settings(database_url: str, tmp_path: Path, two_agents: TwoAgents) -> Settings:
    chain = tmp_path / "agents-2.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": two_agents.agent_a,
                        "name": "agent-a",
                        "operator": two_agents.operator_a,
                        "runtime_key": _rand_hex_address(),
                    },
                    {
                        "agent_id": two_agents.agent_b,
                        "name": "agent-b",
                        "operator": two_agents.operator_b,
                        "runtime_key": _rand_hex_address(),
                    },
                ]
            }
        )
    )
    config = tmp_path / "agents-2.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.agent-a]\nprovider = "anthropic"\nmodel = "m-a"\nsystem_prompt = "s"\n'
        '[agents.agent-b]\nprovider = "anthropic"\nmodel = "m-b"\nsystem_prompt = "s"\n'
    )
    return make_settings(
        database_url=database_url, app_domain=APP_DOMAIN, agents_file=str(chain), agents_config=str(config)
    )


@pytest.fixture
def two_agent_client(two_agent_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(two_agent_settings), base_url="https://testserver") as c:
        yield c
    with psycopg.connect(two_agent_settings.database_url) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
        ).fetchall()
        if tables:
            conn.execute("TRUNCATE " + ", ".join(t[0] for t in tables))


async def seed_routable_plan(
    pool: Pool, *, requester: str, category: str = "cat", retry_tolerant: list[bool] | None = None
) -> str:
    """A plan with one task per entry of `retry_tolerant` (default: a single task, `retry_tolerant=True`),
    at indexes `0..len(retry_tolerant)-1`, and no dispatch at all, so every roster agent starts eligible on
    every task."""
    flags = retry_tolerant if retry_tolerant is not None else [True]
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
            " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
            " VALUES (%s, %s, %s, 'fix the refund', 'https://github.com/acme/widgets', 'main', %s,"
            " 1000000, 'approved', 'wallet', 1000000, 'claude-opus-5', now())",
            (plan_uuid, plan_id, requester, category),
        )
        for index, retry_tolerant_flag in enumerate(flags):
            task_phi = phi()
            await conn.execute(
                'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, phi_hash,'
                " budget_usdc_units, retry_tolerant) VALUES (%s, %s, %s, 'do it', %s, %s, 500000, %s)",
                (
                    plan_uuid,
                    index,
                    f"task {index}",
                    Jsonb(task_phi),
                    mergit_receipt.phi_hash(json.dumps(task_phi)),
                    retry_tolerant_flag,
                ),
            )
    return plan_uuid


async def seed_dispatch_only(pool: Pool, *, plan_uuid: str, index: int, agent_id: str) -> None:
    """One `task_dispatches` row with no matching `jobs` row -- just enough to make `agent_id` "already
    tried on this task" at `index`, for a plan seeded by `seed_routable_plan` (which dispatches nothing
    itself). `task_id` must be the `^0x[0-9a-f]{64}$` shape the table's own `CHECK` requires, so it is
    derived the same way the real dispatch path does, from the plan's own id."""
    task_id = mergit_receipt.task_id(mergit_receipt.plan_id(plan_uuid), index, 1)
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
            " VALUES (%s, %s, %s, 1, %s)",
            (task_id, plan_uuid, index, agent_id),
        )


async def seed_posterior(
    pool: Pool,
    *,
    agent_id: str,
    category: str,
    alpha: float,
    beta: float,
    kappa: float,
    tau: float,
    outcomes: int = 0,
    costs: int = 0,
) -> None:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO reputation_posteriors (agent_id, category, alpha, beta, kappa, tau, outcomes, costs)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (agent_id, category, alpha, beta, kappa, tau, outcomes, costs),
        )


def test_plans_list_only_shows_own_plans(client: TestClient, settings: Settings):
    address = sign_in(client)
    other = Account.create().address.lower()
    mine, _, _ = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))
    run(settings.database_url, lambda pool: seed_plan(pool, requester=other))

    body = client.get("/v0/plans").json()
    assert [p["plan_uuid"] for p in body] == [mine]


def test_plans_list_requires_a_session(client: TestClient):
    assert client.get("/v0/plans").status_code == 401


def test_plan_detail_includes_attempts_and_tx_hashes(client: TestClient, settings: Settings):
    address = sign_in(client)
    plan_uuid, _, task_ids = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))
    tx = "0x" + "b" * 64
    released = {"task_id": task_ids[0], "to": address, "amount_usdc_units": "500000", "tx": tx}
    run(settings.database_url, lambda pool: seed_chain_event(pool, "task.released", released))

    body = client.get(f"/v0/plans/{plan_uuid}").json()
    assert body["plan_uuid"] == plan_uuid
    assert len(body["attempts"]) == 2
    done = next(a for a in body["attempts"] if a["task_id"] == task_ids[0])
    assert (done["status"], done["phi_holds"]) == ("done", True)
    running = next(a for a in body["attempts"] if a["task_id"] == task_ids[1])
    assert (running["status"], running["phi_holds"]) == ("running", None)
    assert any(e["payload"].get("tx") == tx for e in body["money_events"])


def test_plan_detail_refuses_a_stranger(client: TestClient, settings: Settings):
    sign_in(client)  # a session, just not the plan's requester
    other = Account.create().address.lower()
    plan_uuid, _, _ = run(settings.database_url, lambda pool: seed_plan(pool, requester=other))
    assert client.get(f"/v0/plans/{plan_uuid}").status_code == 403


def test_plan_detail_404_for_an_unknown_plan(client: TestClient):
    sign_in(client)
    assert client.get(f"/v0/plans/{uuid.uuid4()}").status_code == 404


def test_credits_denied_carries_its_reason_in_plan_detail(client: TestClient, settings: Settings):
    """Issue #23: the plan stays `approved` (chain_events.py never moves it; see test_chain_events.py), so
    the one thing O7 needs to do is make the denial and its reason visible, which it already does through
    `money_events` (O6's stand-in)."""
    address = sign_in(client)
    plan_uuid, plan_id, _ = run(
        settings.database_url, lambda pool: seed_plan(pool, requester=address, state="approved", n_tasks=1)
    )
    run(
        settings.database_url,
        lambda pool: seed_chain_event(pool, "credits.denied", {"plan_id": plan_id, "reason": "rate_limited"}),
    )

    body = client.get(f"/v0/plans/{plan_uuid}").json()
    assert body["state"] == "approved"
    denial = next(e for e in body["money_events"] if e["type"] == "credits.denied")
    assert denial["payload"]["reason"] == "rate_limited"


def test_credits_denied_streams_as_a_money_event(client: TestClient, settings: Settings):
    address = sign_in(client)
    plan_uuid, plan_id, _ = run(
        settings.database_url, lambda pool: seed_plan(pool, requester=address, state="approved", n_tasks=1)
    )

    events: list[tuple[str, dict[str, Any]]] = []
    stop = threading.Event()

    def consume() -> None:
        with client.stream("GET", f"/v0/plans/{plan_uuid}/events") as response:
            event_name = None
            for line in response.iter_lines():
                if stop.is_set():
                    return
                if line.startswith("event: "):
                    event_name = line.removeprefix("event: ")
                elif line.startswith("data: ") and event_name is not None:
                    events.append((event_name, json.loads(line.removeprefix("data: "))))
                    event_name = None

    thread = threading.Thread(target=consume, daemon=True)
    thread.start()
    try:
        _wait_for(lambda: any(n == "plan.state" for n, _ in events))
        run(
            settings.database_url,
            lambda pool: seed_chain_event(
                pool, "credits.denied", {"plan_id": plan_id, "reason": "over_value_cap"}
            ),
        )
        _wait_for(lambda: any(n == "money" for n, _ in events))
    finally:
        stop.set()
        thread.join(timeout=5)

    money = next(d for n, d in events if n == "money")
    assert money["payload"]["reason"] == "over_value_cap"


def test_agents_lists_id_name_and_model(client: TestClient):
    body = client.get("/v0/agents").json()
    assert body == [
        {
            "agent_id": "1",
            "name": "coder-a",
            "model": "claude-sonnet-5",
            "provider": "anthropic",
            "reputation": [],
        }
    ]


def test_internal_progress_requires_worker_token(client: TestClient, settings: Settings):
    other = Account.create().address.lower()
    _, _, task_ids = run(settings.database_url, lambda pool: seed_plan(pool, requester=other))
    body = {"task_id": task_ids[1], "seq": 1, "type": "model_call", "cost": {"usd_micros": 10}}

    assert client.post("/v0/internal/progress", json=body).status_code == 401
    assert (
        client.post("/v0/internal/progress", json=body, headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    ok = client.post(
        "/v0/internal/progress", json=body, headers={"Authorization": "Bearer test-worker-token"}
    )
    assert ok.status_code == 202


def test_internal_progress_404s_an_unknown_task(client: TestClient):
    body = {"task_id": "0x" + "0" * 64, "seq": 1, "type": "model_call", "cost": {}}
    resp = client.post(
        "/v0/internal/progress", json=body, headers={"Authorization": "Bearer test-worker-token"}
    )
    assert resp.status_code == 404


def test_sse_streams_state_changes_in_order(client: TestClient, settings: Settings):
    address = sign_in(client)
    plan_uuid, _plan_id, task_ids = run(
        settings.database_url, lambda pool: seed_plan(pool, requester=address, state="running")
    )

    events: list[tuple[str, dict[str, Any]]] = []
    stop = threading.Event()

    def consume() -> None:
        with client.stream("GET", f"/v0/plans/{plan_uuid}/events") as response:
            event_name = None
            for line in response.iter_lines():
                if stop.is_set():
                    return
                if line.startswith("event: "):
                    event_name = line.removeprefix("event: ")
                elif line.startswith("data: ") and event_name is not None:
                    events.append((event_name, json.loads(line.removeprefix("data: "))))
                    event_name = None

    thread = threading.Thread(target=consume, daemon=True)
    thread.start()
    try:
        _wait_for(lambda: any(n == "plan.state" for n, _ in events))
        _wait_for(lambda: sum(n == "task.state" for n, _ in events) >= 2)

        client.post(
            "/v0/internal/progress",
            json={"task_id": task_ids[1], "seq": 1, "type": "model_call", "cost": {"usd_micros": 5}},
            headers={"Authorization": "Bearer test-worker-token"},
        )
        _wait_for(lambda: any(n == "step.recorded" for n, _ in events))

        run(
            settings.database_url,
            lambda pool: _mark_done(pool, task_ids[1]),
        )
        _wait_for(lambda: sum(n == "task.state" for n, _ in events) >= 3)

        run(
            settings.database_url,
            lambda pool: seed_chain_event(
                pool, "verdict.recorded", {"task_id": task_ids[1], "verdict": "pass", "tx": "0x" + "c" * 64}
            ),
        )
        _wait_for(lambda: any(n == "verdict" for n, _ in events))
    finally:
        stop.set()
        thread.join(timeout=5)

    names = [n for n, _ in events]
    # The two initial task snapshots and the plan snapshot come before anything live; step.recorded
    # arrives before the task.state it causes; verdict is last.
    assert names.index("plan.state") < names.index("step.recorded")
    assert names.index("step.recorded") < names.index("verdict")
    assert names[-1] == "verdict"


async def _mark_done(pool: Pool, task_id: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE jobs SET status = 'done', phi_holds = true, receipt_root = %s WHERE task_id = %s",
            ("0x" + "d" * 64, task_id),
        )


def _wait_for(predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition was never met")


def test_plan_detail_reads_the_ledger_not_the_raw_log(client: TestClient, settings: Settings):
    address = sign_in(client)
    plan_uuid, _, task_ids = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))

    async def raw_only(pool: Pool) -> None:
        async with pool.connection() as conn:
            await conn.execute(
                "INSERT INTO chain_events_seen (event_id, type, payload) VALUES (%s, 'verdict.recorded', %s)",
                (
                    str(uuid.uuid4()),
                    Jsonb({"task_id": task_ids[0], "verdict": "fail", "tx": "0x" + "9" * 64}),
                ),
            )

    run(settings.database_url, raw_only)
    assert client.get(f"/v0/plans/{plan_uuid}").json()["money_events"] == []

    paid = {"task_id": task_ids[0], "to": address, "amount_usdc_units": "500000", "tx": "0x" + "8" * 64}
    run(settings.database_url, lambda pool: seed_chain_event(pool, "task.released", paid))
    (event,) = client.get(f"/v0/plans/{plan_uuid}").json()["money_events"]
    assert event["type"] == "task.released"
    assert event["payload"] == paid  # the gateway's own fields, rebuilt from the typed columns
    assert (event["task_id"], event["index"], event["attempt"], event["tx"]) == (
        task_ids[0],
        0,
        1,
        paid["tx"],
    )
    assert isinstance(event["id"], int)


def test_money_events_are_scoped_to_their_own_plan(client: TestClient, settings: Settings):
    address = sign_in(client)
    first, _, _ = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))
    second, _, second_tasks = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))
    verdict = {"task_id": second_tasks[0], "verdict": "pass", "tx": "0x" + "7" * 64}
    run(settings.database_url, lambda pool: seed_chain_event(pool, "verdict.recorded", verdict))

    assert client.get(f"/v0/plans/{first}").json()["money_events"] == []
    assert len(client.get(f"/v0/plans/{second}").json()["money_events"]) == 1


def test_a_ledger_row_that_commits_late_is_still_streamed_once(client: TestClient, settings: Settings):
    """A row can carry an older timestamp and a lower id than one already sent, if its transaction began
    first and committed second. A time cursor would drop it; tracking ids does not."""
    address = sign_in(client)
    plan_uuid, _, task_ids = run(settings.database_url, lambda pool: seed_plan(pool, requester=address))
    events: list[tuple[str, dict[str, Any]]] = []
    stop = threading.Event()

    def consume() -> None:
        with client.stream("GET", f"/v0/plans/{plan_uuid}/events") as response:
            name = None
            for line in response.iter_lines():
                if stop.is_set():
                    return
                if line.startswith("event: "):
                    name = line.removeprefix("event: ")
                elif line.startswith("data: ") and name is not None:
                    events.append((name, json.loads(line.removeprefix("data: "))))
                    name = None

    async def late_row(pool: Pool) -> None:
        event_id = str(uuid.uuid4())
        async with pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO chain_events_seen (event_id, type, payload) VALUES (%s, 'task.returned', '{}')",
                (event_id,),
            )
            await conn.execute(
                "INSERT INTO money_events (id, event_id, kind, plan_uuid, task_id, tx, amount_usdc_units,"
                " reason, received_at) VALUES (-7, %s, 'task.returned', %s, %s, %s, 3, 'deadline',"
                " now() - interval '1 hour')",
                (event_id, plan_uuid, task_ids[1], "0x" + "6" * 64),
            )

    def ledger_events() -> list[dict[str, Any]]:
        return [d for n, d in events if n in ("money", "verdict")]

    thread = threading.Thread(target=consume, daemon=True)
    thread.start()
    try:
        _wait_for(lambda: any(n == "plan.state" for n, _ in events))
        verdict = {"task_id": task_ids[0], "verdict": "pass", "tx": "0x" + "5" * 64}
        run(settings.database_url, lambda pool: seed_chain_event(pool, "verdict.recorded", verdict))
        _wait_for(lambda: len(ledger_events()) == 1)
        run(settings.database_url, late_row)
        _wait_for(lambda: len(ledger_events()) == 2)
        time.sleep(0.5)  # several more polls: nothing may be sent twice
    finally:
        stop.set()
        thread.join(timeout=5)

    sent = ledger_events()
    assert [e["id"] for e in sent][1] == -7
    assert len({e["id"] for e in sent}) == len(sent) == 2


def test_candidates_ranked_by_density_and_requester_only(
    two_agent_client: TestClient, two_agent_settings: Settings, two_agents: TwoAgents
):
    address = sign_in(two_agent_client)
    plan_uuid = run(
        two_agent_settings.database_url,
        lambda pool: seed_routable_plan(pool, requester=address, category="cat-x"),
    )
    # agent_a: theta_mean 0.9, cost_mean 100_000 -> density 9e-6 (the higher density, should rank first).
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool,
            agent_id=two_agents.agent_a,
            category="cat-x",
            alpha=90,
            beta=10,
            kappa=10,
            tau=1_000_000,
            outcomes=9,
            costs=9,
        ),
    )
    # agent_b: theta_mean 0.1, same cost_mean -> density 1e-6 (lower; should rank second).
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool,
            agent_id=two_agents.agent_b,
            category="cat-x",
            alpha=10,
            beta=90,
            kappa=10,
            tau=1_000_000,
            outcomes=4,
            costs=4,
        ),
    )

    body = two_agent_client.get(f"/v0/plans/{plan_uuid}/candidates").json()
    assert len(body["tasks"]) == 1
    task0 = body["tasks"][0]
    assert task0["index"] == 0
    candidates = task0["candidates"]
    assert [c["agent_id"] for c in candidates] == [two_agents.agent_a, two_agents.agent_b]
    assert all(c["eligible"] and c["reason"] is None for c in candidates)
    assert (candidates[0]["outcomes"], candidates[0]["costs"]) == (9, 9)
    assert (candidates[1]["outcomes"], candidates[1]["costs"]) == (4, 4)
    assert candidates[0]["density"] > candidates[1]["density"]
    assert {c["agent_id"]: c["provider"] for c in candidates} == {
        two_agents.agent_a: "anthropic",
        two_agents.agent_b: "anthropic",
    }

    # requester-only: once a different account signs in on this client, the same plan is no longer theirs.
    sign_in(two_agent_client)
    assert two_agent_client.get(f"/v0/plans/{plan_uuid}/candidates").status_code == 403


def test_candidates_show_ineligible_reason(client: TestClient, settings: Settings):
    address = sign_in(client)
    # seed_plan already dispatches agent "1" (the fixture's only agent) on every index, so it is
    # "already tried on this task" and therefore the only candidate, and ineligible.
    plan_uuid, _, _ = run(
        settings.database_url, lambda pool: seed_plan(pool, requester=address, n_tasks=1)
    )

    body = client.get(f"/v0/plans/{plan_uuid}/candidates").json()
    assert len(body["tasks"]) == 1
    (candidate,) = body["tasks"][0]["candidates"]
    assert candidate["agent_id"] == "1"
    assert candidate["eligible"] is False
    assert candidate["reason"] == "already tried on this task"
    assert (candidate["outcomes"], candidate["costs"]) == (0, 0)


def test_candidates_sort_by_theta_mean_when_retry_intolerant(
    two_agent_client: TestClient, two_agent_settings: Settings, two_agents: TwoAgents
):
    """`retry_tolerant=False` must rank by `theta_mean`, not `density` -- and these two agents are built so
    the two metrics actually disagree on the winner, so a sort that silently used `density` here would
    produce the wrong order, not just a coincidentally-identical one."""
    address = sign_in(two_agent_client)
    plan_uuid = run(
        two_agent_settings.database_url,
        lambda pool: seed_routable_plan(pool, requester=address, category="cat-y", retry_tolerant=[False]),
    )
    # agent_a: theta_mean 0.95 but expensive (cost_mean 1_000_000) -> density ~9.5e-7 (the LOWER density).
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool, agent_id=two_agents.agent_a, category="cat-y", alpha=95, beta=5, kappa=10, tau=10_000_000
        ),
    )
    # agent_b: theta_mean 0.5 but cheap (cost_mean 10_000) -> density 5e-5 (the HIGHER density).
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool, agent_id=two_agents.agent_b, category="cat-y", alpha=50, beta=50, kappa=10, tau=100_000
        ),
    )

    body = two_agent_client.get(f"/v0/plans/{plan_uuid}/candidates").json()
    task0 = body["tasks"][0]
    assert task0["retry_tolerant"] is False
    candidates = task0["candidates"]
    by_density = sorted(candidates, key=lambda c: -c["density"])
    by_theta_mean = sorted(candidates, key=lambda c: -c["theta_mean"])
    # Sanity check that this test actually discriminates: the two rankings must disagree, or sorting by
    # the wrong metric would still happen to produce the right-looking order.
    assert [c["agent_id"] for c in by_density] != [c["agent_id"] for c in by_theta_mean]
    assert [c["agent_id"] for c in candidates] == [c["agent_id"] for c in by_theta_mean]
    assert [c["agent_id"] for c in candidates] == [two_agents.agent_a, two_agents.agent_b]


def test_candidates_ineligible_always_sorts_after_eligible_regardless_of_metric(
    two_agent_client: TestClient, two_agent_settings: Settings, two_agents: TwoAgents
):
    """agent_b outranks agent_a on BOTH `density` and `theta_mean`, but is already dispatched (ineligible)
    on every task -- if the sort didn't put eligibility ahead of the metric, agent_b would lead both the
    `retry_tolerant=True` (density) and `retry_tolerant=False` (theta_mean) task's candidate list."""
    address = sign_in(two_agent_client)
    plan_uuid = run(
        two_agent_settings.database_url,
        lambda pool: seed_routable_plan(
            pool, requester=address, category="cat-z", retry_tolerant=[True, False]
        ),
    )
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool, agent_id=two_agents.agent_a, category="cat-z", alpha=10, beta=90, kappa=10, tau=100_000
        ),
    )
    run(
        two_agent_settings.database_url,
        lambda pool: seed_posterior(
            pool, agent_id=two_agents.agent_b, category="cat-z", alpha=90, beta=10, kappa=10, tau=100_000
        ),
    )
    for index in (0, 1):
        run(
            two_agent_settings.database_url,
            lambda pool, index=index: seed_dispatch_only(
                pool, plan_uuid=plan_uuid, index=index, agent_id=two_agents.agent_b
            ),
        )

    body = two_agent_client.get(f"/v0/plans/{plan_uuid}/candidates").json()
    assert len(body["tasks"]) == 2
    for task in body["tasks"]:
        candidates = task["candidates"]
        assert [c["agent_id"] for c in candidates] == [two_agents.agent_a, two_agents.agent_b]
        assert candidates[0]["eligible"] is True
        assert candidates[1]["eligible"] is False
        assert candidates[1]["reason"] == "already tried on this task"


def test_attempt_shows_exploratory_flag(client: TestClient, settings: Settings):
    address = sign_in(client)
    plan_uuid, _, task_ids = run(
        settings.database_url, lambda pool: seed_plan(pool, requester=address, n_tasks=2)
    )

    async def seed_draw(pool: Pool) -> None:
        async with pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO routing_draws (task_id, seed, explore, retry_tolerant, budget_micros, samples,"
                " ineligible, chosen_agent, greedy_agent, exploratory)"
                " VALUES (%s, '42', true, true, 500000, %s, %s, '1', '1', true)",
                (task_ids[0], Jsonb({"arms": [], "original_chosen": None}), Jsonb({})),
            )

    run(settings.database_url, seed_draw)

    body = client.get(f"/v0/plans/{plan_uuid}").json()
    drawn = next(a for a in body["attempts"] if a["task_id"] == task_ids[0])
    assert drawn["routing"] == {"exploratory": True, "seed": "42", "greedy_agent": "1"}
    undrawn = next(a for a in body["attempts"] if a["task_id"] == task_ids[1])
    assert undrawn["routing"] is None


def test_agents_list_has_no_reputation_from_credits_plans(client: TestClient, settings: Settings):
    """Invariant 6: a credits-funded plan yields no reputation observation at all (`reputation.py`'s
    `_OUTCOME_CANDIDATES`/`_COST_CANDIDATES` both filter `p.funding = 'wallet'`), so `GET /v0/agents` must
    show an empty `reputation` list for an agent that has only ever run credits-funded plans, even after a
    passed, sealed job and a reputation ingestion pass."""
    address = sign_in(client)
    agent_operator = "0x1111111111111111111111111111111111111111"  # conftest.py's agents_files fixture

    async def seed(pool: Pool) -> None:
        plan_uuid = str(uuid.uuid4())
        plan_id = mergit_receipt.plan_id(plan_uuid)
        task_id = mergit_receipt.task_id(plan_id, 0, 1)
        task_phi = phi()
        async with pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
                " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
                " VALUES (%s, %s, %s, 'fix the refund', 'https://github.com/acme/widgets', 'main',"
                " 'test-repair', 500000, 'running', 'credits', 500000, 'claude-opus-5', now())",
                (plan_uuid, plan_id, address),
            )
            await conn.execute(
                'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, phi_hash,'
                " budget_usdc_units, agents) VALUES (%s, 0, 'task 0', 'do it', %s, %s, 500000, %s)",
                (plan_uuid, Jsonb(task_phi), mergit_receipt.phi_hash(json.dumps(task_phi)), ["1"]),
            )
            await conn.execute(
                'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
                " VALUES (%s, %s, 0, 1, '1')",
                (task_id, plan_uuid),
            )
            await conn.execute(
                'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id, status, phi_holds,'
                " receipt_root, cost_micros, finished_at)"
                " VALUES (%s, %s, 0, 1, '1', 'done', true, %s, 50000, now())",
                (task_id, plan_uuid, "0x" + "a" * 64),
            )
        await seed_chain_event(
            pool, "verdict.recorded", {"task_id": task_id, "verdict": "pass", "tx": "0x" + "f" * 64}
        )
        async with pool.connection() as conn, conn.transaction():
            inserted = await ingest_due(conn, settings, {"1": agent_operator}, 50)
            assert inserted == 0  # the credits filter excludes both the outcome and the cost candidate

    run(settings.database_url, seed)

    body = client.get("/v0/agents").json()
    (agent,) = [a for a in body if a["agent_id"] == "1"]
    assert agent["provider"] == "anthropic"
    assert agent["reputation"] == []
