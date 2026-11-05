"""`ArkivMirror`: the write/read shape against a fake `RawArkivClient`, no real RPC or funded account.

No `pytest-asyncio` in this repo (see other test files): each test drives its coroutine with
``asyncio.run``, same as the rest of the suite drives Postgres helpers.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import pytest

from mergit_cp.arkiv_mirror import KIND, ArkivMirror, MirroredDecision


@dataclass
class FakeEntity:
    key: str
    attributes: dict[str, str | int]
    payload: bytes | None


class FakeRawClient:
    """Fakes the slice of ``arkiv.arkiv`` (``ArkivModule``) that `ArkivMirror` calls. Plain ``__init__``
    attributes, not a dataclass with ``field(default_factory=list)``: pyright strict cannot narrow that
    factory's return past ``list[Unknown]`` even with an explicit field annotation."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.entities: list[FakeEntity] = []
        self.queries: list[str] = []
        self.next_key = 0

    def create_entity(
        self,
        payload: bytes | None = None,
        content_type: str | None = None,
        attributes: dict[str, str | int] | None = None,
        expires_in: int | None = None,
    ) -> tuple[str, object]:
        self.next_key += 1
        key = f"0xentity{self.next_key}"
        self.created.append(
            {
                "key": key,
                "payload": payload,
                "content_type": content_type,
                "attributes": attributes,
                "expires_in": expires_in,
            }
        )
        return key, object()

    def query_entities(self, query: str) -> list[FakeEntity]:
        self.queries.append(query)
        return self.entities


@pytest.fixture
def mirror() -> tuple[ArkivMirror, FakeRawClient]:
    client = FakeRawClient()
    return ArkivMirror("https://rpc.example", "0xkey", "access", 30, client=client), client


def test_write_decision_tags_and_shapes_the_entity(mirror: tuple[ArkivMirror, FakeRawClient]):
    arkiv, client = mirror
    key = asyncio.run(
        arkiv.write_decision(
            plan_id="0x" + "ab" * 32,
            task_index=1,
            category="code",
            requester="0x" + "11" * 20,
            decided_at="2026-11-06T00:00:00+00:00",
            candidates=[{"agent_id": "a1", "alpha": 1.0}],
            picks=[{"agent_id": "a1", "score": 0.9}],
        )
    )
    assert key == "0xentity1"
    [call] = client.created
    assert call["content_type"] == "application/json"
    assert call["expires_in"] == 30 * 86400
    assert call["attributes"] == {
        "kind": KIND,
        "planId": "0x" + "ab" * 32,
        "taskIndex": 1,
        "category": "code",
        "requester": "0x" + "11" * 20,
        "decidedAt": "2026-11-06T00:00:00+00:00",
    }
    body = json.loads(call["payload"])
    assert body == {
        "candidates": [{"agent_id": "a1", "alpha": 1.0}],
        "picks": [{"agent_id": "a1", "score": 0.9}],
    }


def test_read_decisions_filters_by_plan_and_decodes_the_payload(
    mirror: tuple[ArkivMirror, FakeRawClient],
):
    arkiv, client = mirror
    client.entities = [
        FakeEntity(
            key="0xe1",
            attributes={
                "kind": KIND,
                "planId": "plan-1",
                "taskIndex": 0,
                "category": "code",
                "requester": "0xreq",
                "decidedAt": "2026-11-06T00:00:00+00:00",
            },
            payload=json.dumps(
                {"candidates": [{"agent_id": "a1"}], "picks": [{"agent_id": "a1"}]}
            ).encode(),
        )
    ]

    decisions = asyncio.run(arkiv.read_decisions("plan-1"))

    assert client.queries == [f'kind = "{KIND}" AND planId = "plan-1"']
    assert decisions == [
        MirroredDecision(
            entity_key="0xe1",
            plan_id="plan-1",
            task_index=0,
            category="code",
            requester="0xreq",
            decided_at="2026-11-06T00:00:00+00:00",
            candidates=[{"agent_id": "a1"}],
            picks=[{"agent_id": "a1"}],
        )
    ]


def test_read_decisions_caps_at_the_limit(mirror: tuple[ArkivMirror, FakeRawClient]):
    arkiv, client = mirror
    client.entities = [
        FakeEntity(key=f"0xe{i}", attributes={"planId": "plan-1"}, payload=None) for i in range(5)
    ]

    decisions = asyncio.run(arkiv.read_decisions("plan-1", limit=2))

    assert len(decisions) == 2


def test_read_decisions_skips_an_entity_it_cannot_decode(mirror: tuple[ArkivMirror, FakeRawClient]):
    """Arkiv is a public, permissionless database: anyone can write an entity tagged
    ``kind = "mergit.routing_decision"`` with any payload, so a genuinely malformed match (unparseable
    JSON, a non-numeric ``taskIndex``) is skipped, not raised."""
    arkiv, client = mirror
    client.entities = [
        FakeEntity(key="0xbad-payload", attributes={"planId": "plan-1"}, payload=b"not json"),
        FakeEntity(
            key="0xbad-index",
            attributes={"planId": "plan-1", "taskIndex": "not a number"},
            payload=None,
        ),
        FakeEntity(key="0xgood", attributes={"planId": "plan-1", "taskIndex": 0}, payload=None),
    ]

    decisions = asyncio.run(arkiv.read_decisions("plan-1"))

    assert [d.entity_key for d in decisions] == ["0xgood"]


def test_read_decisions_tolerates_a_payload_that_is_valid_json_but_not_an_object(
    mirror: tuple[ArkivMirror, FakeRawClient],
):
    """A payload like a bare JSON array parses fine but has no ``candidates``/``picks`` to read; the
    entity still decodes, just with both empty, instead of `.get()` crashing on a non-dict."""
    arkiv, client = mirror
    client.entities = [FakeEntity(key="0xe1", attributes={"planId": "plan-1"}, payload=b"[1, 2, 3]")]

    decisions = asyncio.run(arkiv.read_decisions("plan-1"))

    assert len(decisions) == 1
    assert decisions[0].candidates == []
    assert decisions[0].picks == []
