"""``GET /healthz``: is this API able to serve, i.e. is its database reachable?

Used by the compose healthcheck and by deploy/server/update.sh. It is deliberately public and says nothing
beyond ok or not ok: no version, no settings, no error text.
"""

import asyncio
import logging
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .db import Pool
from .deps import get_pool

log = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Under a proxy's own health timeout, so a stuck database answers 503 instead of hanging the check.
DB_CHECK_TIMEOUT_S = 3.0
# The route is public and unauthenticated: a flood must not become a flood of pool checkouts. One probe at a
# time is shared by every concurrent request, and its answer (ok or not) is reused for this long.
CACHE_TTL_S = 2.0


def _now() -> float:
    return time.monotonic()


async def _database_answers(pool: Pool) -> None:
    async with pool.connection() as conn:
        await conn.execute("SELECT 1")


class _Probe:
    """The last database check and the one check that may be in flight."""

    def __init__(self) -> None:
        self.ok = False
        self.at: float | None = None
        self.task: asyncio.Task[bool] | None = None

    async def _run(self, pool: Pool) -> bool:
        try:
            await asyncio.wait_for(_database_answers(pool), DB_CHECK_TIMEOUT_S)
            ok = True
        except Exception as exc:  # any failure, including a timeout or an exhausted pool, means "not healthy"
            # One line, no traceback: a flood of failures must not become a flood of stack traces in the log.
            log.warning("healthz: the database did not answer (%s)", type(exc).__name__)
            ok = False
        self.ok, self.at = ok, _now()
        return ok

    async def check(self, pool: Pool) -> bool:
        if self.at is not None and _now() - self.at < CACHE_TTL_S:
            return self.ok
        if self.task is None or self.task.done():
            self.task = asyncio.ensure_future(self._run(pool))
        return await asyncio.shield(self.task)


@router.get("/healthz", include_in_schema=False)
async def healthz(request: Request, pool: Annotated[Pool, Depends(get_pool)]) -> JSONResponse:
    probe: _Probe | None = getattr(request.app.state, "healthz_probe", None)
    if probe is None:
        probe = request.app.state.healthz_probe = _Probe()
    if await probe.check(pool):
        return JSONResponse({"ok": True})
    return JSONResponse({"ok": False}, status_code=503)
