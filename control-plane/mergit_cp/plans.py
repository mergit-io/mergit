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
    routing: str
    """``'pick'`` (the requester's own agent list, the default for every row written before Task 6's
    migration) or ``'auto'`` (routed by ``mergit_cp/routing.py::route`` at dispatch time)."""
    explore: bool
    retry_tolerant: bool
    """Per-task knobs into ``mergit_cp.router.Mode`` (paper 9.3-9.4), read by ``routing.route``. Irrelevant
    for a ``'pick'``-routing task, but always set (the column is ``NOT NULL``)."""


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
) -> None:
    await conn.execute(
        "INSERT INTO plans (plan_uuid, plan_id, requester, goal, repo_url, ref, category,"
        " budget_usdc_units, planner_model) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (plan_uuid, plan_id, requester, goal, repo_url, ref, category, budget_usdc_units, planner_model),
    )
    await _insert_tasks(conn, plan_uuid, tasks)


async def _insert_tasks(conn: AsyncConnection[TupleRow], plan_uuid: str, tasks: list[TaskDraft]) -> None:
    for t in tasks:
        await conn.execute(
            'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, budget_usdc_units, depends_on)'
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (plan_uuid, t.index, t.title, t.instructions, Jsonb(t.phi), t.budget_usdc_units, t.depends_on),
        )


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
            routing=t["routing"],
            explore=t["explore"],
            retry_tolerant=t["retry_tolerant"],
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
    picks: dict[int, list[str] | None],
    phi_hashes: dict[int, str],
    routing: dict[int, tuple[str, bool, bool]],
    funding: str,
    total_budget_usdc_units: int,
) -> None:
    """``picks[index]`` is ``None`` for an auto-routed index (``tasks.agents`` is written ``NULL``) or the
    requester's ordered agent list otherwise. ``routing`` maps every index -- both ``'pick'`` and ``'auto'``
    ones -- to ``(routing, explore, retry_tolerant)``, so the ``UPDATE`` below always sets all three
    columns consistently rather than leaving two of them at their migration defaults for a pick-mode task."""
    for index, agents in picks.items():
        routing_value, explore, retry_tolerant = routing[index]
        await conn.execute(
            "UPDATE tasks SET agents = %s, phi_hash = %s, routing = %s, explore = %s, retry_tolerant = %s"
            ' WHERE plan_uuid = %s AND "index" = %s',
            (agents, phi_hashes[index], routing_value, explore, retry_tolerant, plan_uuid, index),
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
                "routing": t.routing,
                "explore": t.explore,
                "retry_tolerant": t.retry_tolerant,
            }
            for t in plan.tasks
        ],
    }


def phi_json(phi: dict[str, Any]) -> str:
    """Φ as the JSON string the binding hashes. The binding canonicalises (RFC 8785) before hashing."""
    return json.dumps(phi)
