"""``GET /healthz``: is this API able to serve, i.e. is its database reachable?

Used by the compose healthcheck and by deploy/server/update.sh. It is deliberately public and says nothing
beyond ok or not ok: no version, no settings, no error text.
"""

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from .db import Pool
from .deps import get_pool

log = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Under a proxy's own health timeout, so a stuck database answers 503 instead of hanging the check.
DB_CHECK_TIMEOUT_S = 3.0


async def _database_answers(pool: Pool) -> None:
    async with pool.connection() as conn:
        await conn.execute("SELECT 1")


@router.get("/healthz", include_in_schema=False)
async def healthz(pool: Annotated[Pool, Depends(get_pool)]) -> JSONResponse:
    try:
        await asyncio.wait_for(_database_answers(pool), DB_CHECK_TIMEOUT_S)
    except Exception:  # any failure, including a timeout or an exhausted pool, means "not healthy"
        log.warning("healthz: the database did not answer", exc_info=True)
        return JSONResponse({"ok": False}, status_code=503)
    return JSONResponse({"ok": True})
