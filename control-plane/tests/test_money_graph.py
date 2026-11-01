"""Plan task O6, money half, Review Focus item 1: verdicts and payments move money, never the task graph.

Three independent checks, because "no code path does X" is easiest to break quietly:
- behaviour: delivering any money event, in any job state, changes no plan, task, job, dispatch or outbox row;
- behaviour: the graph reacts to a failed job identically with and without money events in the ledger;
- structure: the ledger module imports nothing from the graph side and writes none of its tables, and the
  graph side never reads the ledger.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

import pytest
from psycopg.rows import dict_row

from mergit_cp import outcomes
from mergit_cp.config import Settings
from mergit_cp.db import Pool
from tests.test_api import seed_plan
from tests.test_money import ADDR, receive, run, tx

PACKAGE = Path(__file__).resolve().parents[1] / "mergit_cp"
OWNER = "0x" + "1" * 40


def money_events(task_id: str, plan_id: str) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = [
        ("receipt.committed", {"task_id": task_id, "tx": tx("1")}),
        ("task.released", {"task_id": task_id, "to": ADDR, "amount_usdc_units": "5", "tx": tx("2")}),
        (
            "challenge.opened",
            {
                "task_id": task_id,
                "challenge_id": "1",
                "challenger": ADDR,
                "bond_usdc_units": "1",
                "tx": tx("3"),
            },
        ),
        ("challenge.resolved", {"task_id": task_id, "challenge_id": "1", "upheld": True, "tx": tx("4")}),
        ("credits.denied", {"plan_id": plan_id, "reason": "no_credits"}),
    ]
    events += [
        ("verdict.recorded", {"task_id": task_id, "verdict": v, "tx": tx("5")})
        for v in ("pass", "fail", "invalid")
    ]
    events += [
        ("task.returned", {"task_id": task_id, "amount_usdc_units": "5", "reason": r, "tx": tx("6")})
        for r in ("fail", "invalid", "deadline", "challenge")
    ]
    return events


JOB_STATES = {
    "running": "UPDATE jobs SET status = 'running' WHERE task_id = %s",
    "queued": "UPDATE jobs SET status = 'queued' WHERE task_id = %s",
    "failed_not_yet_processed": (
        "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s"
    ),
    "passed_and_processed": (
        "UPDATE jobs SET status = 'done', phi_holds = true, finished_at = now(),"
        " outcome_processed_at = now() WHERE task_id = %s"
    ),
}


async def snapshot(pool: Pool, plan_uuid: str, plan_id: str) -> dict[str, list[dict[str, Any]]]:
    queries = {
        "plans": ("SELECT * FROM plans WHERE plan_uuid = %s", plan_uuid),
        "tasks": ('SELECT * FROM tasks WHERE plan_uuid = %s ORDER BY "index"', plan_uuid),
        "jobs": ("SELECT * FROM jobs WHERE plan_uuid = %s ORDER BY task_id", plan_uuid),
        "dispatches": ("SELECT * FROM task_dispatches WHERE plan_uuid = %s ORDER BY task_id", plan_uuid),
        "outbox": ("SELECT id, type, body FROM outbox WHERE plan_id = %s ORDER BY id", plan_id),
    }
    out: dict[str, list[dict[str, Any]]] = {}
    async with pool.connection() as conn:
        cur = conn.cursor(row_factory=dict_row)
        for name, (sql, arg) in queries.items():
            await cur.execute(sql, (arg,))
            out[name] = await cur.fetchall()
    return out


@pytest.mark.postgres
@pytest.mark.parametrize("job_state", JOB_STATES)
def test_no_money_event_changes_the_graph(database_url: str, settings: Settings, job_state: str):
    async def body(pool: Pool) -> None:
        plan_uuid, plan_id, task_ids = await seed_plan(pool, requester=OWNER, state="running")
        async with pool.connection() as conn:
            await conn.execute(JOB_STATES[job_state], (task_ids[1],))
        before = await snapshot(pool, plan_uuid, plan_id)
        for kind, payload in money_events(task_ids[1], plan_id):
            assert await receive(pool, settings, kind, payload) is True, kind
        assert await snapshot(pool, plan_uuid, plan_id) == before

    run(database_url, body)


@pytest.mark.postgres
def test_a_failed_job_is_handled_the_same_with_and_without_money_events(
    database_url: str, settings: Settings
):
    async def dispatches_after_processing(pool: Pool, with_events: bool) -> tuple[int, list[str]]:
        plan_uuid, plan_id, task_ids = await seed_plan(pool, requester=OWNER, state="running", n_tasks=1)
        async with pool.connection() as conn:
            await conn.execute("UPDATE tasks SET agents = '{1,2}' WHERE plan_uuid = %s", (plan_uuid,))
            await conn.execute(
                "UPDATE jobs SET status = 'error', phi_holds = false, finished_at = now() WHERE task_id = %s",
                (task_ids[0],),
            )
        if with_events:
            for kind, payload in money_events(task_ids[0], plan_id):
                await receive(pool, settings, kind, payload)
        # `process_due` now manages its own (one-per-job) transactions internally (fix round 2) -- it takes
        # the pool directly, not an already-open connection/transaction.
        await outcomes.process_due(pool, settings, limit=1000)
        after = await snapshot(pool, plan_uuid, plan_id)
        return len(after["dispatches"]), [r["type"] for r in after["outbox"]]

    async def body(pool: Pool) -> None:
        plain = await dispatches_after_processing(pool, with_events=False)
        noisy = await dispatches_after_processing(pool, with_events=True)
        assert plain == noisy
        assert plain[0] == 2  # the retry was dispatched; no verdict or return, "fail" included, asked for it

    run(database_url, body)


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            names |= {node.module or ""} | {a.name for a in node.names}
        elif isinstance(node, ast.Import):
            names |= {a.name for a in node.names}
    return names


GRAPH_SIDE = ("dispatch", "outcomes", "graph", "plans")
GRAPH_TABLES = ("plans", "tasks", "jobs", "task_dispatches", "outbox")


def test_the_ledger_module_cannot_reach_the_graph():
    source = (PACKAGE / "money.py").read_text()
    imported = {name.rsplit(".", 1)[-1] for name in _imports(PACKAGE / "money.py")}
    assert imported.isdisjoint(GRAPH_SIDE), imported & set(GRAPH_SIDE)
    writes = re.findall(
        rf"(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+({'|'.join(GRAPH_TABLES)})\b", source, re.I
    )
    assert writes == []


@pytest.mark.parametrize("module", GRAPH_SIDE)
def test_the_graph_side_never_reads_the_ledger(module: str):
    path = PACKAGE / f"{module}.py"
    assert "money" not in {name.rsplit(".", 1)[-1] for name in _imports(path)}
    assert "money_events" not in path.read_text()


def test_the_guard_itself_fires():
    """A guard that cannot fail proves nothing: feed the checks a module that does what they forbid."""
    bad = "from . import dispatch\nawait conn.execute('UPDATE jobs SET phi_holds = true')\n"
    assert "dispatch" in {
        n.rsplit(".", 1)[-1] for n in {a.name for a in ast.walk(ast.parse(bad)) if isinstance(a, ast.alias)}
    }
    assert re.findall(rf"UPDATE\s+({'|'.join(GRAPH_TABLES)})\b", bad, re.I) == ["jobs"]
