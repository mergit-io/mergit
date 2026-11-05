"""The control-plane API. ``create_app`` takes its settings, and optionally a model client, so tests and
hosts build it the same way."""

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import (
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
    wallet_interest,
)
from .arkiv_mirror import ArkivMirror
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

log = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    llm: LLM | None = None,
    deliver_events: bool = True,
    process_outcomes: bool = True,
    update_reputation: bool = True,
    mailer: otp.Mailer | None = None,
    arkiv: ArkivMirror | None = None,
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
        app.state.arkiv = arkiv or (
            ArkivMirror(
                settings.arkiv_rpc_url,  # type: ignore[arg-type]  # non-None: arkiv_enabled checked it
                settings.arkiv_access_key.get_secret_value() if settings.arkiv_access_key else None,
                settings.arkiv_owner_address,  # type: ignore[arg-type]  # non-None: arkiv_enabled checked it
                settings.arkiv_sidecar_url,
                settings.arkiv_sidecar_token.get_secret_value() if settings.arkiv_sidecar_token else None,
                settings.arkiv_entity_ttl_days,
            )
            if settings.arkiv_enabled
            else None
        )

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
            if app.state.arkiv is not None:
                await app.state.arkiv.aclose()
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
        allow_headers=["Content-Type", "Idempotency-Key"],
        expose_headers=["Retry-After"],  # the app says how long to wait after a 429 (redeem codes)
    )
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(auth.account_router)
    app.include_router(routes_account.router)
    app.include_router(redeem.router)
    app.include_router(oauth.router)
    app.include_router(otp.router)
    app.include_router(wallet_interest.router)
    app.include_router(routes_plans.router)
    app.include_router(
        routes_pr.build_router(auth.current_address, routes_pr.store_of_app, auth.owned_addresses_dep)
    )
    app.include_router(chain_events.router)
    app.include_router(routes_runs.router)
    app.include_router(routes_runs.agents_router)
    app.include_router(routes_reputation.router)
    app.include_router(routes_routing.router)
    app.include_router(routes_runs.internal_router)
    return app
