"""Events to the chain gateway, through a transactional outbox (spec/events-v0.md, Transport).

``enqueue`` writes the event inside the caller's transaction, so an event exists if and only if the
state change it reports was committed. ``EventDeliverer`` sends pending events with the bearer token and
``Idempotency-Key``. 200 is delivered; another 4xx means the gateway rejected the event for good; 5xx and
transport errors are retried with backoff until the event's retry window ends, then it is marked failed
and logged as an error for an operator. Rows are claimed with SKIP LOCKED, so several API instances can
deliver without sending one event twice, and an event waits while an earlier event of its plan is pending,
unless that earlier event is a retry's dispatch.
"""

import asyncio
import logging
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import httpx
from psycopg import AsyncConnection
from psycopg.rows import TupleRow
from psycopg.types.json import Jsonb

from .db import Pool
from .spec import EventSchemaError, validate_event

__all__ = ["EventDeliverer", "EventSchemaError", "enqueue"]

log = logging.getLogger(__name__)


def _now_rfc3339() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def enqueue(
    conn: AsyncConnection[TupleRow],
    event_type: str,
    payload: dict[str, Any],
    *,
    plan_id: str | None,
    retry_window_s: float,
) -> str:
    """Write one event to the outbox in ``conn``'s transaction. Returns its event_id."""
    event_id = str(uuid.uuid4())
    envelope = {"event_id": event_id, "type": event_type, "at": _now_rfc3339(), "payload": payload}
    validate_event(envelope)
    await conn.execute(
        "INSERT INTO outbox (event_id, type, plan_id, body, give_up_at)"
        " VALUES (%s, %s, %s, %s, now() + make_interval(secs => %s))",
        (event_id, event_type, plan_id, Jsonb(envelope), retry_window_s),
    )
    return event_id


_CLAIM = """
SELECT id, event_id::text, body, attempts, give_up_at <= now() FROM outbox o
WHERE delivered_at IS NULL AND failed_at IS NULL AND next_at <= now()
  AND NOT EXISTS (
      SELECT 1 FROM outbox e
      WHERE e.plan_id = o.plan_id AND e.id < o.id AND e.delivered_at IS NULL AND e.failed_at IS NULL
        -- A retry's dispatch can wait half an hour for its previous attempt's payment
        -- (dispatch.RETRY_WINDOW_S), and nothing sent after it depends on it, so it holds up nothing.
        AND NOT (e.type = 'task.dispatch_requested' AND (e.body->'payload'->>'attempt')::int > 1)
  )
ORDER BY id
LIMIT %s
FOR UPDATE SKIP LOCKED
"""


class EventDeliverer:
    def __init__(
        self,
        pool: Pool,
        gateway_url: str,
        token: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 10.0,
        backoff_start_s: float = 1.0,
        backoff_max_s: float = 60.0,
    ) -> None:
        self._pool = pool
        self._url = f"{gateway_url.rstrip('/')}/v0/events"
        self._token = token
        self._http = client or httpx.AsyncClient(timeout=timeout_s)
        self._backoff_start_s = backoff_start_s
        self._backoff_max_s = backoff_max_s

    async def deliver_due(self, limit: int = 20) -> int:
        """Send every due event once. Returns how many were delivered."""
        delivered = 0
        async with self._pool.connection() as conn, conn.transaction():
            # The row locks are held while sending, so a second instance skips these rows.
            cur = await conn.execute(_CLAIM, (limit,))
            for row_id, event_id, body, attempts, expired in await cur.fetchall():
                outcome, error = await self._send(event_id, body)
                if outcome == "delivered":
                    await conn.execute("UPDATE outbox SET delivered_at = now() WHERE id = %s", (row_id,))
                    delivered += 1
                elif outcome == "rejected" or expired:
                    await conn.execute(
                        "UPDATE outbox SET failed_at = now(), attempts = attempts + 1, last_error = %s"
                        " WHERE id = %s",
                        (error, row_id),
                    )
                    log.error("event %s (%s) not delivered and given up: %s", event_id, body["type"], error)
                else:
                    delay = min(self._backoff_start_s * 2**attempts, self._backoff_max_s)
                    await conn.execute(
                        "UPDATE outbox SET attempts = attempts + 1, last_error = %s,"
                        " next_at = now() + make_interval(secs => %s) WHERE id = %s",
                        (error, delay, row_id),
                    )
                    log.warning(
                        "event %s (%s) failed, retrying in %.0fs: %s", event_id, body["type"], delay, error
                    )
        return delivered

    async def _send(self, event_id: str, body: dict[str, Any]) -> tuple[str, str | None]:
        try:
            response = await self._http.post(
                self._url,
                json=body,
                headers={"Authorization": f"Bearer {self._token}", "Idempotency-Key": event_id},
            )
        except httpx.TransportError as exc:
            return "retry", f"{type(exc).__name__}: {exc}"
        if response.status_code == 200:
            return "delivered", None
        error = f"HTTP {response.status_code}: {response.text[:300]}"
        return ("retry" if response.status_code >= 500 else "rejected"), error

    async def run(self, poll_s: float, stop: asyncio.Event) -> None:
        """Deliver until ``stop`` is set. A failing pass is logged and retried, never fatal."""
        while not stop.is_set():
            try:
                await self.deliver_due()
            except Exception:
                log.exception("event delivery pass failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_s)

    async def aclose(self) -> None:
        await self._http.aclose()
