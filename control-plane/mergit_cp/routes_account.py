"""Settings a signed-in user manages for their own account: name, preferences, sign-in methods, wallets,
other devices, and deleting the account. Every route acts on the caller's own user and nothing else."""

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Cookie, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import accounts, user_settings
from .accounts import COOKIE, token_hash
from .auth import PoolDep, PrincipalDep, SettingsDep

router = APIRouter(prefix="/v0/account", tags=["account"])

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _user(principal: PrincipalDep) -> Any:
    if principal.user_id is None:
        raise HTTPException(status_code=401, detail="sign in again")  # a session from before accounts existed
    return principal.user_id


class ProfileBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str

    @field_validator("name")
    @classmethod
    def _plain_name(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 80 or _CONTROL.search(value):
            raise ValueError("a name is 1 to 80 characters, with no control characters")
        return value


@router.patch("/profile")
async def update_profile(body: ProfileBody, principal: PrincipalDep, pool: PoolDep) -> dict[str, str]:
    user_id = _user(principal)
    async with pool.connection() as conn:
        await conn.execute("UPDATE users SET display_name = %s WHERE user_id = %s", (body.name, user_id))
    return {"name": body.name}


def _cap(value: str | None) -> str | None:
    if value is not None and (not value.isascii() or not value.isdigit() or int(value) <= 0):
        raise ValueError("an amount is a whole number of USDC units above zero")
    return value


class SettingsBody(BaseModel):
    """Only the fields sent change. ``null`` clears a model choice or a cap."""

    model_config = ConfigDict(extra="forbid")
    planner_model: str | None = None
    routing_mode: Literal["greedy", "explore"] = "greedy"
    max_attempts: int = Field(default=1, ge=1, le=3)
    default_funding: Literal["credits", "wallet"] = "credits"
    per_plan_cap_usdc_units: str | None = None
    daily_cap_usdc_units: str | None = None

    _caps = field_validator("per_plan_cap_usdc_units", "daily_cap_usdc_units")(_cap)


def _settings_view(prefs: user_settings.Preferences, settings: Any) -> dict[str, Any]:
    return {
        "preferences": prefs.view(),
        "planner_models": settings.model_choices,
        "default_planner_model": settings.planner_model,
    }


@router.get("/settings")
async def get_settings(principal: PrincipalDep, settings: SettingsDep, pool: PoolDep) -> dict[str, Any]:
    user_id = _user(principal)
    async with pool.connection() as conn:
        return _settings_view(await user_settings.load(conn, user_id), settings)


@router.put("/settings")
async def put_settings(
    body: SettingsBody, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> dict[str, Any]:
    user_id = _user(principal)
    if body.planner_model is not None and body.planner_model not in settings.model_choices:
        raise HTTPException(status_code=422, detail=f"planner_model must be one of {settings.model_choices}")
    changes: dict[str, object] = {}
    for name in body.model_fields_set:
        value = getattr(body, name)
        changes[name] = int(value) if name.endswith("_usdc_units") and value is not None else value
    async with pool.connection() as conn, conn.transaction():
        return _settings_view(await user_settings.save(conn, user_id, changes), settings)


@router.delete("/wallets/{address}", status_code=204)
async def remove_wallet(
    address: Annotated[str, Path(pattern=r"^0x[0-9a-fA-F]{40}$")], principal: PrincipalDep, pool: PoolDep
) -> None:
    user_id = _user(principal)
    try:
        async with pool.connection() as conn, conn.transaction():
            await accounts.unlink_wallet(conn, user_id, address.lower())
    except accounts.NotFound as missing:
        raise HTTPException(status_code=404, detail="that wallet is not on your account") from missing
    except accounts.LastMethod as last:
        raise HTTPException(
            status_code=409, detail="it is your only way to sign in; add another method first"
        ) from last
    except accounts.Busy as busy:
        raise HTTPException(
            status_code=409,
            detail="a plan on this wallet is approved, funded or running; wait for it to finish",
        ) from busy


@router.delete("/identities/{provider}", status_code=204)
async def remove_identity(
    provider: Literal["github", "google", "email"], principal: PrincipalDep, pool: PoolDep
) -> None:
    user_id = _user(principal)
    try:
        async with pool.connection() as conn, conn.transaction():
            await accounts.unlink_identity(conn, user_id, provider)
    except accounts.NotFound as missing:
        raise HTTPException(status_code=404, detail=f"{provider} is not on your account") from missing
    except accounts.LastMethod as last:
        raise HTTPException(
            status_code=409, detail="it is your only way to sign in; add another method first"
        ) from last


@router.get("/sessions")
async def list_sessions(
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    mergit_session: Annotated[str | None, Cookie()] = None,
) -> list[dict[str, Any]]:
    user_id = _user(principal)
    current = token_hash(settings, mergit_session or "")
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT created_at, expires_at, address, token_hash = %s FROM sessions"
            " WHERE user_id = %s AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC",
            (current, user_id),
        )
        return [
            {"created_at": r[0].isoformat(), "expires_at": r[1].isoformat(), "address": r[2], "current": r[3]}
            for r in await cur.fetchall()
        ]


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    mergit_session: Annotated[str | None, Cookie()] = None,
) -> dict[str, int]:
    user_id = _user(principal)
    async with pool.connection() as conn:
        cur = await conn.execute(
            "UPDATE sessions SET revoked_at = now() WHERE user_id = %s AND token_hash <> %s"
            " AND revoked_at IS NULL",
            (user_id, token_hash(settings, mergit_session or "")),
        )
        return {"revoked": cur.rowcount}


class DeleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str

    @field_validator("confirm")
    @classmethod
    def _typed_delete(cls, value: str) -> str:
        if value.strip().lower() != "delete":
            raise ValueError('type "delete" to confirm')
        return value


@router.delete("", status_code=204)
async def delete_account(
    body: DeleteBody, response: Response, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> None:
    """Deletes the account and signs every device out. See ``accounts.delete_account`` for what stays."""
    del body  # validated: it must say "delete"
    user_id = _user(principal)
    try:
        async with pool.connection() as conn, conn.transaction():
            await accounts.delete_account(conn, settings, user_id)
    except accounts.Busy as busy:
        raise HTTPException(
            status_code=409, detail="a plan is approved, funded or running; wait for it to finish first"
        ) from busy
    response.delete_cookie(
        COOKIE, path="/", domain=settings.cookie_domain, secure=True, httponly=True, samesite="lax"
    )
