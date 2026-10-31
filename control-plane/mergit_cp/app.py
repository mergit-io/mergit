"""The control-plane API. ``create_app`` takes its settings, and optionally a model client, so tests and
hosts build it the same way."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mergit_worker.meter import PriceTable

from . import auth, chain_events, oauth, otp, redeem, routes_plans, routes_runs, wallet_interest
from .agents import load_agents
from .config import Settings
from .db import migrate, open_pool
from .events import EventDeliverer
from .llm import LLM, build_llm
from .outcomes import OutcomeProcessor
from .planner import PgCostSink
from .spec import require_schemas
from .stream import PlanBroadcaster


def create_app(
    settings: Settings | None = None,
    *,
    llm: LLM | None = None,
    deliver_events: bool = True,
    process_outcomes: bool = True,
    mailer: otp.Mailer | None = None,
) -> FastAPI:
    """``deliver_events=False`` leaves events in the outbox, and ``process_outcomes=False`` leaves
    finished jobs unprocessed, for tests that want to inspect or drive that state directly."""
    settings = settings or Settings()  # pyright: ignore[reportCallIssue]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        # Fail at start, not on the first request, when configuration is wrong.
        app.state.agents = load_agents(settings.agents_file, settings.agents_config)
        require_schemas()  # the plan checks and events are validated against spec/schemas
        prices = PriceTable.load(Path(settings.prices_file))
        prices.model_call_cost(settings.planner_model, 0, 0, 0)  # the planner model must have a price
        pool = await open_pool(settings.database_url, settings.db_pool_max)
        async with pool.connection() as conn:
            await migrate(conn)
        app.state.pool = pool
        app.state.llm = llm or build_llm()
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
        try:
            yield
        finally:
            stop.set()
            for task in (sender, outcomes_task):
                if task is not None:
                    with suppress(asyncio.CancelledError):
                        await task
            await deliverer.aclose()
            await pool.close()

    app = FastAPI(title="Mergit control plane", version="0", lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type"],
        expose_headers=["Retry-After"],  # the app says how long to wait after a 429 (redeem codes)
    )
    app.include_router(auth.router)
    app.include_router(auth.account_router)
    app.include_router(redeem.router)
    app.include_router(oauth.router)
    app.include_router(otp.router)
    app.include_router(wallet_interest.router)
    app.include_router(routes_plans.router)
    app.include_router(chain_events.router)
    app.include_router(routes_runs.router)
    app.include_router(routes_runs.agents_router)
    app.include_router(routes_runs.internal_router)
    return app
