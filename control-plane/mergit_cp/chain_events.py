"""POST /v0/chain-events: everything the chain gateway reports back (plan task O4, spec/events-v0.md).

Idempotent on ``event_id``: a retried delivery is accepted again with no second side effect, and in the
same transaction as that one side effect, so a crash between the two can never happen. Only the two events
that drive the task graph are acted on here. The money and verdict events (``receipt.committed``,
``verdict.recorded``, ``task.released``, ``task.returned``, ``challenge.*``, ``credits.denied``) are
written to the ``money_events`` ledger by ``mergit_cp/money.py`` in the same transaction (plan task O6,
money half); they move money and reputation, never the graph. ``error`` stays only in the raw log.
"""

from __future__ import annotations

import hmac
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException
from psycopg import AsyncConnection
from psycopg.rows import TupleRow
from psycopg.types.json import Jsonb

from . import dispatch, money, plans
from .auth import PoolDep, SettingsDep
from .config import Settings
from .spec import EventSchemaError, validate_event

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v0/chain-events", tags=["chain-events"])


def _check_token(settings: Settings, authorization: str | None) -> None:
    expected = f"Bearer {settings.chain_events_token.get_secret_value()}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="bad or missing token")


async def on_plan_funded(
    conn: AsyncConnection[TupleRow], payload: dict[str, Any], settings: Settings
) -> None:
    cur = await conn.execute(
        "SELECT plan_uuid FROM plans WHERE plan_id = %s FOR UPDATE", (payload["plan_id"],)
    )
    row = await cur.fetchone()
    if row is None:
        log.error("plan.funded for unknown plan_id %s", payload["plan_id"])
        return
    plan = await plans.load(conn, row[0], for_update=True)
    assert plan is not None
    if plan.state != "approved":
        # Already handled (a retried delivery past the event_id dedup below, or a gateway bug): a second
        # `plan.funded` must never dispatch a second round of attempt-1 jobs.
        log.warning("plan.funded for plan %s already %s; ignoring", plan.plan_id, plan.state)
        return
    await conn.execute(
        "UPDATE plans SET state = 'funded', updated_at = now() WHERE plan_uuid = %s", (plan.plan_uuid,)
    )
    dispatched = await dispatch.dispatch_ready(conn, plan, settings)
    if dispatched:
        await dispatch.mark_running(conn, plan.plan_uuid)
    else:
        # A legitimate state once auto-routing exists: every ready index could be routing='auto' with
        # every candidate agent's operator momentarily at its concurrency cap. The plan stays `funded`;
        # `dispatch.dispatch_waiting`'s periodic sweep is what moves it once capacity frees up.
        log.info(
            "plan %s funded; nothing dispatched yet (auto tasks may be waiting on capacity)", plan.plan_id
        )


async def on_task_escrowed(conn: AsyncConnection[TupleRow], payload: dict[str, Any]) -> None:
    if not await dispatch.record_escrowed(conn, payload["task_id"]):
        log.error("task.escrowed for a task_id this service never dispatched: %s", payload["task_id"])


async def receive(conn: AsyncConnection[TupleRow], envelope: dict[str, Any], settings: Settings) -> bool:
    """Record the event and, the first time, act on it. Returns False when it was already seen."""
    validate_event(envelope)
    cur = await conn.execute(
        "INSERT INTO chain_events_seen (event_id, type, payload) VALUES (%s, %s, %s)"
        " ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
        (envelope["event_id"], envelope["type"], Jsonb(envelope["payload"])),
    )
    if await cur.fetchone() is None:
        return False
    payload = envelope["payload"]
    if envelope["type"] == "plan.funded":
        await on_plan_funded(conn, payload, settings)
    elif envelope["type"] == "task.escrowed":
        await on_task_escrowed(conn, payload)
    elif envelope["type"] in money.KINDS:
        await money.record(conn, envelope)
    return True


@router.post("", status_code=200)
async def chain_event(
    body: dict[str, Any],
    settings: SettingsDep,
    pool: PoolDep,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    _check_token(settings, authorization)
    try:
        async with pool.connection() as conn, conn.transaction():
            is_new = await receive(conn, body, settings)
    except EventSchemaError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"new": is_new}
