"""The money ledger (plan task O6, money half). Run with `pytest -m postgres`.

Events go through `chain_events.receive`, the same entry point `POST /v0/chain-events` uses, so what is
tested is the transaction the gateway's events really run in.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import mergit_receipt
import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.sql import SQL
from psycopg.types.json import Jsonb

from mergit_cp import chain_events
from mergit_cp.config import Settings
from mergit_cp.db import MIGRATIONS_DIR, Pool, migrate, open_pool
from mergit_cp.spec import EventSchemaError
from tests.test_api import seed_plan

pytestmark = pytest.mark.postgres
MIGRATIONS = MIGRATIONS_DIR

ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"  # mixed case, as a checksummed address would be
OVERSIZED = str(2**256)


def run(database_url: str, body: Callable[[Pool], Awaitable[None]]) -> None:
    async def go() -> None:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
            await body(pool)
        finally:
            await pool.close()

    asyncio.run(go())


def tx(c: str) -> str:
    return "0x" + c * 64


async def receive(
    pool: Pool, settings: Settings, event_type: str, payload: dict[str, Any], event_id: str | None = None
) -> bool:
    envelope = {
        "event_id": event_id or str(uuid.uuid4()),
        "type": event_type,
        "at": "2026-10-29T00:00:00.000Z",
        "payload": payload,
    }
    async with pool.connection() as conn, conn.transaction():
        return await chain_events.receive(conn, envelope, settings)


async def rows(pool: Pool, plan_uuid: str) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        await cur.execute("SELECT * FROM money_events WHERE plan_uuid = %s ORDER BY id", (plan_uuid,))
        return await cur.fetchall()


def cases(task_id: str, plan_id: str) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    """(event type, payload, the typed columns the ledger row must carry)."""
    return [
        ("receipt.committed", {"task_id": task_id, "tx": tx("1")}, {"tx": tx("1")}),
        (
            "verdict.recorded",
            {"task_id": task_id, "verdict": "fail", "tx": tx("2")},
            {"verdict": "fail", "tx": tx("2")},
        ),
        (
            "task.released",
            {"task_id": task_id, "to": ADDR, "amount_usdc_units": "500000", "tx": tx("3")},
            {"payee": ADDR.lower(), "amount_usdc_units": 500000, "tx": tx("3")},
        ),
        (
            "task.returned",
            {"task_id": task_id, "amount_usdc_units": "250000", "reason": "deadline", "tx": tx("4")},
            {"amount_usdc_units": 250000, "reason": "deadline", "tx": tx("4")},
        ),
        (
            "challenge.opened",
            {
                "task_id": task_id,
                "challenge_id": "7",
                "challenger": ADDR,
                "bond_usdc_units": "100000",
                "tx": tx("5"),
            },
            {"challenge_id": 7, "challenger": ADDR.lower(), "bond_usdc_units": 100000, "tx": tx("5")},
        ),
        (
            "challenge.resolved",
            {"task_id": task_id, "challenge_id": "7", "upheld": True, "tx": tx("6")},
            {"challenge_id": 7, "upheld": True, "tx": tx("6")},
        ),
        ("credits.denied", {"plan_id": plan_id, "reason": "over_value_cap"}, {"reason": "over_value_cap"}),
    ]


def test_every_kind_is_one_structured_row_with_its_tx(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, plan_id, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        for kind, payload, _ in cases(task_ids[0], plan_id):
            assert await receive(pool, settings, kind, payload) is True
        got = await rows(pool, plan_uuid)
        assert [r["kind"] for r in got] == [c[0] for c in cases(task_ids[0], plan_id)]
        for row, (kind, _, expected) in zip(got, cases(task_ids[0], plan_id), strict=True):
            assert row["plan_uuid"] is not None
            assert row["task_id"] == (None if kind == "credits.denied" else task_ids[0])
            for column, value in expected.items():
                assert row[column] == value, (kind, column)
            unused = {
                c
                for c in ("verdict", "payee", "amount_usdc_units", "reason", "challenge_id", "challenger")
                if c not in expected
            }
            assert all(row[c] is None for c in unused), kind

    run(database_url, body)


def test_a_redelivered_event_is_one_row(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        event_id = str(uuid.uuid4())
        payload = {"task_id": task_ids[0], "verdict": "pass", "tx": tx("a")}
        assert await receive(pool, settings, "verdict.recorded", payload, event_id) is True
        assert await receive(pool, settings, "verdict.recorded", payload, event_id) is False
        assert len(await rows(pool, plan_uuid)) == 1

    run(database_url, body)


def test_the_same_on_chain_event_under_a_new_event_id_is_still_one_row(database_url: str, settings: Settings):
    """The gateway re-reading logs after losing its cursor builds a fresh envelope for the same log."""

    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        payload = {"task_id": task_ids[0], "to": ADDR, "amount_usdc_units": "5", "tx": tx("b")}
        assert await receive(pool, settings, "task.released", payload) is True
        assert await receive(pool, settings, "task.released", payload) is True  # new event_id: accepted
        assert len(await rows(pool, plan_uuid)) == 1
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) FROM chain_events_seen WHERE payload ->> 'tx' = %s", (tx("b"),)
            )
            row = await cur.fetchone()
        assert row is not None and row[0] == 2  # the raw log keeps both, the ledger one

    run(database_url, body)


def test_two_challenges_in_one_transaction_are_two_rows(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        for challenge_id in ("1", "2"):
            await receive(
                pool,
                settings,
                "challenge.resolved",
                {"task_id": task_ids[0], "challenge_id": challenge_id, "upheld": False, "tx": tx("c")},
            )
        assert [r["challenge_id"] for r in await rows(pool, plan_uuid)] == [1, 2]

    run(database_url, body)


def test_an_unknown_task_or_plan_is_accepted_but_has_no_ledger_row(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        stray_task = {"task_id": tx("9"), "verdict": "pass", "tx": tx("d")}
        stray_plan = {"plan_id": tx("8"), "reason": "no_credits"}
        assert await receive(pool, settings, "verdict.recorded", stray_task) is True
        assert await receive(pool, settings, "credits.denied", stray_plan) is True
        async with pool.connection() as conn:
            seen = await (
                await conn.execute(
                    "SELECT count(*) FROM chain_events_seen WHERE payload ->> 'task_id' = %s"
                    " OR payload ->> 'plan_id' = %s",
                    (tx("9"), tx("8")),
                )
            ).fetchone()
            ledger = await (
                await conn.execute("SELECT count(*) FROM money_events WHERE task_id = %s", (tx("9"),))
            ).fetchone()
        assert seen is not None and seen[0] == 2  # still in the raw log
        assert ledger is not None and ledger[0] == 0

    run(database_url, body)


def test_a_number_that_does_not_fit_a_uint256_is_rejected_and_nothing_is_stored(
    database_url: str, settings: Settings
):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        event_id = str(uuid.uuid4())
        with pytest.raises(EventSchemaError, match="uint256"):
            await receive(
                pool,
                settings,
                "task.released",
                {"task_id": task_ids[0], "to": ADDR, "amount_usdc_units": OVERSIZED, "tx": tx("e")},
                event_id,
            )
        assert await rows(pool, plan_uuid) == []
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) FROM chain_events_seen WHERE event_id = %s", (event_id,)
            )
            row = await cur.fetchone()
        assert row is not None and row[0] == 0  # rolled back with the rest, so a corrected resend works

    run(database_url, body)


def test_the_largest_uint256_is_stored_exactly(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        top = 2**256 - 1
        await receive(
            pool,
            settings,
            "task.released",
            {"task_id": task_ids[0], "to": ADDR, "amount_usdc_units": str(top), "tx": tx("f")},
        )
        assert (await rows(pool, plan_uuid))[0]["amount_usdc_units"] == top

    run(database_url, body)


def test_events_after_the_plan_closed_are_still_recorded(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40, state="closed")
        await receive(
            pool,
            settings,
            "task.returned",
            {"task_id": task_ids[1], "amount_usdc_units": "9", "reason": "deadline", "tx": tx("1")},
        )
        assert len(await rows(pool, plan_uuid)) == 1

    run(database_url, body)


def test_the_ledger_is_append_only(database_url: str, settings: Settings):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        await receive(
            pool, settings, "verdict.recorded", {"task_id": task_ids[0], "verdict": "pass", "tx": tx("2")}
        )
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
                await conn.execute(
                    "UPDATE money_events SET verdict = 'fail' WHERE plan_uuid = %s", (plan_uuid,)
                )
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
                await conn.execute("DELETE FROM money_events WHERE plan_uuid = %s", (plan_uuid,))
        assert (await rows(pool, plan_uuid))[0]["verdict"] == "pass"

    run(database_url, body)


@pytest.mark.parametrize(
    "columns",
    [
        {
            "kind": "task.released",
            "task_id": "T",
            "tx": tx("1"),
            "payee": "0x" + "a" * 40,
            "amount_usdc_units": 1,
            "verdict": "pass",
        },  # a field that kind must not carry
        {"kind": "verdict.recorded", "task_id": "T", "tx": tx("1"), "verdict": "maybe"},
        {"kind": "verdict.recorded", "task_id": "T", "tx": tx("1")},  # missing verdict
        {"kind": "task.returned", "task_id": "T", "tx": tx("1"), "amount_usdc_units": 1, "reason": "greed"},
        {
            "kind": "task.released",
            "task_id": "T",
            "tx": "0x12",
            "payee": "0x" + "a" * 40,
            "amount_usdc_units": 1,
        },
        {
            "kind": "task.released",
            "task_id": "T",
            "tx": tx("1"),
            "payee": "0x" + "a" * 40,
            "amount_usdc_units": -1,
        },
        {"kind": "credits.denied", "task_id": "T", "reason": "no_credits"},  # names a task
        {"kind": "credits.denied", "reason": "because"},
        {"kind": "mystery", "task_id": "T", "tx": tx("1")},
    ],
)
def test_the_table_refuses_a_malformed_row(database_url: str, columns: dict[str, Any]):
    async def body(pool: Pool) -> None:
        plan_uuid, _, task_ids = await seed_plan(pool, requester="0x" + "1" * 40)
        event_id = str(uuid.uuid4())
        row = {k: (task_ids[0] if v == "T" else v) for k, v in columns.items()}
        async with pool.connection() as conn:
            await conn.execute(
                "INSERT INTO chain_events_seen (event_id, type, payload) VALUES (%s, 'x', '{}')", (event_id,)
            )
            names = ", ".join(["event_id", "plan_uuid", *row])
            marks = ", ".join(["%s"] * (2 + len(row)))
            with pytest.raises(psycopg.errors.CheckViolation):
                await conn.execute(
                    f"INSERT INTO money_events ({names}) VALUES ({marks})",  # test-only columns
                    (event_id, plan_uuid, *row.values()),
                )

    run(database_url, body)


def test_the_migration_backfills_history_from_the_raw_log(database_url: str, tmp_path: Path):
    """An upgrade must not empty a plan's money history: the run API stops reading the raw log."""
    name = f"backfill_{uuid.uuid4().hex[:10]}"
    url = make_conninfo(database_url, dbname=name)
    old = tmp_path / "migrations"
    old.mkdir()
    # Every migration except the one under test, not "< 0006": a later migration added after this
    # test was written (0009, from #15) must not also show up as newly applied below. 0015 reads the
    # ledger (a view over money_events), so it cannot exist without 0006 and is applied with it.
    held_back = {"0006_money_events", "0015_reputation"}
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.stem not in held_back:
            (old / path.name).write_text(path.read_text())

    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    task_id = mergit_receipt.task_id(plan_id, 0, 1)

    async def raw(conn: psycopg.AsyncConnection[Any], n: int, kind: str, payload: dict[str, Any]) -> str:
        event_id = str(uuid.uuid4())
        await conn.execute(
            "INSERT INTO chain_events_seen (event_id, type, payload, received_at)"
            " VALUES (%s, %s, %s, %s::timestamptz + make_interval(secs => %s))",
            (event_id, kind, Jsonb(payload), "2026-10-29 10:00:00+00", n),
        )
        return event_id

    async def go() -> list[dict[str, Any]]:
        async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as admin:
            await admin.execute(SQL(f'CREATE DATABASE "{name}"'))  # generated name
        try:
            async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
                await migrate(conn, old)
                await conn.execute(
                    "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
                    " budget_usdc_units, state, funding, total_budget_usdc_units, planner_model, approved_at)"
                    " VALUES (%s, %s, %s, 'g', 'https://github.com/a/b', 'main', 'c', 1, 'running', 'wallet',"
                    " 1, 'm', now())",
                    (plan_uuid, plan_id, "0x" + "1" * 40),
                )
                await conn.execute(
                    'INSERT INTO task_dispatches (task_id, plan_uuid, "index", attempt, agent_id)'
                    " VALUES (%s, %s, 0, 1, '1')",
                    (task_id, plan_uuid),
                )
                await raw(
                    conn,
                    1,
                    "task.released",
                    {"task_id": task_id, "to": ADDR, "amount_usdc_units": "42", "tx": tx("1")},
                )
                await raw(
                    conn,
                    2,
                    "task.released",  # the same log seen again under a new event_id
                    {"task_id": task_id, "to": ADDR, "amount_usdc_units": "42", "tx": tx("1")},
                )
                await raw(conn, 3, "verdict.recorded", {"task_id": task_id, "verdict": "pass", "tx": tx("2")})
                await raw(
                    conn,
                    4,
                    "task.released",  # a task this service never dispatched
                    {"task_id": tx("9"), "to": ADDR, "amount_usdc_units": "1", "tx": tx("3")},
                )
                await raw(
                    conn,
                    5,
                    "task.released",  # a number the column cannot hold
                    {"task_id": task_id, "to": ADDR, "amount_usdc_units": "9" * 80, "tx": tx("4")},
                )
                await raw(conn, 6, "credits.denied", {"plan_id": plan_id, "reason": "rate_limited"})
                await raw(
                    conn,
                    7,
                    "plan.funded",  # not a money event
                    {
                        "plan_id": plan_id,
                        "requester": ADDR,
                        "amount_usdc_units": "1",
                        "tier": "staked",
                        "tx": tx("5"),
                    },
                )
                await raw(
                    conn,
                    8,
                    # 78 digits, same as the column's capacity, but bigger than any real uint256
                    # (2**256 - 1 is also 78 digits): digit count alone would let this through.
                    "task.released",
                    {"task_id": task_id, "to": ADDR, "amount_usdc_units": "9" * 78, "tx": tx("6")},
                )
                assert await migrate(conn) == ["0006_money_events", "0015_reputation"]
                cur = conn.cursor(row_factory=dict_row)
                await cur.execute("SELECT * FROM money_events ORDER BY id")
                return await cur.fetchall()
        finally:
            async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as admin:
                await admin.execute(SQL(f'DROP DATABASE "{name}" WITH (FORCE)'))

    got = asyncio.run(go())
    assert [r["kind"] for r in got] == ["task.released", "verdict.recorded", "credits.denied"]
    assert got[0]["payee"] == ADDR.lower() and got[0]["amount_usdc_units"] == 42
    assert got[0]["plan_uuid"] == uuid.UUID(plan_uuid) and got[0]["task_id"] == task_id
    assert got[1]["verdict"] == "pass" and got[2]["reason"] == "rate_limited"
