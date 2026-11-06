"""The money ledger (plan task O6, money half): the gateway's verdict and payment events as records.

``record`` turns one gateway event into one ``money_events`` row, inside the transaction that already
stored the event in ``chain_events_seen`` (``mergit_cp/chain_events.py``), so the raw log and the ledger
commit together or not at all. ``list_for_plan`` is what the run API (O7) reads.

**This module never touches the task graph.** ``verdict.recorded``, ``task.released`` and ``task.returned``
move money and reputation, not the graph (spec/events-v0.md; Review Focus item 1: only ``phi_eval`` moves
it). So nothing here imports dispatch, outcomes, graph or plans, and nothing writes ``plans``, ``tasks``,
``jobs``, ``task_dispatches`` or ``outbox``. ``tests/test_money.py`` checks both facts.

An event naming a task or plan this service never dispatched (a gateway bug, or another deployment's
event on a shared chain) has no plan to belong to: it is logged and stays only in the raw log. A number
that does not fit a uint256 is a malformed event, rejected like any other schema violation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import TupleRow, dict_row

from .spec import EventSchemaError

log = logging.getLogger(__name__)

KINDS = (
    "receipt.committed",
    "verdict.recorded",
    "task.released",
    "task.returned",
    "challenge.opened",
    "challenge.resolved",
    "credits.denied",
)
"""The gateway events that concern money or a verdict. `error` events name no plan or task and stay in
the raw log."""

_UINT256_MAX = 2**256 - 1

_BLANK: dict[str, Any] = {
    "tx": None,
    "verdict": None,
    "payee": None,
    "amount_usdc_units": None,
    "reason": None,
    "challenge_id": None,
    "challenger": None,
    "bond_usdc_units": None,
    "upheld": None,
}


def _uint(value: str, field: str) -> int:
    number = int(value)
    if number > _UINT256_MAX:
        raise EventSchemaError(f"{field}: {value[:20]}... does not fit a uint256")
    return number


def _columns(kind: str, p: dict[str, Any]) -> dict[str, Any]:
    """The typed columns for one event. The payload already passed spec/schemas/event.json, so its keys
    exist; only the size of a number is left to check here."""
    tx = p.get("tx")
    if kind == "verdict.recorded":
        return {"tx": tx, "verdict": p["verdict"]}
    if kind == "task.released":
        return {
            "tx": tx,
            "payee": p["to"].lower(),
            "amount_usdc_units": _uint(p["amount_usdc_units"], "amount_usdc_units"),
        }
    if kind == "task.returned":
        return {
            "tx": tx,
            "amount_usdc_units": _uint(p["amount_usdc_units"], "amount_usdc_units"),
            "reason": p["reason"],
        }
    if kind == "challenge.opened":
        return {
            "tx": tx,
            "challenge_id": _uint(p["challenge_id"], "challenge_id"),
            "challenger": p["challenger"].lower(),
            "bond_usdc_units": _uint(p["bond_usdc_units"], "bond_usdc_units"),
        }
    if kind == "challenge.resolved":
        return {"tx": tx, "challenge_id": _uint(p["challenge_id"], "challenge_id"), "upheld": p["upheld"]}
    if kind == "credits.denied":
        return {"reason": p["reason"]}
    return {"tx": tx}  # receipt.committed


async def _resolve_plan(
    conn: AsyncConnection[TupleRow], kind: str, p: dict[str, Any]
) -> tuple[UUID | None, str | None]:
    """(plan_uuid, task_id): through `task_dispatches` for an event that names a task, through
    `plans.plan_id` for `credits.denied`, which names a plan."""
    if kind == "credits.denied":
        cur = await conn.execute("SELECT plan_uuid FROM plans WHERE plan_id = %s", (p["plan_id"],))
        row = await cur.fetchone()
        return (None if row is None else row[0]), None
    cur = await conn.execute("SELECT plan_uuid FROM task_dispatches WHERE task_id = %s", (p["task_id"],))
    row = await cur.fetchone()
    return (None if row is None else row[0]), p["task_id"]


async def record(conn: AsyncConnection[TupleRow], envelope: dict[str, Any]) -> bool:
    """Write the ledger row for one gateway event, in ``conn``'s transaction. Returns whether a row was
    written. ``envelope`` must already be validated and already stored in ``chain_events_seen``."""
    kind: str = envelope["type"]
    if kind not in KINDS:
        return False
    payload: dict[str, Any] = envelope["payload"]
    columns = _columns(kind, payload)
    plan_uuid, task_id = await _resolve_plan(conn, kind, payload)
    if plan_uuid is None:
        log.warning("%s names a plan or task this service never dispatched; kept in the raw log only", kind)
        return False
    cur = await conn.execute(
        "INSERT INTO money_events (event_id, kind, plan_uuid, task_id, tx, verdict, payee,"
        " amount_usdc_units, reason, challenge_id, challenger, bond_usdc_units, upheld)"
        " VALUES (%(event_id)s, %(kind)s, %(plan_uuid)s, %(task_id)s, %(tx)s, %(verdict)s, %(payee)s,"
        " %(amount_usdc_units)s, %(reason)s, %(challenge_id)s, %(challenger)s, %(bond_usdc_units)s,"
        " %(upheld)s) ON CONFLICT DO NOTHING RETURNING id",
        {
            **_BLANK,
            **columns,
            "event_id": envelope["event_id"],
            "kind": kind,
            "plan_uuid": plan_uuid,
            "task_id": task_id,
        },
    )
    if await cur.fetchone() is None:
        log.info("%s tx %s was already recorded under another event_id", kind, columns.get("tx"))
        return False
    return True


@dataclass(frozen=True, slots=True)
class MoneyEvent:
    """One ledger row, with the plan's own id and the task's index and attempt joined in."""

    id: int
    kind: str
    received_at: datetime
    plan_id: str
    task_id: str | None
    index: int | None
    attempt: int | None
    tx: str | None
    verdict: str | None
    payee: str | None
    amount_usdc_units: int | None
    reason: str | None
    challenge_id: int | None
    challenger: str | None
    bond_usdc_units: int | None
    upheld: bool | None


_LIST = """
SELECT m.id, m.kind, m.received_at, p.plan_id, m.task_id, d."index", d.attempt, m.tx, m.verdict, m.payee,
       m.amount_usdc_units, m.reason, m.challenge_id, m.challenger, m.bond_usdc_units, m.upheld
FROM money_events m
JOIN plans p ON p.plan_uuid = m.plan_uuid
LEFT JOIN task_dispatches d ON d.task_id = m.task_id
WHERE m.plan_uuid = %s
ORDER BY m.id
"""


def _int(value: Decimal | None) -> int | None:
    return None if value is None else int(value)


async def list_for_plan(conn: AsyncConnection[TupleRow], plan_uuid: UUID | str) -> list[MoneyEvent]:
    """Every ledger row of one plan, oldest first."""
    cur = conn.cursor(row_factory=dict_row)
    await cur.execute(_LIST, (str(plan_uuid),))
    return [
        MoneyEvent(
            id=r["id"],
            kind=r["kind"],
            received_at=r["received_at"],
            plan_id=r["plan_id"],
            task_id=r["task_id"],
            index=r["index"],
            attempt=r["attempt"],
            tx=r["tx"],
            verdict=r["verdict"],
            payee=r["payee"],
            amount_usdc_units=_int(r["amount_usdc_units"]),
            reason=r["reason"],
            challenge_id=_int(r["challenge_id"]),
            challenger=r["challenger"],
            bond_usdc_units=_int(r["bond_usdc_units"]),
            upheld=r["upheld"],
        )
        for r in await cur.fetchall()
    ]


def payload(e: MoneyEvent) -> dict[str, Any]:
    """The event's fields rebuilt from the typed columns (spec/schemas/event.json shape). Not
    byte-for-byte what the gateway sent: addresses are stored, and so come back, lowercase (see
    `_columns`), not in whatever case the gateway's payload used. Amounts are decimal strings, as
    everywhere in the API."""
    if e.kind == "credits.denied":
        return {"plan_id": e.plan_id, "reason": e.reason}
    body: dict[str, Any] = {"task_id": e.task_id}
    if e.kind == "verdict.recorded":
        body["verdict"] = e.verdict
    elif e.kind == "task.released":
        body |= {"to": e.payee, "amount_usdc_units": str(e.amount_usdc_units)}
    elif e.kind == "task.returned":
        body |= {"amount_usdc_units": str(e.amount_usdc_units), "reason": e.reason}
    elif e.kind == "challenge.opened":
        body |= {
            "challenge_id": str(e.challenge_id),
            "challenger": e.challenger,
            "bond_usdc_units": str(e.bond_usdc_units),
        }
    elif e.kind == "challenge.resolved":
        body |= {"challenge_id": str(e.challenge_id), "upheld": e.upheld}
    body["tx"] = e.tx
    return body


def view(e: MoneyEvent) -> dict[str, Any]:
    """One ledger row as the run API returns it. `type`, `at` and `payload` keep the shape O7 already
    had; `id`, `task_id`, `index`, `attempt` and `tx` are the structured fields a client can group on."""
    return {
        "id": e.id,
        "type": e.kind,
        "at": e.received_at.isoformat(),
        "task_id": e.task_id,
        "index": e.index,
        "attempt": e.attempt,
        "tx": e.tx,
        "payload": payload(e),
    }


_HOLDING = """
SELECT max(j.attempt) FROM jobs j
WHERE j.plan_uuid = %(plan)s AND j."index" = %(index)s
  AND NOT EXISTS (SELECT 1 FROM jobs n
                  WHERE n.plan_uuid = %(plan)s AND n."index" = %(index)s
                    AND n.attempt = (SELECT max(attempt) FROM task_dispatches
                                     WHERE plan_uuid = %(plan)s AND "index" = %(index)s))
  AND NOT EXISTS (SELECT 1 FROM money_events m
                  WHERE m.task_id = j.task_id AND m.kind IN ('task.released', 'task.returned'))
"""


async def holding_attempt(conn: AsyncConnection[TupleRow], plan_uuid: UUID | str, index: int) -> int | None:
    """An earlier attempt of task ``index`` whose payment the ledger has not seen released or returned, when
    the newest dispatch of that task never locked one (it has no job). The gateway only waits on attempt n-1
    before locking attempt n, so a retry sent behind a given-up attempt would lock a second payment out of
    the plan's shared balance while this one is still held. None when a retry is safe: the newest attempt
    locked (the gateway waits on it), or nothing earlier holds money. It only reads the graph's tables."""
    cur = await conn.execute(_HOLDING, {"plan": str(plan_uuid), "index": index})
    row = await cur.fetchone()
    return None if row is None or row[0] is None else int(row[0])
