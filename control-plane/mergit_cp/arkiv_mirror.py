"""Mirrors routing decisions (``routing_decisions``, migration 0016) onto Arkiv's Rabdi testnet, for
ETHGlobal Mumbai's "Build on Arkiv (existing projects)" track.

Postgres stays the source of truth: nothing here is read back to decide anything the product depends on.
This is a best-effort copy, scheduled after the request that recorded the decision has already responded
(`routes_routing.suggestions` uses `BackgroundTasks`), so a down testnet or a slow write never holds up a
real request.

Two separate paths, deliberately:

* **Reads** (`read_decisions`) are a plain JSON-RPC ``arkiv_query`` call over httpx, no SDK. Verified live
  against Rabdi: it returns ``key``/``owner``/``attributes`` but never a top-level payload field — Rabdi
  has no such field at the protocol level (``arkiv/friction.md``), so every value this module writes is a
  named *attribute*, including the JSON blob (``body``, a ``bytes``-typed attribute), not the "payload"
  concept the old (wrong-network) Python SDK exposes.
* **Writes** (`write_decisions`) go to a small Node sidecar (`chain/arkiv/`) that holds the one service
  wallet's key and uses the official JS SDK, the only one confirmed to encode a write Rabdi accepts. One
  HTTP call carries every task's decision for one plan, so the sidecar sends ONE batched transaction
  (``executeBatch``), not one per task — fewer round trips, and no nonce race between a plan's own tasks.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, cast

import httpx

log = logging.getLogger(__name__)

SCHEMA = "mergit.routing_decision"
"""`defineSchema`'s own name (`chain/arkiv/src/schema.js`), which Arkiv turns into the built-in,
always-queryable `arkiv.schema` attribute — confirmed live: `arkiv.schema = str('my-app.posts')`
matches the docs' own example entity on the real Rabdi network, so this is a real filter, not sugar."""


@dataclass(frozen=True)
class Decision:
    """One routing decision to mirror (`write_decisions`) or as read back (`read_decisions`'s
    `MirroredDecision`, which adds `entity_key`). `decision_id` and `seed` link this entity back to
    the exact `routing_decisions` row and let anyone replay the draw — the thing migration 0016 says
    that table exists for; a mirror without them is only a record of the outcome, not of how it was
    reached."""

    decision_id: int
    task_index: int
    category: str
    seed: int
    budget_micros: int
    decided_at: str
    candidates: list[dict[str, Any]]
    picks: list[dict[str, Any]]


@dataclass(frozen=True)
class MirroredDecision(Decision):
    entity_key: str = ""


class ArkivMirror:
    def __init__(
        self,
        rpc_url: str,
        access_key: str | None,
        owner_address: str,
        sidecar_url: str | None,
        sidecar_token: str | None,
        ttl_days: int,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._rpc_url = f"{rpc_url}/{access_key}" if access_key else rpc_url
        self._owner = owner_address.lower()
        self._sidecar_url = sidecar_url
        self._sidecar_token = sidecar_token
        self._ttl_days = ttl_days
        self._http = http_client or httpx.AsyncClient()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def write_decisions(self, plan_id: str, decisions: list[Decision]) -> None:
        """One HTTP call to the sidecar, one on-chain transaction for every task in `decisions`. Raises
        on failure (no sidecar configured, unreachable, out of funds, a bad key); the caller decides
        whether that may fail the request (it must not — see this module's docstring).

        No requester address on the entity: a discarded draft plan can't be deleted off Arkiv (entities
        are append-only; only expiry removes them), so attaching the requester's wallet to public,
        permanent-until-expiry data would outlive the user's own "discard" action. Nothing here ever
        filtered reads by it either — `describe_query` only needs `planId` and `$owner`."""
        if not self._sidecar_url:
            raise RuntimeError("ARKIV_SIDECAR_URL is not set; nothing to mirror to")
        body = {
            "ttl_days": self._ttl_days,
            "decisions": [
                {
                    "plan_id": plan_id,
                    "decision_id": d.decision_id,
                    "task_index": d.task_index,
                    "category": d.category,
                    "seed": d.seed,
                    "budget_micros": d.budget_micros,
                    "decided_at": d.decided_at,
                    "candidates": d.candidates,
                    "picks": d.picks,
                }
                for d in decisions
            ],
        }
        headers = {"Authorization": f"Bearer {self._sidecar_token}"} if self._sidecar_token else {}
        response = await self._http.post(
            f"{self._sidecar_url}/internal/mirror", json=body, headers=headers, timeout=120.0
        )
        response.raise_for_status()

    def describe_query(self, plan_id: str) -> str:
        """The exact query `read_decisions` runs, for display (README's/the panel's "one query anyone
        can run") — real and copy-pasteable, not illustrative: schema tag, plan id, and the owner filter
        that keeps a spoofed entity with Mergit's own tag out of someone else's results. Ordered by
        key so a second page (`read_decisions`' own `limit`) is stable across calls, per the docs'
        own pagination note."""
        return (
            f"arkiv.schema = str('{SCHEMA}') AND planId = str('{plan_id}')"
            f" AND $owner = addr({self._owner}) ORDER BY $key ASC"
        )

    async def read_decisions(self, plan_id: str, *, limit: int = 50) -> list[MirroredDecision]:
        """Every live mirrored decision for one plan, filtered by schema, plan id, *and* `$owner` (the
        service wallet) — without the owner filter, anyone could write a spoofed entity with Mergit's
        own schema tag and a matching `planId` and have it show up in another plan's panel."""
        query = self.describe_query(plan_id)
        response = await self._http.post(
            self._rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "arkiv_query",
                "params": [query, {"select": {"key": True, "attributes": True}, "limit": limit}],
            },
            timeout=20.0,
        )
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            raise RuntimeError(f"arkiv_query failed: {body['error']}")
        out: list[MirroredDecision] = []
        for entity in body.get("result", {}).get("data", []):
            decoded = _decode(entity)
            if decoded is not None:
                out.append(decoded)
        return out


def _as_int(value: Any) -> int:
    """`i32` attributes (`taskIndex`) come back as a plain JSON number; `u64` ones (`decisionId`,
    `seed`, `budgetMicros`) come back as a hex quantity (`"0x2a"`) — confirmed live against Rabdi's
    own `select` output. Both go through `int()` once this normalizes the hex case."""
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    return int(value)


def _decode(entity: dict[str, Any]) -> MirroredDecision | None:
    """Arkiv is a public, permissionless database: anyone can write an entity matching our schema,
    plan id and owner filter (if they also control the service wallet — they don't, but a malformed
    or future-schema entity from our own future code is still a real possibility), so a decode failure
    is skipped and logged, never raised."""
    try:
        attrs = {a["name"]: a["value"] for a in entity.get("attributes", [])}
        body: dict[str, Any] = {}
        raw_body = attrs.get("body")
        if isinstance(raw_body, str) and raw_body.startswith("0x"):
            parsed: Any = json.loads(bytes.fromhex(raw_body[2:]))
            if isinstance(parsed, dict):
                body = cast("dict[str, Any]", parsed)
        return MirroredDecision(
            entity_key=str(entity.get("key", "")),
            decision_id=_as_int(attrs.get("decisionId", -1)),
            task_index=_as_int(attrs.get("taskIndex", -1)),
            category=str(attrs.get("category", "")),
            seed=_as_int(attrs.get("seed", 0)),
            budget_micros=_as_int(attrs.get("budgetMicros", 0)),
            decided_at=str(attrs.get("decidedAt", "")),
            candidates=body.get("candidates", []),
            picks=body.get("picks", []),
        )
    except (TypeError, ValueError, KeyError, json.JSONDecodeError):
        log.warning("skipping an unreadable entity tagged %r: %r", SCHEMA, entity.get("key"))
        return None
