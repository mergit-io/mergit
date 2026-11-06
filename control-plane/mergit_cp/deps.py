"""Request-scoped access to the process-wide settings, database pool, and Arkiv mirror."""

from typing import Annotated, cast

from fastapi import Depends, Request

from .arkiv_mirror import ArkivMirror
from .config import Settings
from .db import Pool


def get_settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def get_pool(request: Request) -> Pool:
    return cast(Pool, request.app.state.pool)


def get_arkiv(request: Request) -> ArkivMirror | None:
    """``None`` when `Settings.arkiv_enabled` is false (no RPC/key configured)."""
    return cast("ArkivMirror | None", request.app.state.arkiv)


ArkivDep = Annotated[ArkivMirror | None, Depends(get_arkiv)]
