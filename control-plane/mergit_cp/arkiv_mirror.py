"""Mirrors routing decisions (``routing_decisions``, migration 0016) onto Arkiv, the public Web3 database,
for ETHGlobal Mumbai's "Build on Arkiv (existing projects)" track.

Postgres stays the source of truth: nothing here is read back to decide anything the product depends on.
This is a best-effort copy, written after the Postgres transaction that recorded the decision has already
committed, so a down testnet or a slow RPC never affects a real request (``routes_routing.suggestions``
swallows and logs any `ArkivMirror` failure). The mirrored entity tags itself
``kind = "mergit.routing_decision"`` so anyone can query it without knowing anything else about Mergit;
the requester's address is a queryable attribute, not the Arkiv-level owner, since one service wallet
signs every write (see `Settings.arkiv_*`).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Protocol, cast

log = logging.getLogger(__name__)

KIND = "mergit.routing_decision"
"""The project's tag on every entity this module writes (`arkiv.schema.md`'s ``kind`` attribute)."""


class RawArkivClient(Protocol):
    """The slice of ``arkiv.Arkiv`` this module calls, as its own protocol so a test can fake it without
    a real `arkiv.Arkiv` (which needs a funded account and a reachable RPC)."""

    def create_entity(
        self,
        payload: bytes | None = None,
        content_type: str | None = None,
        attributes: dict[str, str | int] | None = None,
        expires_in: int | None = None,
    ) -> tuple[Any, Any]: ...

    def query_entities(self, query: str) -> Any: ...


@dataclass(frozen=True)
class MirroredDecision:
    """One routing decision as read back from Arkiv (`GET /v0/plans/{uuid}/arkiv-suggestions`)."""

    entity_key: str
    plan_id: str
    task_index: int
    category: str
    requester: str
    decided_at: str
    candidates: list[dict[str, Any]]
    picks: list[dict[str, Any]]


class ArkivMirror:
    """Lazily builds the real `arkiv.Arkiv` client on first use (constructing it makes no network call,
    but importing ``arkiv`` eagerly would make the dependency mandatory for everyone who never sets
    `ARKIV_*`)."""

    def __init__(
        self,
        rpc_url: str,
        private_key: str,
        access_key: str | None,
        ttl_days: int,
        *,
        client: RawArkivClient | None = None,
    ) -> None:
        self._rpc_url = rpc_url
        self._private_key = private_key
        self._access_key = access_key
        self.ttl_seconds = ttl_days * 86400
        self._client = client
        """Pre-built only in tests, which fake `RawArkivClient` to avoid a real funded account and RPC."""

    def _build(self) -> RawArkivClient:
        from arkiv import Arkiv  # local import: optional dependency, only needed when Arkiv is configured
        from arkiv.account import NamedAccount
        from arkiv.provider import ProviderBuilder
        from web3.providers.base import BaseProvider

        url = f"{self._rpc_url}/{self._access_key}" if self._access_key else self._rpc_url
        # .custom() with no .ws()/.async_mode() always builds a sync HTTPProvider; the builder's return
        # type is wider (it also covers ws/async providers) than what we ever actually get here.
        provider = cast(BaseProvider, ProviderBuilder().custom(url).build())
        account = NamedAccount.from_private_key("mergit-service", self._private_key)
        # `client.arkiv` (an `ArkivModule`), not the `Arkiv`/`Web3` client itself, is what carries
        # `create_entity`/`query_entities`.
        return cast(RawArkivClient, Arkiv(provider, account=account).arkiv)

    @property
    def client(self) -> RawArkivClient:
        if self._client is None:
            self._client = self._build()
        return self._client

    async def write_decision(
        self,
        *,
        plan_id: str,
        task_index: int,
        category: str,
        requester: str,
        decided_at: str,
        candidates: list[dict[str, Any]],
        picks: list[dict[str, Any]],
    ) -> str:
        """Mirrors one `routing_decisions` row. Returns the new entity's key. Raises on failure; callers
        that must not fail the request for this (`routes_routing.suggestions`) catch and log it."""
        payload = json.dumps({"candidates": candidates, "picks": picks}).encode()
        attributes: dict[str, str | int] = {
            "kind": KIND,
            "planId": plan_id,
            "taskIndex": task_index,
            "category": category,
            "requester": requester,
            "decidedAt": decided_at,
        }

        def create() -> str:
            entity_key, _receipt = self.client.create_entity(
                payload=payload,
                content_type="application/json",
                attributes=attributes,
                expires_in=self.ttl_seconds,
            )
            return str(entity_key)

        return await asyncio.to_thread(create)

    async def read_decisions(self, plan_id: str, *, limit: int = 50) -> list[MirroredDecision]:
        """Every live mirrored decision for one plan, most recent Arkiv write order undefined (callers
        that care sort by `decided_at` themselves). Arkiv is a public, permissionless database: anyone
        can write an entity tagged ``kind = "mergit.routing_decision"`` with any payload they like, so a
        malformed match is skipped and logged rather than raised (`_decode`)."""
        query = f'kind = "{KIND}" AND planId = "{plan_id}"'

        def fetch() -> list[MirroredDecision]:
            out: list[MirroredDecision] = []
            for entity in self.client.query_entities(query):
                decoded = _decode(entity)
                if decoded is not None:
                    out.append(decoded)
                if len(out) >= limit:
                    break
            return out

        return await asyncio.to_thread(fetch)


def _decode(entity: Any) -> MirroredDecision | None:
    try:
        attrs: dict[str, Any] = entity.attributes or {}
        parsed: Any = json.loads(entity.payload) if entity.payload else {}
        # Valid JSON but not an object (e.g. a bare array) has no "candidates"/"picks" to read.
        body: dict[str, Any] = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
        return MirroredDecision(
            entity_key=str(entity.key),
            plan_id=str(attrs.get("planId", "")),
            task_index=int(attrs.get("taskIndex", -1)),
            category=str(attrs.get("category", "")),
            requester=str(attrs.get("requester", "")),
            decided_at=str(attrs.get("decidedAt", "")),
            candidates=body.get("candidates", []),
            picks=body.get("picks", []),
        )
    except (TypeError, ValueError, AttributeError, json.JSONDecodeError):
        log.warning("skipping an unreadable entity tagged %r: %r", KIND, getattr(entity, "key", None))
        return None
