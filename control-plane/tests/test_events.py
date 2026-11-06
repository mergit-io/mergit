"""Outbox for events to the chain gateway (spec/events-v0.md transport). Run with `pytest -m postgres`."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import psycopg
import pytest

from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.events import EventDeliverer, EventSchemaError, enqueue
from mergit_cp.spec import validate_event

pytestmark = pytest.mark.postgres

PLAN_A = "0x" + "a" * 64
PLAN_B = "0x" + "b" * 64


def approved(plan_id: str = PLAN_A) -> dict[str, Any]:
    return {
        "plan_id": plan_id,
        "plan_uuid": "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b",
        "requester": "0x" + "1" * 40,
        "total_budget_usdc_units": "1000000",
        "funding": "wallet",
    }


Handler = Callable[[httpx.Request], Awaitable[httpx.Response]]


def run(database_url: str, body: Callable[[Pool], Awaitable[Any]]) -> Any:
    async def go() -> Any:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
                await conn.execute("TRUNCATE outbox")
            return await body(pool)
        finally:
            await pool.close()

    return asyncio.run(go())


def deliverer(pool: Pool, handler: Handler, **over: Any) -> EventDeliverer:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return EventDeliverer(pool, "http://gateway.test", "events-secret", client=client, **over)


async def add(pool: Pool, plan_id: str = PLAN_A, window_s: float = 600) -> str:
    async with pool.connection() as conn:
        return await enqueue(
            conn, "plan.approved", approved(plan_id), plan_id=plan_id, retry_window_s=window_s
        )


def rows(database_url: str) -> list[dict[str, Any]]:
    with psycopg.connect(database_url) as conn:
        cur = conn.execute(
            "SELECT event_id::text, attempts, delivered_at IS NOT NULL, failed_at IS NOT NULL,"
            " next_at > now(), last_error FROM outbox ORDER BY id"
        )
        keys = ["event_id", "attempts", "delivered", "failed", "deferred", "last_error"]
        return [dict(zip(keys, r, strict=True)) for r in cur.fetchall()]


def test_delivers_with_bearer_token_and_idempotency_key(database_url: str) -> None:
    seen: list[httpx.Request] = []

    async def ok(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    async def body(pool: Pool) -> tuple[str, int]:
        event_id = await add(pool)
        return event_id, await deliverer(pool, ok).deliver_due()

    event_id, sent = run(database_url, body)
    assert sent == 1
    [request] = seen
    assert str(request.url) == "http://gateway.test/v0/events"
    assert request.headers["authorization"] == "Bearer events-secret"
    assert request.headers["idempotency-key"] == event_id
    envelope = json.loads(request.content)
    validate_event(envelope)
    assert envelope["event_id"] == event_id
    assert rows(database_url)[0]["delivered"]


def test_server_error_is_retried_later_with_the_same_event_id(database_url: str) -> None:
    ids: list[str] = []
    answers = [503, 200]

    async def flaky(request: httpx.Request) -> httpx.Response:
        ids.append(request.headers["idempotency-key"])
        return httpx.Response(answers.pop(0))

    async def body(pool: Pool) -> None:
        await add(pool)
        d = deliverer(pool, flaky)
        await d.deliver_due()
        assert rows(database_url)[0] | {"last_error": None} == rows(database_url)[0] | {
            "attempts": 1,
            "delivered": False,
            "failed": False,
            "deferred": True,
            "last_error": None,
        }
        assert await d.deliver_due() == 0  # not due yet
        async with pool.connection() as conn:
            await conn.execute("UPDATE outbox SET next_at = now()")
        await d.deliver_due()

    run(database_url, body)
    assert len(ids) == 2 and ids[0] == ids[1]
    assert rows(database_url)[0]["delivered"]


def test_transport_error_is_retried(database_url: str) -> None:
    async def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async def body(pool: Pool) -> None:
        await add(pool)
        await deliverer(pool, down).deliver_due()

    run(database_url, body)
    row = rows(database_url)[0]
    assert (row["attempts"], row["delivered"], row["failed"], row["deferred"]) == (1, False, False, True)
    assert "ConnectError" in row["last_error"]


def test_client_error_is_not_retried(database_url: str) -> None:
    async def bad(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="schema says no")

    async def body(pool: Pool) -> None:
        await add(pool)
        await deliverer(pool, bad).deliver_due()

    run(database_url, body)
    row = rows(database_url)[0]
    assert (row["failed"], row["delivered"]) == (True, False)
    assert "400" in row["last_error"]


def test_gives_up_after_the_retry_window(database_url: str) -> None:
    async def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502)

    async def body(pool: Pool) -> None:
        await add(pool, window_s=0)
        await deliverer(pool, down).deliver_due()

    run(database_url, body)
    assert rows(database_url)[0]["failed"]


def test_events_of_one_plan_go_out_in_order(database_url: str) -> None:
    sent: list[str] = []
    answers = {PLAN_A: [503, 200, 200], PLAN_B: [200]}

    async def by_plan(request: httpx.Request) -> httpx.Response:
        plan = json.loads(request.content)["payload"]["plan_id"]
        sent.append(plan)
        return httpx.Response(answers[plan].pop(0))

    async def body(pool: Pool) -> None:
        await add(pool, PLAN_A)
        await add(pool, PLAN_A)
        await add(pool, PLAN_B)
        d = deliverer(pool, by_plan)
        await d.deliver_due()
        # A's first event failed, so A's second waits; B is independent and goes out.
        assert sent == [PLAN_A, PLAN_B]
        async with pool.connection() as conn:
            await conn.execute("UPDATE outbox SET next_at = now()")
        await d.deliver_due()
        await d.deliver_due()

    run(database_url, body)
    assert sent == [PLAN_A, PLAN_B, PLAN_A, PLAN_A]
    assert all(r["delivered"] for r in rows(database_url))


def dispatch(attempt: int, plan_id: str = PLAN_A) -> dict[str, Any]:
    return {
        "task_id": "0x" + f"{attempt:x}" * 64,
        "plan_id": plan_id,
        "index": 0,
        "attempt": attempt,
        "agent_id": "1",
        "amount_usdc_units": "500000",
        "category": "test-repair",
        "phi_hash": "0x" + "c" * 64,
        "deadline_unix": 2_000_000_000,
    }


def test_a_retry_waiting_on_its_escrow_holds_up_no_other_event_of_its_plan(database_url: str) -> None:
    sent: list[str] = []

    async def gateway(request: httpx.Request) -> httpx.Response:
        envelope = json.loads(request.content)
        sent.append(f"{envelope['type']}:{envelope['payload'].get('attempt', '')}")
        # The gateway holds a retry while the previous attempt still holds its payment.
        return httpx.Response(503 if envelope["payload"].get("attempt") == 2 else 200)

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn:
            await enqueue(conn, "task.dispatch_requested", dispatch(2), plan_id=PLAN_A, retry_window_s=2400)
            await enqueue(conn, "task.dispatch_requested", dispatch(1), plan_id=PLAN_A, retry_window_s=600)
        await deliverer(pool, gateway).deliver_due()

    run(database_url, body)
    assert sent == ["task.dispatch_requested:2", "task.dispatch_requested:1"]
    retry, other = rows(database_url)
    assert (retry["delivered"], retry["failed"], retry["deferred"]) == (False, False, True)
    assert other["delivered"]


def test_a_first_attempt_still_holds_up_the_events_after_it(database_url: str) -> None:
    sent: list[int] = []

    async def down_once(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content)["payload"]["attempt"])
        return httpx.Response(503)

    async def body(pool: Pool) -> None:
        async with pool.connection() as conn:
            await enqueue(conn, "task.dispatch_requested", dispatch(1), plan_id=PLAN_A, retry_window_s=600)
            await enqueue(conn, "task.dispatch_requested", dispatch(2), plan_id=PLAN_A, retry_window_s=2400)
        await deliverer(pool, down_once).deliver_due()

    run(database_url, body)
    assert sent == [1]


def test_two_deliverers_never_send_the_same_event_twice(database_url: str) -> None:
    sent: list[str] = []

    async def slow(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers["idempotency-key"])
        await asyncio.sleep(0.2)
        return httpx.Response(200)

    async def body(pool: Pool) -> None:
        for plan in (PLAN_A, PLAN_B):
            await add(pool, plan)
        await asyncio.gather(deliverer(pool, slow).deliver_due(), deliverer(pool, slow).deliver_due())

    run(database_url, body)
    assert len(sent) == 2 and len(set(sent)) == 2


def test_enqueue_rejects_a_payload_that_breaks_the_spec(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        async with pool.connection() as conn:
            with pytest.raises(EventSchemaError):
                await enqueue(
                    conn,
                    "plan.approved",
                    approved() | {"total_budget_usdc_units": 1000000},
                    plan_id=PLAN_A,
                    retry_window_s=600,
                )

    run(database_url, body)
    assert rows(database_url) == []


@pytest.mark.parametrize("payload", [{}, {"plan_id": PLAN_A, "extra": 1}])
def test_validate_event_rejects_bad_payloads(payload: dict[str, Any]) -> None:
    with pytest.raises(EventSchemaError):
        validate_event(
            {
                "event_id": "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b",
                "type": "plan.closed",
                "at": "2026-10-28T10:00:00.000Z",
                "payload": payload,
            }
        )
