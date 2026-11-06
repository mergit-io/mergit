"""``GET /healthz``: is this API able to serve, i.e. is its database reachable?

Used by the compose healthcheck and by deploy/server/update.sh. It is deliberately public and says nothing
beyond ok or not ok: no version, no settings, no error text.

Being public, it must not be a way to load the database: the answer is cached for ``HEALTH_CACHE_S`` and only
one request at a time probes, so a flood of requests costs at most one ``SELECT 1`` (and one log line) per
window, and cannot exhaust the pool the real routes need.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .db import Pool
from .deps import get_pool

log = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Under a proxy's own health timeout, so a stuck database answers 503 instead of hanging the check.
DB_CHECK_TIMEOUT_S = 3.0
# How long one probe's answer is reused. Short enough that a deploy script or a proxy sees a change quickly.
HEALTH_CACHE_S = 2.0


@dataclass
class _Cache:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    ok: bool | None = None
    at: float = 0.0


async def _database_answers(pool: Pool) -> None:
    async with pool.connection() as conn:
        await conn.execute("SELECT 1")


async def _probe(pool: Pool) -> bool:
    try:
        await asyncio.wait_for(_database_answers(pool), DB_CHECK_TIMEOUT_S)
    except Exception as exc:  # any failure, including a timeout or an exhausted pool, means "not healthy"
        # The type only: a traceback per probe adds nothing a reader of the database's own log lacks.
        log.warning("healthz: the database did not answer (%s)", type(exc).__name__)
        return False
    return True


@router.get("/healthz", include_in_schema=False)
async def healthz(request: Request, pool: Annotated[Pool, Depends(get_pool)]) -> JSONResponse:
    cache: _Cache | None = getattr(request.app.state, "health_cache", None)
    if cache is None:
        cache = request.app.state.health_cache = _Cache()
    async with cache.lock:  # concurrent requests wait here and reuse the one probe's answer
        if cache.ok is None or time.monotonic() - cache.at >= HEALTH_CACHE_S:
            cache.ok = await _probe(pool)
            cache.at = time.monotonic()
        ok = cache.ok
    return JSONResponse({"ok": ok}, status_code=200 if ok else 503)
