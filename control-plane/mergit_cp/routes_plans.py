"""Plan routes (plan task O3): draft a plan from a goal, edit it, approve it.

Only the signed-in requester who drafted a plan may edit or approve it, and only while it is a draft.
Approval fixes the agent picks and each task's ``phi_hash``, and writes ``plan.approved`` to the outbox
in the same transaction. Inputs that would waste a planner call are rejected before the model is called.
"""

import logging
import re
import uuid
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

import mergit_receipt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from . import accounts, outcomes, plans, redeem, user_settings
from .agents import Agent
from .auth import PoolDep, Principal, PrincipalDep, SettingsDep
from .events import enqueue
from .llm import LLM, LLMUnavailable
from .planner import CostSink, PlanningFailed, TaskDraft, check_tasks, plan_goal

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v0/plans", tags=["plans"])

# A positive amount of USDC base units as a decimal string, small enough for a Postgres bigint.
Units = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]{0,17}$")]
_REF = re.compile(r"^(?![-/.])(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]{1,200}(?<![/.])$")
_REPO_PATH = re.compile(r"^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?(\.git)?/?$")


class CreatePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(min_length=1)
    repo_url: str
    ref: str
    budget_usdc_units: Units
    category: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]


class EditTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str
    instructions: str
    phi: dict[str, Any]
    budget_usdc_units: Units
    depends_on: list[int]


class EditPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tasks: list[EditTask]


class ApprovePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agents: dict[str, list[str]]
    """Per task index: the agent ids the requester allows, in order. The first runs; the rest are retries."""
    funding: Literal["wallet", "credits"]


def _problems(status: int, problems: list[str]) -> HTTPException:
    return HTTPException(status_code=status, detail={"problems": problems})


def _check_repo(url: str, hosts: list[str]) -> list[str]:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in hosts:
        return [f"repo_url must be an https URL on {', '.join(hosts)}"]
    if parts.username or parts.password or parts.query or parts.fragment or parts.port:
        return ["repo_url must not carry credentials, a port, a query or a fragment"]
    if not _REPO_PATH.match(parts.path):
        return ["repo_url must name one repository: https://<host>/<owner>/<repo>"]
    return []


def get_llm(request: Request) -> LLM:
    return request.app.state.llm


def get_costs(request: Request) -> CostSink:
    return request.app.state.costs


def get_agents(request: Request) -> list[Agent]:
    return request.app.state.agents


async def _owned_draft(conn: Any, plan_uuid: UUID, principal: Principal) -> plans.StoredPlan:
    plan = await plans.load(conn, plan_uuid, for_update=True)
    if plan is None:
        raise HTTPException(status_code=404, detail="no such plan")
    if not principal.owns(plan.requester):
        raise HTTPException(status_code=403, detail="only the requester may change this plan")
    if plan.state != "draft":
        raise HTTPException(status_code=409, detail=f"the plan is {plan.state}; only a draft can change")
    return plan


@router.post("", status_code=201)
async def create_plan(
    body: CreatePlan,
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    llm: Annotated[LLM, Depends(get_llm)],
    costs: Annotated[CostSink, Depends(get_costs)],
) -> dict[str, Any]:
    problems = _check_repo(body.repo_url, settings.repo_hosts)
    if not _REF.match(body.ref):
        problems.append("ref must be a branch, tag or commit name")
    if len(body.goal) > settings.goal_max_chars:
        problems.append(f"goal is longer than {settings.goal_max_chars} characters")
    if not body.goal.strip():
        problems.append("goal is empty")
    if problems:
        raise _problems(422, problems)

    address = principal.address
    async with pool.connection() as conn, conn.transaction():
        if principal.user_id is not None and address == accounts.trial_address(principal.user_id):
            profile = await accounts.load_profile(conn, principal.user_id)
            if profile.trial_started_at is None:
                raise HTTPException(
                    status_code=403,
                    detail="start the free trial, or connect a wallet, before drafting a plan",
                )
        # One lock per requester, so two concurrent requests cannot both pass the limit.
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (address,))
        if await plans.count_recent_attempts(conn, address) >= settings.plans_per_hour:
            raise HTTPException(status_code=429, detail="too many plans this hour; try again later")
        await conn.execute("INSERT INTO planning_attempts (requester) VALUES (%s)", (address,))

    model = settings.planner_model
    if principal.user_id is not None:
        async with pool.connection() as conn:
            chosen = (await user_settings.load(conn, principal.user_id)).planner_model
        if (
            chosen in settings.model_choices
        ):  # a model the operator has since withdrawn falls back to the default
            model = chosen
    budget = int(body.budget_usdc_units)
    try:
        draft = await plan_goal(
            body.goal,
            body.repo_url,
            budget,
            body.category,
            llm,
            model=model,
            costs=costs,
            max_tasks=settings.planner_max_tasks,
        )
    except PlanningFailed as failed:
        raise _problems(422, failed.problems) from failed
    except LLMUnavailable as down:
        # The client sees only "unavailable"; the provider's reason (a rejected request, a missing key) is
        # what an operator needs, so it goes to the log. It is the provider's reply, never our key.
        log.warning("planner model unavailable: %s", down)
        raise HTTPException(status_code=502, detail="the planner model is unavailable") from down

    async with pool.connection() as conn, conn.transaction():
        await plans.insert_draft(
            conn,
            plan_uuid=draft.plan_uuid,
            plan_id=mergit_receipt.plan_id(draft.plan_uuid),
            requester=address,
            goal=body.goal,
            repo_url=body.repo_url,
            ref=body.ref,
            category=body.category,
            budget_usdc_units=budget,
            planner_model=model,
            tasks=draft.tasks,
        )
        stored = await plans.load(conn, uuid.UUID(draft.plan_uuid))
    assert stored is not None
    return plans.view(stored)


@router.patch("/{plan_uuid}")
async def edit_plan(
    plan_uuid: UUID, body: EditPlan, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> dict[str, Any]:
    tasks = [
        TaskDraft(i, t.title.strip(), t.instructions.strip(), t.phi, int(t.budget_usdc_units), t.depends_on)
        for i, t in enumerate(body.tasks)
    ]
    async with pool.connection() as conn, conn.transaction():
        plan = await _owned_draft(conn, plan_uuid, principal)
        problems = check_tasks(tasks, plan.budget_usdc_units, settings.planner_max_tasks)
        if problems:
            raise _problems(422, problems)
        await plans.replace_tasks(conn, plan.plan_uuid, tasks)
        stored = await plans.load(conn, plan_uuid)
    assert stored is not None
    return plans.view(stored)


@router.post("/{plan_uuid}/approve")
async def approve_plan(
    plan_uuid: UUID,
    body: ApprovePlan,
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    agents: Annotated[list[Agent], Depends(get_agents)],
) -> dict[str, str]:
    known = {a.agent_id for a in agents}
    # Read before the transaction opens, so a slow gateway holds no row lock. None: unreachable, and the
    # gateway then enforces its limits alone, as it did before this look-ahead.
    credit_view = (
        await redeem.fetch_credits(settings, principal.user_id)
        if body.funding == "credits" and principal.user_id is not None
        else None
    )
    async with pool.connection() as conn, conn.transaction():
        plan = await _owned_draft(conn, plan_uuid, principal)
        drafts = [t.draft for t in plan.tasks]

        problems = check_tasks(drafts, plan.budget_usdc_units, settings.planner_max_tasks)
        expected = {str(t.index) for t in drafts}
        if set(body.agents) != expected:
            problems.append(f"agents must name every task index exactly once: {sorted(expected, key=int)}")
        for index, picked in sorted(body.agents.items()):
            if not 1 <= len(picked) <= settings.max_attempts:
                problems.append(f"task {index}: pick between 1 and {settings.max_attempts} agents")
            if len(set(picked)) != len(picked):
                problems.append(f"task {index}: an agent is listed twice")
            problems.extend(f"task {index}: unknown agent {a!r}" for a in picked if a not in known)
        if (
            principal.user_id is not None
            and plan.requester in await accounts.trial_addresses(conn, principal.user_id)
            and body.funding != "credits"
        ):
            problems.append("a plan drafted on the free trial can only be funded from credits")
        total = sum(t.budget_usdc_units for t in drafts)
        if credit_view is not None:
            problems.extend(redeem.credit_problems(credit_view, total))
        if principal.user_id is not None:
            prefs = await user_settings.load(conn, principal.user_id)
            problems.extend(
                await user_settings.cap_problems(
                    conn, prefs, principal.owned, total, plan_uuid=plan.plan_uuid
                )
            )
        if problems:
            raise _problems(422, problems)
        if (
            body.funding == "credits"
            and principal.user_id is not None
            and await accounts.credits_forfeited(conn, settings, principal.user_id)
        ):
            raise HTTPException(status_code=403, detail="the free credits were already used by this person")

        await plans.approve(
            conn,
            plan.plan_uuid,
            picks={int(i): picked for i, picked in body.agents.items()},
            phi_hashes={t.index: mergit_receipt.phi_hash(plans.phi_json(t.phi)) for t in drafts},
            funding=body.funding,
            total_budget_usdc_units=total,
        )
        payload = {
            "plan_id": plan.plan_id,
            "plan_uuid": plan.plan_uuid,
            "requester": plan.requester,
            "total_budget_usdc_units": str(total),
            "funding": body.funding,
        }
        if body.funding == "credits" and principal.user_id is not None:
            # The free credits belong to the account, not to whichever address requests: one grant per person,
            # however many wallets they link. (A session from before accounts has none, and the gateway then
            # falls back to the requester address.)
            payload["credit_account"] = str(principal.user_id)
        await enqueue(
            conn,
            "plan.approved",
            payload,
            plan_id=plan.plan_id,
            retry_window_s=settings.event_retry_window_s,
        )
    return {"plan_id": plan.plan_id, "total_budget_usdc_units": str(total)}


@router.post("/{plan_uuid}/abandon")
async def abandon_plan(
    plan_uuid: UUID, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> dict[str, str]:
    """The requester gives up on this plan (plan task O6): a stuck ``needs_requester`` index is the
    expected reason, but nothing here requires that; any plan past ``draft`` may be abandoned."""
    async with pool.connection() as conn, conn.transaction():
        plan = await plans.load(conn, plan_uuid, for_update=True)
        if plan is None:
            raise HTTPException(status_code=404, detail="no such plan")
        if not principal.owns(plan.requester):
            raise HTTPException(status_code=403, detail="only the requester may abandon this plan")
        if plan.state == "draft":
            raise HTTPException(status_code=409, detail="a draft plan has nothing to abandon")
        if plan.state in ("closed", "done"):
            raise HTTPException(status_code=409, detail=f"the plan is already {plan.state}")
        await outcomes.abandon(conn, plan, settings)
    return {"plan_id": plan.plan_id, "state": "closed"}
