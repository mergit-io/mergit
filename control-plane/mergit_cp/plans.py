"""Plan storage: drafts, edits and approval (plan task O3). Every function runs in the caller's
transaction, so a state change and the event that reports it commit together or not at all."""

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import TupleRow, dict_row
from psycopg.types.json import Jsonb

from .planner import TaskDraft


@dataclass(frozen=True)
class StoredTask:
    draft: TaskDraft
    phi_hash: str | None
    agents: list[str] | None


@dataclass(frozen=True)
class StoredPlan:
    plan_uuid: str
    plan_id: str
    requester: str
    goal: str
    repo_url: str
    ref: str
    category: str
    budget_usdc_units: int
    state: str
    funding: str | None
    total_budget_usdc_units: int | None
    created_at: datetime
    approved_at: datetime | None
    tasks: list[StoredTask]


async def insert_draft(
    conn: AsyncConnection[TupleRow],
    *,
    plan_uuid: str,
    plan_id: str,
    requester: str,
    goal: str,
    repo_url: str,
    ref: str,
    category: str,
    budget_usdc_units: int,
    planner_model: str,
    tasks: list[TaskDraft],
    idempotency_key: str | None = None,
) -> None:
    await conn.execute(
        "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
        " budget_usdc_units, planner_model, idempotency_key) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            plan_uuid,
            plan_id,
            requester,
            goal,
            repo_url,
            ref,
            category,
            budget_usdc_units,
            planner_model,
            idempotency_key,
        ),
    )
    await _insert_tasks(conn, plan_uuid, tasks)


async def _insert_tasks(conn: AsyncConnection[TupleRow], plan_uuid: str, tasks: list[TaskDraft]) -> None:
    for t in tasks:
        await conn.execute(
            'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, budget_usdc_units, depends_on)'
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (plan_uuid, t.index, t.title, t.instructions, Jsonb(t.phi), t.budget_usdc_units, t.depends_on),
        )


async def by_key(conn: AsyncConnection[TupleRow], requester: str, key: str) -> StoredPlan | None:
    """The plan this requester already made under ``key``, if any."""
    cur = await conn.execute(
        "SELECT plan_uuid FROM plans WHERE requester = %s AND idempotency_key = %s", (requester, key)
    )
    row = await cur.fetchone()
    return None if row is None else await load(conn, row[0])


async def load(
    conn: AsyncConnection[TupleRow], plan_uuid: UUID, *, for_update: bool = False
) -> StoredPlan | None:
    """The plan and its tasks. ``for_update`` locks the plan row until the transaction ends."""
    cur = conn.cursor(row_factory=dict_row)
    if for_update:
        await cur.execute("SELECT * FROM plans WHERE plan_uuid = %s FOR UPDATE", (plan_uuid,))
    else:
        await cur.execute("SELECT * FROM plans WHERE plan_uuid = %s", (plan_uuid,))
    plan = await cur.fetchone()
    if plan is None:
        return None
    await cur.execute('SELECT * FROM tasks WHERE plan_uuid = %s ORDER BY "index"', (plan_uuid,))
    tasks = [
        StoredTask(
            draft=TaskDraft(
                index=t["index"],
                title=t["title"],
                instructions=t["instructions"],
                phi=t["phi"],
                budget_usdc_units=t["budget_usdc_units"],
                depends_on=list(t["depends_on"]),
            ),
            phi_hash=t["phi_hash"],
            agents=None if t["agents"] is None else list(t["agents"]),
        )
        for t in await cur.fetchall()
    ]
    return StoredPlan(
        plan_uuid=str(plan["plan_uuid"]),
        plan_id=plan["plan_id"],
        requester=plan["requester"],
        goal=plan["goal"],
        repo_url=plan["repo_url"],
        ref=plan["ref"],
        category=plan["category"],
        budget_usdc_units=plan["budget_usdc_units"],
        state=plan["state"],
        funding=plan["funding"],
        total_budget_usdc_units=plan["total_budget_usdc_units"],
        created_at=plan["created_at"],
        approved_at=plan["approved_at"],
        tasks=tasks,
    )


async def replace_tasks(conn: AsyncConnection[TupleRow], plan_uuid: str, tasks: list[TaskDraft]) -> None:
    await conn.execute("DELETE FROM tasks WHERE plan_uuid = %s", (plan_uuid,))
    await _insert_tasks(conn, plan_uuid, tasks)
    await conn.execute("UPDATE plans SET updated_at = now() WHERE plan_uuid = %s", (plan_uuid,))


async def approve(
    conn: AsyncConnection[TupleRow],
    plan_uuid: str,
    *,
    picks: dict[int, list[str]],
    phi_hashes: dict[int, str],
    funding: str,
    total_budget_usdc_units: int,
) -> None:
    for index, agents in picks.items():
        await conn.execute(
            'UPDATE tasks SET agents = %s, phi_hash = %s WHERE plan_uuid = %s AND "index" = %s',
            (agents, phi_hashes[index], plan_uuid, index),
        )
    await conn.execute(
        "UPDATE plans SET state = 'approved', funding = %s, total_budget_usdc_units = %s,"
        " approved_at = now(), updated_at = now() WHERE plan_uuid = %s AND state = 'draft'",
        (funding, total_budget_usdc_units, plan_uuid),
    )


async def count_recent_attempts(conn: AsyncConnection[TupleRow], requester: str) -> int:
    cur = await conn.execute(
        "SELECT count(*) FROM planning_attempts WHERE requester = %s AND at > now() - interval '1 hour'",
        (requester,),
    )
    row = await cur.fetchone()
    return int(row[0]) if row else 0


def view(plan: StoredPlan) -> dict[str, Any]:
    """The plan as the API returns it. Amounts are decimal strings (USDC base units), never numbers."""
    return {
        "plan_uuid": plan.plan_uuid,
        "plan_id": plan.plan_id,
        "requester": plan.requester,
        "state": plan.state,
        "goal": plan.goal,
        "repo_url": plan.repo_url,
        "ref": plan.ref,
        "category": plan.category,
        "budget_usdc_units": str(plan.budget_usdc_units),
        "funding": plan.funding,
        "total_budget_usdc_units": None
        if plan.total_budget_usdc_units is None
        else str(plan.total_budget_usdc_units),
        "created_at": plan.created_at.isoformat(),
        "approved_at": None if plan.approved_at is None else plan.approved_at.isoformat(),
        "tasks": [
            {
                "index": t.draft.index,
                "title": t.draft.title,
                "instructions": t.draft.instructions,
                "phi": t.draft.phi,
                "phi_hash": t.phi_hash,
                "budget_usdc_units": str(t.draft.budget_usdc_units),
                "depends_on": t.draft.depends_on,
                "agents": t.agents,
            }
            for t in plan.tasks
        ],
    }


def phi_json(phi: dict[str, Any]) -> str:
    """Φ as the JSON string the binding hashes. The binding canonicalises (RFC 8785) before hashing."""
    return json.dumps(phi)
