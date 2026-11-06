"""`ArkivMirror`: writes (one HTTP call to the sidecar) and reads (plain `arkiv_query` over httpx), both
against a mocked transport (`respx`), never a real Rabdi RPC or a real sidecar process.

No `pytest-asyncio` in this repo (see other test files): each test drives its coroutine with
``asyncio.run``, same as the rest of the suite drives Postgres helpers.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import respx

from mergit_cp.arkiv_mirror import SCHEMA, ArkivMirror, Decision, _as_int

RPC = "https://rpc.example"
SIDECAR = "https://sidecar.example"
OWNER = "0x1111111111111111111111111111111111111111"


@pytest.fixture
def mirror() -> ArkivMirror:
    return ArkivMirror(RPC, None, OWNER, SIDECAR, "sidecar-secret", 30)


def _decision(task_index: int, **over: object) -> Decision:
    base = {
        "decision_id": 100 + task_index,
        "task_index": task_index,
        "category": "code",
        "seed": 123456789,
        "budget_micros": 500_000,
        "decided_at": "2026-11-06T00:00:00+00:00",
        "candidates": [{"agent_id": "a1"}],
        "picks": [{"agent_id": "a1"}],
    }
    return Decision(**(base | over))  # type: ignore[arg-type]


def _entity(
    key: str,
    *,
    decision_id: int = 100,
    task_index: int,
    category: str = "code",
    seed: int = 123456789,
    budget_micros: int = 500_000,
    decided_at: str,
    body: dict[str, object],
) -> dict[str, object]:
    encoded = "0x" + json.dumps(body).encode().hex()
    return {
        "key": key,
        "attributes": [
            {"name": "decisionId", "type": "u64", "value": hex(decision_id)},
            {"name": "taskIndex", "type": "i32", "value": task_index},
            {"name": "category", "type": "str", "value": category},
            {"name": "seed", "type": "u64", "value": hex(seed)},
            {"name": "budgetMicros", "type": "u64", "value": hex(budget_micros)},
            {"name": "decidedAt", "type": "str", "value": decided_at},
            {"name": "body", "type": "bytes", "value": encoded},
        ],
    }


def test_write_decisions_sends_one_batched_call(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post(f"{SIDECAR}/internal/mirror").respond(
            json={"tx_hash": "0xdead", "entity_keys": ["0xe1", "0xe2"]}
        )
        asyncio.run(mirror.write_decisions("plan-1", [_decision(0), _decision(1)]))
    assert route.call_count == 1
    sent = json.loads(route.calls[0].request.content)
    assert sent["ttl_days"] == 30
    assert [d["task_index"] for d in sent["decisions"]] == [0, 1]
    assert [d["decision_id"] for d in sent["decisions"]] == [100, 101]
    assert all(d["plan_id"] == "plan-1" for d in sent["decisions"])
    assert all(d["seed"] == 123456789 for d in sent["decisions"])
    assert all(d["budget_micros"] == 500_000 for d in sent["decisions"])
    assert all("requester" not in d for d in sent["decisions"])
    assert route.calls[0].request.headers["authorization"] == "Bearer sidecar-secret"


def test_write_decisions_raises_when_no_sidecar_is_configured():
    arkiv = ArkivMirror(RPC, None, OWNER, None, None, 30)
    with pytest.raises(RuntimeError):
        asyncio.run(arkiv.write_decisions("plan-1", [_decision(0)]))


def test_write_decisions_raises_on_a_sidecar_error(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        mock.post(f"{SIDECAR}/internal/mirror").respond(502, json={"error": "insufficient funds"})
        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(mirror.write_decisions("plan-1", [_decision(0)]))


def test_describe_query_matches_what_read_decisions_sends(mirror: ArkivMirror):
    query = mirror.describe_query("plan-1")
    assert query == (
        f"arkiv.schema = str('{SCHEMA}') AND planId = str('plan-1')"
        f" AND $owner = addr({OWNER}) ORDER BY $key ASC"
    )
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post(RPC).respond(json={"jsonrpc": "2.0", "id": 1, "result": {"data": []}})
        asyncio.run(mirror.read_decisions("plan-1"))
    sent = json.loads(route.calls[0].request.content)
    assert sent["method"] == "arkiv_query"
    assert sent["params"][0] == query


def test_read_decisions_decodes_the_bytes_body_attribute(mirror: ArkivMirror):
    entity = _entity(
        "0xe1",
        decision_id=42,
        task_index=0,
        seed=999,
        budget_micros=500_000,
        decided_at="2026-11-06T00:00:00+00:00",
        body={"candidates": [{"agent_id": "a1"}], "picks": [{"agent_id": "a1"}]},
    )
    with respx.mock(assert_all_called=True) as mock:
        mock.post(RPC).respond(json={"jsonrpc": "2.0", "id": 1, "result": {"data": [entity]}})
        decisions = asyncio.run(mirror.read_decisions("plan-1"))
    assert len(decisions) == 1
    d = decisions[0]
    assert d.entity_key == "0xe1"
    assert d.decision_id == 42
    assert d.task_index == 0
    assert d.category == "code"
    assert d.seed == 999
    assert d.budget_micros == 500_000
    assert d.decided_at == "2026-11-06T00:00:00+00:00"
    assert d.candidates == [{"agent_id": "a1"}]
    assert d.picks == [{"agent_id": "a1"}]


def test_read_decisions_raises_on_an_rpc_error(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        mock.post(RPC).respond(json={"jsonrpc": "2.0", "id": 1, "error": {"code": -32001, "message": "bad"}})
        with pytest.raises(RuntimeError):
            asyncio.run(mirror.read_decisions("plan-1"))


def test_read_decisions_raises_on_an_unreachable_rpc(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        mock.post(RPC).mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(httpx.ConnectError):
            asyncio.run(mirror.read_decisions("plan-1"))


def test_read_decisions_skips_an_entity_it_cannot_decode(mirror: ArkivMirror):
    """Arkiv is a public, permissionless database: anyone can write an entity matching our schema tag,
    plan id and owner filter, so a genuinely malformed match (unparseable body, a non-numeric
    ``taskIndex``) is skipped, not raised."""
    bad_body = {
        "key": "0xbad1",
        "attributes": [
            {"name": "taskIndex", "type": "i32", "value": 0},
            {"name": "body", "type": "bytes", "value": "0xnotvalidhex"},
        ],
    }
    bad_index = {
        "key": "0xbad2",
        "attributes": [{"name": "taskIndex", "type": "str", "value": "not a number"}],
    }
    good = _entity("0xgood", task_index=1, decided_at="t", body={})
    with respx.mock(assert_all_called=True) as mock:
        mock.post(RPC).respond(
            json={"jsonrpc": "2.0", "id": 1, "result": {"data": [bad_body, bad_index, good]}}
        )
        decisions = asyncio.run(mirror.read_decisions("plan-1"))
    assert [d.entity_key for d in decisions] == ["0xgood"]


def test_read_decisions_tolerates_a_body_that_is_valid_json_but_not_an_object(mirror: ArkivMirror):
    """A `body` like a bare JSON array parses fine but has no `candidates`/`picks` to read; the entity
    still decodes, just with both empty."""
    entity = {
        "key": "0xe1",
        "attributes": [
            {"name": "taskIndex", "type": "i32", "value": 0},
            {"name": "body", "type": "bytes", "value": "0x" + json.dumps([1, 2, 3]).encode().hex()},
        ],
    }
    with respx.mock(assert_all_called=True) as mock:
        mock.post(RPC).respond(json={"jsonrpc": "2.0", "id": 1, "result": {"data": [entity]}})
        decisions = asyncio.run(mirror.read_decisions("plan-1"))
    assert len(decisions) == 1
    assert decisions[0].candidates == []
    assert decisions[0].picks == []


def test_as_int_reads_both_plain_numbers_and_hex_quantities():
    """`i32` attributes come back as a plain JSON number; `u64` ones come back as a hex quantity —
    confirmed live against Rabdi's own `select` output (`arkiv/friction.md`)."""
    assert _as_int(5) == 5
    assert _as_int("0x2a") == 42


def test_writer_status_is_ok_when_the_sidecar_answers(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        mock.get(f"{SIDECAR}/healthz").respond(200, text="ok")
        assert asyncio.run(mirror.writer_status()) == "ok"


def test_writer_status_says_when_no_sidecar_is_configured():
    arkiv = ArkivMirror(RPC, None, OWNER, None, None, 30)
    assert asyncio.run(arkiv.writer_status()) == "not configured"


def test_writer_status_says_when_the_sidecar_is_not_running(mirror: ArkivMirror):
    """The live failure this exists for: the sidecar never started, so every background write failed
    and only logged, and the read side could only say "nothing mirrored yet"."""
    with respx.mock(assert_all_called=True) as mock:
        mock.get(f"{SIDECAR}/healthz").mock(side_effect=httpx.ConnectError("refused"))
        assert asyncio.run(mirror.writer_status()) == "unreachable (ConnectError)"


def test_writer_status_says_when_the_sidecar_is_unhealthy(mirror: ArkivMirror):
    with respx.mock(assert_all_called=True) as mock:
        mock.get(f"{SIDECAR}/healthz").respond(503)
        assert asyncio.run(mirror.writer_status()) == "unhealthy (HTTP 503)"
