"""The control-plane API. ``create_app`` takes its settings, and optionally a model client, so tests and
hosts build it the same way."""

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from . import (
    accounts,
    auth,
    chain_events,
    health,
    oauth,
    otp,
    redeem,
    routes_account,
    routes_plans,
    routes_pr,
    routes_reputation,
    routes_routing,
    routes_runs,
    routes_world,
    wallet_interest,
)
from .config import Settings
from .db import migrate, open_pool
from .events import EventDeliverer
from .llm import LLM
from .outcomes import OutcomeProcessor
from .planner import PgCostSink
from .pr_store import PgPrStore
from .preflight import check_config, planner_llm
from .reputation import GatewayCosts, ReputationUpdater
from .stream import PlanBroadcaster
from .world import approvals

log = logging.getLogger(__name__)


def _pr_approval_gate(settings: Settings) -> routes_pr.ApprovalGate | None:
    """The `open_pr` sibling of `routes_plans.approve_plan`'s inline World gate (plan sec 1.7): `None`
    when Agent Pass is not configured, else a closure bound to `diff_sha256` instead of the plan-approval
    fields (`action_hash` kind `open_pr`, plan sec 1.6). `open_pr` is reached through the generic
    `routes_pr.build_router`, so -- unlike `approve_plan`, which already has a `Principal` from FastAPI's
    own dependency injection -- this closure resolves the signed-in user itself from the raw `Request`."""
    if not settings.world_idp_enabled:
        return None

    async def gate(
        request: Request,
        *,
        plan_uuid: str,
        requester: str,
        diff_sha256: str,
        approval_id: str | None,
    ) -> None:
        pool = request.app.state.pool
        # A throwaway `Response`: a live session's cookie may be slid forward here, but the route's own
        # `get_requester` dependency (`auth.current_address` -> `PrincipalDep`) already resolved and
        # possibly renewed the *real* response's cookie earlier in the same request.
        principal = await auth.current_principal(
            Response(), settings, pool, request.cookies.get(accounts.COOKIE)
        )
        if principal.user_id is None:
            raise HTTPException(status_code=401, detail="sign in again")
        if not principal.owns(requester):
            # The `requester` the route resolved (its own `get_requester` dependency) must be an address
            # this same signed-in session owns -- otherwise whoever is about to be redeemed-or-prompted for
            # an approval is not the account this request is actually authenticated as. Nothing observed
            # today makes these diverge (both derive from the same session cookie), but the Protocol takes
            # `requester` as an explicit input precisely so a future caller (e.g. an agent-token path) can't
            # silently skip this check by construction.
            raise HTTPException(status_code=403, detail="only the requester of this plan may do that")

        store: routes_pr.PrStoreLike = request.app.state.pr_store
        plan = await run_in_threadpool(store.plan, plan_uuid)
        repo_url = plan.repo_url if plan is not None else None

        plan_uuid_obj = UUID(plan_uuid)
        # Binds plan_uuid *and* the exact diff: a changed task patch after the approval was minted
        # recomputes to a different hash, which is what makes `consume` refuse it (action_mismatch).
        action_fields: dict[str, Any] = {"plan_uuid": plan_uuid, "diff_sha256": diff_sha256}

        needs_fresh_approval = approval_id is None
        if not needs_fresh_approval:
            assert approval_id is not None
            try:
                approval_uuid = UUID(approval_id)
            except ValueError:
                # Not even a UUID: as unusable as a header naming an approval that does not exist.
                needs_fresh_approval = True
            else:
                async with pool.connection() as conn, conn.transaction():
                    try:
                        await approvals.consume(
                            conn,
                            approval_uuid,
                            user_id=principal.user_id,
                            kind="open_pr",
                            plan_uuid=plan_uuid_obj,
                            fields=action_fields,
                            now=datetime.now(UTC),
                        )
                        return  # consumed: the route may now call store.approve
                    except approvals.ApprovalInvalid as invalid:
                        if invalid.reason != "unknown":
                            raise HTTPException(
                                status_code=403,
                                detail={"code": "human_approval_invalid", "reason": invalid.reason},
                            ) from invalid
                        # The header named an approval that does not exist at all (plan sec 1.7): the same
                        # 428 retry path as no header, not a 403 -- an approval that exists but belongs to
                        # someone else, or is in the wrong state, still 403s above.
                        needs_fresh_approval = True

        assert needs_fresh_approval
        summary = {"plan_uuid": plan_uuid, "repo_url": repo_url, "diff_sha256": diff_sha256}
        # `create_approval` opens its own pool connection; called only once the connection above (if any)
        # has closed, so a header-less open-pr never holds two connections from the same pool at once.
        pending = await approvals.create_approval(
            pool,
            settings,
            user_id=principal.user_id,
            kind="open_pr",
            plan_uuid=plan_uuid_obj,
            fields=action_fields,
            summary=summary,
        )
        raise pending.required_error()

    return gate


def create_app(
    settings: Settings | None = None,
    *,
    llm: LLM | None = None,
    deliver_events: bool = True,
    process_outcomes: bool = True,
    update_reputation: bool = True,
    mailer: otp.Mailer | None = None,
) -> FastAPI:
    """``deliver_events=False`` leaves events in the outbox, and ``process_outcomes=False`` leaves
    finished jobs unprocessed, for tests that want to inspect or drive that state directly."""
    settings = settings or Settings()  # pyright: ignore[reportCallIssue]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        # Fail at start, not on the first request, when configuration is wrong. The deploy runs the same
        # checks first (mergit_cp/preflight.py), before it swaps the running container.
        checked = check_config(settings)
        app.state.agents, prices = checked.agents, checked.prices
        if checked.stale:
            log.warning("no longer read, remove from the env file: %s", ", ".join(checked.stale))
        pool = await open_pool(settings.database_url, settings.db_pool_max)
        async with pool.connection() as conn:
            await migrate(conn)
        app.state.pool = pool
        # The pull-request routes share the worker's queue table; the API holds no GitHub token (see README).
        app.state.pr_store = PgPrStore.connect(settings.database_url, "api")
        app.state.llm = llm or planner_llm(settings)
        app.state.costs = PgCostSink(pool, prices)
        app.state.broadcaster = PlanBroadcaster()
        app.state.mailer = mailer or (otp.SmtpMailer(settings) if settings.email_enabled else None)

        stop = asyncio.Event()
        deliverer = EventDeliverer(
            pool,
            settings.gateway_url,
            settings.events_token.get_secret_value(),
            timeout_s=settings.event_timeout_s,
        )
        sender = asyncio.create_task(deliverer.run(settings.event_poll_s, stop)) if deliver_events else None
        processor = OutcomeProcessor(pool, settings)
        outcomes_task = (
            asyncio.create_task(processor.run(settings.outcome_poll_s, stop)) if process_outcomes else None
        )
        costs = GatewayCosts(settings.gateway_url, timeout_s=settings.event_timeout_s)
        updater = ReputationUpdater(pool, settings, costs)
        reputation_task = (
            asyncio.create_task(updater.run(settings.reputation_poll_s, stop)) if update_reputation else None
        )
        try:
            yield
        finally:
            stop.set()
            for task in (sender, outcomes_task, reputation_task):
                if task is not None:
                    with suppress(asyncio.CancelledError):
                        await task
            await deliverer.aclose()
            await costs.aclose()
            app.state.pr_store.close()
            await pool.close()

    app = FastAPI(title="Mergit control plane", version="0", lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Content-Type", "Idempotency-Key", "X-World-Approval"],
        expose_headers=["Retry-After"],  # the app says how long to wait after a 429 (redeem codes)
    )
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(auth.account_router)
    app.include_router(routes_account.router)
    app.include_router(redeem.router)
    app.include_router(oauth.router)
    app.include_router(routes_world.router)
    app.include_router(otp.router)
    app.include_router(wallet_interest.router)
    app.include_router(routes_plans.router)
    app.include_router(
        routes_pr.build_router(
            auth.current_address,
            routes_pr.store_of_app,
            auth.owned_addresses_dep,
            _pr_approval_gate(settings),
        )
    )
    app.include_router(chain_events.router)
    app.include_router(routes_runs.router)
    app.include_router(routes_runs.agents_router)
    app.include_router(routes_reputation.router)
    app.include_router(routes_routing.router)
    app.include_router(routes_runs.internal_router)
    return app
