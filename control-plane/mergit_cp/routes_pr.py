"""Pull-request gate routes (plan task O9).

    GET  /v0/plans/{plan_uuid}/diff     the final diff, so the requester can review it
    POST /v0/plans/{plan_uuid}/open-pr  the requester's approval; queues the PR for the worker
    GET  /v0/plans/{plan_uuid}/pr       status, branch, commit SHA, PR number and URL

The API never holds a GitHub token. Approval only records a `pr_requests` row; the worker, which has the
token, opens the PR. `build_router` takes the session and store dependencies so the app (plan task O1)
wires in its own and tests wire in theirs.
"""

# No `from __future__ import annotations` here: FastAPI resolves the Annotated dependencies of the
# nested route functions at runtime, and they close over `get_requester` and `get_store`.
import hashlib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import Annotated, Any, Protocol

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from .pr_gate import PlanInfo, TaskChange, blockers, combined_diff, same_address
from .pr_store import PrRequest


class PrStoreLike(Protocol):
    def plan(self, plan_uuid: str) -> PlanInfo | None: ...
    def changes(self, plan_uuid: str) -> list[TaskChange]: ...
    def request(self, plan_uuid: str) -> PrRequest | None: ...
    def approve(self, plan_uuid: str, requested_by: str) -> PrRequest: ...


class ApprovalGate(Protocol):
    """A fresh World ID human approval, required before `open_pr` may queue a PR request (plan sec 1.7),
    bound to the exact diff about to be opened (`action_hash` fields `plan_uuid`, `diff_sha256` -- plan
    sec 1.6). Raises an `HTTPException` (428 `human_approval_required` with nothing usable yet, or 403
    `human_approval_invalid` for a denied/failed/expired/mismatched/used one); returns normally only once
    an approval matching this exact action has been consumed, clearing the way for `store.approve`."""

    async def __call__(
        self,
        request: Request,
        *,
        plan_uuid: str,
        requester: str,
        diff_sha256: str,
        approval_id: str | None,
    ) -> None: ...


def _no_owned() -> None:
    return None


def store_of_app(request: Request) -> PrStoreLike:
    """The store the API created at start-up (`app.state.pr_store`)."""
    store: PrStoreLike = request.app.state.pr_store
    return store


def build_router(
    get_requester: Callable[..., str | Awaitable[str]],
    get_store: Callable[..., PrStoreLike],
    get_owned: Callable[..., list[str] | Awaitable[list[str] | None] | None] = _no_owned,
    approval_gate: ApprovalGate | None = None,
) -> APIRouter:
    """`get_requester` returns the signed-in wallet address or raises 401; `get_store` returns the store.

    An account can own several addresses (its trial address, every wallet it has linked), and a plan's
    requester is whichever one it was drafted under. `get_owned` returns all of them, lowercase; without it
    only the signed-in address owns a plan.

    `approval_gate`, when set (World Agent Pass is configured), is consulted by `open_pr` before a PR
    request may be queued; `None` (the default) leaves `open_pr` exactly as it behaved before this gate
    existed -- every existing caller with no gate configured sees identical behavior.
    """
    router = APIRouter(prefix="/v0/plans", tags=["pull-request"])

    def own_plan(
        store: PrStoreLike, plan_uuid: str, requester: str, owned: list[str] | None = None
    ) -> PlanInfo:
        try:
            plan_uuid = str(uuid.UUID(plan_uuid))
        except ValueError:
            raise HTTPException(404, "plan not found") from None
        plan = store.plan(plan_uuid)
        if plan is None:
            raise HTTPException(404, "plan not found")
        mine = (
            plan.requester.lower() in owned if owned is not None else same_address(plan.requester, requester)
        )
        if not mine:
            raise HTTPException(403, "only the requester of this plan may do that")
        return plan

    def ready_changes(store: PrStoreLike, plan: PlanInfo) -> list[TaskChange]:
        changes = store.changes(plan.plan_uuid)
        problems = blockers(plan, changes)
        if problems:
            raise HTTPException(
                409, {"message": "the plan is not ready for a pull request", "blockers": problems}
            )
        return changes

    async def own_plan_async(
        store: PrStoreLike, plan_uuid: str, requester: str, owned: list[str] | None = None
    ) -> PlanInfo:
        """Same checks as `own_plan`, for the async `open_pr` route: `store.plan` is a sync call (the
        module docstring: a sync psycopg connection in production), so it runs off the event loop."""
        try:
            plan_uuid = str(uuid.UUID(plan_uuid))
        except ValueError:
            raise HTTPException(404, "plan not found") from None
        plan = await run_in_threadpool(store.plan, plan_uuid)
        if plan is None:
            raise HTTPException(404, "plan not found")
        mine = (
            plan.requester.lower() in owned if owned is not None else same_address(plan.requester, requester)
        )
        if not mine:
            raise HTTPException(403, "only the requester of this plan may do that")
        return plan

    async def ready_changes_async(store: PrStoreLike, plan: PlanInfo) -> list[TaskChange]:
        changes = await run_in_threadpool(store.changes, plan.plan_uuid)
        problems = blockers(plan, changes)
        if problems:
            raise HTTPException(
                409, {"message": "the plan is not ready for a pull request", "blockers": problems}
            )
        return changes

    @router.get("/{plan_uuid}/diff")
    def diff(
        plan_uuid: str,
        requester: Annotated[str, Depends(get_requester)],
        store: Annotated[PrStoreLike, Depends(get_store)],
        owned: Annotated[list[str] | None, Depends(get_owned)],
    ) -> dict[str, Any]:
        plan = own_plan(store, plan_uuid, requester, owned)
        changes = ready_changes(store, plan)
        return {
            "plan_uuid": plan.plan_uuid,
            "repo_url": plan.repo_url,
            "base_ref": plan.ref,
            "tasks": [{"index": c.index, "title": c.title, "task_id": c.task_id} for c in changes],
            "diff": combined_diff(changes),
        }

    @router.post("/{plan_uuid}/open-pr", status_code=202)
    async def open_pr(
        plan_uuid: str,
        http_request: Request,
        response: Response,
        requester: Annotated[str, Depends(get_requester)],
        store: Annotated[PrStoreLike, Depends(get_store)],
        owned: Annotated[list[str] | None, Depends(get_owned)],
        x_world_approval: Annotated[str | None, Header()] = None,
    ) -> dict[str, Any]:
        plan = await own_plan_async(store, plan_uuid, requester, owned)
        changes = await ready_changes_async(store, plan)

        existing = await run_in_threadpool(store.request, plan.plan_uuid)
        if existing is not None and existing.status == "done":
            response.status_code = 200  # already opened: the same answer, not a second PR, no gate call
            return asdict(existing)

        if approval_gate is not None:
            diff_sha256 = hashlib.sha256(combined_diff(changes).encode()).hexdigest()
            await approval_gate(
                http_request,
                plan_uuid=plan.plan_uuid,
                requester=requester,
                diff_sha256=diff_sha256,
                approval_id=x_world_approval,
            )

        pr_request = await run_in_threadpool(store.approve, plan.plan_uuid, requester.lower())
        if pr_request.status == "done":
            response.status_code = 200  # a concurrent caller finished it first
        return asdict(pr_request)

    @router.get("/{plan_uuid}/pr")
    def pr_status(
        plan_uuid: str,
        requester: Annotated[str, Depends(get_requester)],
        store: Annotated[PrStoreLike, Depends(get_store)],
        owned: Annotated[list[str] | None, Depends(get_owned)],
    ) -> dict[str, Any]:
        plan = own_plan(store, plan_uuid, requester, owned)
        request = store.request(plan.plan_uuid)
        if request is None:
            raise HTTPException(404, "no pull request has been requested for this plan")
        return asdict(request)

    return router
