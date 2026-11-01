"""Sign-In with Ethereum (EIP-4361), server-side sessions, and what a session knows about its user.

A session belongs to a user and acts as one requester address: the wallet that signed in, the wallet the
user connected later, or, for a user with no wallet, their trial address. Plans belong to an address, and a
user owns every address they hold, so a plan drafted before a wallet was connected stays theirs. Nonces are
single use and short lived; sessions live in Postgres so logout revokes them everywhere, not just in the
browser that logged out.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from siwe import SiweMessage, VerificationError, generate_nonce  # pyright: ignore[reportMissingTypeStubs]

from . import accounts
from .accounts import COOKIE, token_hash
from .config import Settings
from .db import Pool
from .deps import get_pool, get_settings

router = APIRouter(prefix="/v0/auth", tags=["auth"])
account_router = APIRouter(prefix="/v0/account", tags=["account"])

SettingsDep = Annotated[Settings, Depends(get_settings)]
PoolDep = Annotated[Pool, Depends(get_pool)]


class VerifyBody(BaseModel):
    message: str
    signature: str
    intent: accounts.Intent = "register"
    """`login` refuses a wallet nobody has registered; `register` creates the account on first use."""


def _token_hash(settings: Settings, token: str) -> bytes:
    return token_hash(settings, token)


def _unauthorized(reason: str) -> HTTPException:
    return HTTPException(status_code=401, detail=reason)


@router.get("/nonce")
async def nonce(settings: SettingsDep, pool: PoolDep) -> dict[str, str]:
    value = generate_nonce()
    expires = datetime.now(UTC) + timedelta(seconds=settings.nonce_ttl_s)
    async with pool.connection() as conn:
        await conn.execute("INSERT INTO auth_nonces (nonce, expires_at) VALUES (%s, %s)", (value, expires))
    return {"nonce": value}


def _checked_message(body: VerifyBody, settings: Settings) -> SiweMessage:
    try:
        message = SiweMessage.from_message(body.message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="malformed SIWE message") from exc

    if message.chain_id != settings.chain_id:
        raise _unauthorized("wrong chain")
    try:
        # The message's domain must be one of the site's hostnames, or it was signed for another site.
        # verify() then checks expiry, not-before and that the signature recovers to the address.
        if message.domain not in settings.sign_in_domains:
            raise _unauthorized("wrong domain")
        message.verify(body.signature, domain=message.domain)
    except VerificationError as exc:
        raise _unauthorized(type(exc).__name__) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # A signature that is not even well formed (wrong length, out-of-range values) makes the signature
        # library raise its own error types, not VerificationError. Failing to check one is never a session.
        raise _unauthorized("InvalidSignature") from exc
    return message


async def _consume_nonce(conn: Any, nonce: str) -> None:
    # Consuming the nonce is the last check and is atomic, so two requests racing on one nonce cannot
    # both get a session.
    cur = await conn.execute(
        "UPDATE auth_nonces SET used_at = now()"
        " WHERE nonce = %s AND used_at IS NULL AND expires_at > now() RETURNING nonce",
        (nonce,),
    )
    if await cur.fetchone() is None:
        raise _unauthorized("nonce unknown, used or expired")


@router.post("/verify")
async def verify(
    body: VerifyBody, response: Response, settings: SettingsDep, pool: PoolDep
) -> dict[str, str]:
    message = _checked_message(body, settings)
    address = message.address.lower()
    async with pool.connection() as conn, conn.transaction():
        await _consume_nonce(conn, message.nonce)
        if body.intent == "login" and not await accounts.wallet_exists(conn, address):
            raise HTTPException(status_code=404, detail="no_account")
        user_id = await accounts.user_for_wallet(conn, address)
        token = await accounts.create_session(conn, settings, user_id, address)
    accounts.set_session_cookie(response, settings, token)
    return {"address": address}


@dataclass(frozen=True, slots=True)
class Principal:
    """Who is calling: the address they act as, their user (None only for a session from before accounts
    existed), and every address whose plans are theirs."""

    address: str
    user_id: UUID | None
    owned: list[str]

    def owns(self, requester: str) -> bool:
        return requester in self.owned


async def _lookup(settings: Settings, pool: Pool, token: str | None) -> Principal | None:
    if not token:
        return None
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT address, user_id FROM sessions"
            " WHERE token_hash = %s AND revoked_at IS NULL AND expires_at > now()",
            (_token_hash(settings, token),),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        address, user_id = str(row[0]), row[1]
        return Principal(address, user_id, await accounts.owned_addresses(conn, user_id, address))


async def current_principal(
    settings: SettingsDep, pool: PoolDep, mergit_session: Annotated[str | None, Cookie()] = None
) -> Principal:
    """The signed-in caller. 401 when there is no live session."""
    if not mergit_session:
        raise _unauthorized("not signed in")
    principal = await _lookup(settings, pool, mergit_session)
    if principal is None:
        raise _unauthorized("session expired or revoked")
    return principal


async def optional_principal(
    settings: SettingsDep, pool: PoolDep, mergit_session: Annotated[str | None, Cookie()] = None
) -> Principal | None:
    """The signed-in caller, or None. Used where signing in again means linking to who is already in."""
    return await _lookup(settings, pool, mergit_session)


PrincipalDep = Annotated[Principal, Depends(current_principal)]
MaybePrincipalDep = Annotated[Principal | None, Depends(optional_principal)]


async def current_address(principal: PrincipalDep) -> str:
    """The address the caller acts as, lowercase. 401 when there is no live session."""
    return principal.address


AddressDep = Annotated[str, Depends(current_address)]


def _member(principal: Principal) -> UUID:
    if principal.user_id is None:
        raise _unauthorized("sign in again")  # a session from before accounts existed
    return principal.user_id


@router.get("/me")
async def me(principal: PrincipalDep, pool: PoolDep) -> dict[str, Any]:
    if principal.user_id is None:
        return {"address": principal.address, "user_id": None, "identities": [], "wallets": [], "trial": None}
    async with pool.connection() as conn:
        profile = await accounts.load_profile(conn, principal.user_id)
    return {
        "address": principal.address,
        "user_id": str(profile.user_id),
        "name": profile.name,
        "email": profile.email,
        "avatar_url": profile.avatar_url,
        "identities": [{"provider": p, "label": label} for p, label in profile.identities],
        "wallets": profile.wallets,
        "trial_address": accounts.trial_address(profile.user_id),
        "trial": ({"started_at": profile.trial_started_at.isoformat()} if profile.trial_started_at else None),
    }


@router.post("/wallet/link")
async def link_wallet(
    body: VerifyBody,
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    mergit_session: Annotated[str | None, Cookie()] = None,
) -> dict[str, str]:
    """The signed-in user proves they hold a wallet; from then on the session acts as that wallet.

    A wallet that already has its own account is answered with 409 and a one-time offer to merge that account
    into this one (``POST /v0/auth/merge``). The same person has proven both sides, but nothing moves until
    they confirm.
    """
    user_id = _member(principal)
    message = _checked_message(body, settings)
    address = message.address.lower()
    assert mergit_session
    offer: dict[str, object] | None = None
    async with pool.connection() as conn, conn.transaction():
        await _consume_nonce(conn, message.nonce)
        try:
            await accounts.link_wallet(conn, user_id, address)
        except accounts.WalletTaken as taken:
            offer = {
                "code": "wallet_taken",
                "merge_token": await accounts.offer_merge(conn, settings, user_id, taken.owner, address),
                "other": await accounts.merge_summary(conn, taken.owner),
            }
        else:
            await conn.execute(
                "UPDATE sessions SET address = %s WHERE token_hash = %s",
                (address, _token_hash(settings, mergit_session)),
            )
    if offer is not None:
        # Raised after the transaction commits, so the offer survives the refusal.
        raise HTTPException(status_code=409, detail=offer)
    return {"address": address}


class MergeBody(BaseModel):
    merge_token: Annotated[str, Field(min_length=20, max_length=200)]


@router.post("/merge")
async def merge_accounts(
    body: MergeBody,
    principal: PrincipalDep,
    settings: SettingsDep,
    pool: PoolDep,
    mergit_session: Annotated[str | None, Cookie()] = None,
) -> dict[str, str]:
    """Confirms a merge offered by ``/wallet/link``: the other account's wallets, sign-in methods and runs
    join this one, and the session acts as the wallet from now on."""
    keep = _member(principal)
    assert mergit_session
    async with pool.connection() as conn, conn.transaction():
        try:
            absorb, address = await accounts.take_offer(conn, settings, body.merge_token, keep)
        except accounts.OfferInvalid as invalid:
            raise HTTPException(
                status_code=404, detail="that merge offer is unknown, used or expired"
            ) from invalid
        except accounts.OfferNotYours as not_yours:
            raise HTTPException(
                status_code=403, detail="that merge offer belongs to another account"
            ) from not_yours
        await accounts.merge_users(conn, keep, absorb)
        await conn.execute(
            "UPDATE sessions SET address = %s WHERE token_hash = %s",
            (address, _token_hash(settings, mergit_session)),
        )
    return {"address": address}


@account_router.post("/trial")
async def start_trial(principal: PrincipalDep, pool: PoolDep) -> dict[str, str]:
    """Chooses the free trial: plans funded from the treasury's free credits, with no wallet."""
    user_id = _member(principal)
    async with pool.connection() as conn:
        started = await accounts.start_trial(conn, user_id)
    return {"started_at": started.isoformat()}


@router.post("/logout", status_code=204)
async def logout(
    response: Response,
    settings: SettingsDep,
    pool: PoolDep,
    mergit_session: Annotated[str | None, Cookie()] = None,
) -> None:
    if mergit_session:
        async with pool.connection() as conn:
            await conn.execute(
                "UPDATE sessions SET revoked_at = now() WHERE token_hash = %s AND revoked_at IS NULL",
                (_token_hash(settings, mergit_session),),
            )
    response.delete_cookie(
        COOKIE, path="/", domain=settings.cookie_domain, secure=True, httponly=True, samesite="lax"
    )
