"""Redeem codes and the account's credits (the free tier, decision of 2026-10-31).

Every account has 5 USDC of free credits, once, never renewed (the gateway's ledger, keyed by the account).
A redeem code is how someone is given more: a one-time code that adds its amount to the account that
redeems it.

A code is claimed with a single UPDATE and the credit is queued as a ``credits.grant`` event in the same
transaction, so a code is never used up without its credit being on its way, and never credited twice: the
gateway applies a grant once per ``ref``. Only a keyed hash of the code is stored. The event is retried for
days, not the minutes other events get, because a burned code whose grant is dropped would be money lost.
"""

import hashlib
import hmac
import math
import secrets
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .auth import PoolDep, PrincipalDep, SettingsDep
from .config import Settings
from .db import Pool
from .events import enqueue

router = APIRouter(prefix="/v0/account", tags=["account"])

# Crockford's base32: no I, L, O or U, so a code read aloud or copied by hand is hard to get wrong.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PREFIX = "MRG"
_BODY_LEN = 16  # 16 characters of 5 bits each: 80 bits
_LOOK_ALIKES = str.maketrans({"O": "0", "I": "1", "L": "1"})
GRANT_RETRY_WINDOW_S = 7 * 24 * 3600


def new_code() -> str:
    """``MRG-XXXX-XXXX-XXXX-XXXX``, 80 random bits."""
    body = "".join(secrets.choice(ALPHABET) for _ in range(_BODY_LEN))
    return "-".join([PREFIX, *(body[i : i + 4] for i in range(0, _BODY_LEN, 4))])


def normalise(raw: str) -> str | None:
    """The code as stored and hashed: upper case, no spaces or hyphens, O/I/L read as 0/1. None if it is not
    shaped like a code."""
    text = "".join(raw.split()).replace("-", "").upper().translate(_LOOK_ALIKES)
    if len(text) != len(PREFIX) + _BODY_LEN or not text.startswith(PREFIX):
        return None
    return text if set(text[len(PREFIX) :]) <= set(ALPHABET) else None


def code_hash(secret: bytes, normalised: str) -> bytes:
    """A keyed hash, so a copy of the table cannot be used to test guesses offline."""
    return hmac.new(secret, b"mergit.redeem.v0:" + normalised.encode(), hashlib.sha256).digest()


class RedeemError(Exception):
    """Base for the answers a person can get; each maps to one HTTP status."""


class InvalidCode(RedeemError):
    """Not a code, not one we issued, or revoked (which we do not distinguish from unknown)."""


class AlreadyRedeemed(RedeemError):
    pass


class Expired(RedeemError):
    pass


class TooManyAttempts(RedeemError):
    def __init__(self, retry_after_s: int) -> None:
        super().__init__(f"try again in {retry_after_s}s")
        self.retry_after_s = retry_after_s


async def _spend_an_attempt(pool: Pool, user_id: UUID, limit: int) -> None:
    """Counts this attempt against the account's hourly budget, in its own committed transaction, so a failed
    redemption still uses it up."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"redeem:{user_id}",))
        await conn.execute("DELETE FROM redeem_attempts WHERE at < now() - interval '1 day'")
        cur = await conn.execute(
            "SELECT count(*), extract(epoch FROM min(at) + interval '1 hour' - now())"
            " FROM redeem_attempts WHERE user_id = %s AND at > now() - interval '1 hour'",
            (user_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        used, wait = int(row[0]), row[1]
        if used >= limit:
            raise TooManyAttempts(max(1, math.ceil(float(wait or 1))))
        await conn.execute("INSERT INTO redeem_attempts (user_id) VALUES (%s)", (user_id,))


async def redeem(pool: Pool, settings: Settings, user_id: UUID, raw_code: str) -> int:
    """Claims the code for ``user_id`` and queues its credit. Returns the amount in USDC base units."""
    await _spend_an_attempt(pool, user_id, settings.redeem_attempts_per_hour)
    normalised = normalise(raw_code)
    if normalised is None:
        raise InvalidCode
    digest = code_hash(settings.session_secret.get_secret_value().encode(), normalised)
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "UPDATE redeem_codes SET redeemed_by = %s, redeemed_at = now()"
            " WHERE code_hash = %s AND redeemed_at IS NULL AND revoked_at IS NULL"
            " AND (expires_at IS NULL OR expires_at > now())"
            " RETURNING code_id, amount_usdc_units",
            (user_id, digest),
        )
        claimed = await cur.fetchone()
        if claimed is None:
            cur = await conn.execute(
                "SELECT redeemed_at IS NOT NULL, revoked_at IS NOT NULL,"
                " expires_at IS NOT NULL AND expires_at <= now() FROM redeem_codes WHERE code_hash = %s",
                (digest,),
            )
            why = await cur.fetchone()
            if why is None or why[1]:
                raise InvalidCode
            if why[0]:
                raise AlreadyRedeemed
            raise Expired
        code_id, amount = claimed[0], int(claimed[1])
        await enqueue(
            conn,
            "credits.grant",
            {"account": str(user_id), "amount_usdc_units": str(amount), "ref": f"redeem-{code_id}"},
            plan_id=None,
            retry_window_s=GRANT_RETRY_WINDOW_S,
        )
    return amount


def _member(principal: Any) -> UUID:
    if principal.user_id is None:
        raise HTTPException(status_code=401, detail="sign in again")  # a session from before accounts existed
    return principal.user_id


class RedeemBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, Field(min_length=1, max_length=64)]


@router.post("/redeem")
async def redeem_code(
    body: RedeemBody, principal: PrincipalDep, settings: SettingsDep, pool: PoolDep
) -> dict[str, str]:
    user_id = _member(principal)
    try:
        amount = await redeem(pool, settings, user_id, body.code)
    except TooManyAttempts as slow:
        raise HTTPException(
            status_code=429,
            detail={"error": "too_many_attempts"},
            headers={"Retry-After": str(slow.retry_after_s)},
        ) from slow
    except AlreadyRedeemed as used:
        raise HTTPException(status_code=409, detail={"error": "already_redeemed"}) from used
    except Expired as late:
        raise HTTPException(status_code=410, detail={"error": "expired"}) from late
    except InvalidCode as bad:
        raise HTTPException(status_code=400, detail={"error": "invalid_code"}) from bad
    return {"amount_usdc_units": str(amount)}


async def fetch_credits(settings: Settings, user_id: UUID) -> dict[str, Any] | None:
    """The gateway's view of one account's credits, or None when it cannot be read (down, or not a 200)."""
    url = f"{settings.gateway_url.rstrip('/')}/v0/credits/account/{user_id}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            response = await http.get(url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    return dict(response.json())


def _usdc(units: int) -> str:
    return f"{units / 1_000_000:.2f}".rstrip("0").rstrip(".")


def credit_problems(view: dict[str, Any], total: int) -> list[str]:
    """Why the gateway would deny a credits plan worth ``total`` units, from its own view of the account.

    Said before the plan is approved, so the plan stays a draft the person can still change. A view from a
    gateway that does not state its limits yet yields nothing: the gateway still decides when it takes the
    event."""
    problems: list[str] = []
    cap = view.get("plan_cap_usdc_units")
    if cap is not None and total > int(cap):
        problems.append(
            f"free credits cover up to {_usdc(int(cap))} USDC per plan; this plan is {_usdc(total)} USDC."
            " Lower the budget, or fund it from a wallet"
        )
    per_day = view.get("plans_per_day")
    if per_day is not None and int(view.get("plans_today", 0)) >= int(per_day):
        problems.append(f"you have used today's {per_day} free plans; they reset tomorrow")
    remaining = view.get("remaining_usdc_units")
    if remaining is not None and total > int(remaining):
        problems.append(
            f"only {_usdc(int(remaining))} USDC of free credits left; this plan is {_usdc(total)} USDC"
        )
    return problems


@router.get("/credits")
async def account_credits(principal: PrincipalDep, settings: SettingsDep) -> dict[str, Any]:
    """The signed-in account's credits: granted, spent, remaining (USDC base units), and the limits a plan
    must fit. The ledger is the gateway's; this asks it for this account only."""
    view = await fetch_credits(settings, _member(principal))
    if view is None:
        raise HTTPException(status_code=502, detail={"error": "credits_unavailable"})
    return view
