"""`mergit_cp.world.approvals`: the approval lifecycle itself (plan sec 1.5-1.8), exercised directly against
Postgres without going through HTTP or a real World ID token — `record` takes an already-verified `IdClaims`,
so these tests construct that dataclass by hand. The HTTP-level journey (428 -> /start -> /callback with a
minted token -> approve with the header) is `test_world_approve_gate.py`. Run with `pytest -m postgres`.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from pydantic import SecretStr

from mergit_cp import accounts
from mergit_cp.config import Settings
from mergit_cp.db import Pool, migrate, open_pool
from mergit_cp.world import approvals
from mergit_cp.world.idp import IdClaims

pytestmark = pytest.mark.postgres

SETTINGS = Settings(
    database_url="unused",
    app_domain="app.mergit.test",
    session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
    gateway_url="http://gateway.invalid",
    store_url="http://store.invalid",
    agents_file="unused",
    planner_model="claude-opus-5",
    planner_provider="anthropic",
    events_token=SecretStr("test-events-token"),
    chain_events_token=SecretStr("test-chain-events-token"),
    worker_token=SecretStr("test-worker-token"),
    world_idp_client_id="test-client",
    world_idp_client_secret=SecretStr("test-client-secret"),
)
assert SETTINGS.world_idp_enabled

FIELDS = {"plan_uuid": "plan-1", "agents": {"0": ["1"]}, "funding": "wallet", "total_budget_usdc_units": "2"}


def claims(
    *,
    sub: str = "world-sub-1",
    nonce: str = "nonce-1",
    acr: str | None = "orb",
    amr: tuple[str, ...] = ("pop",),
    auth_time: int | None = None,
    jti: str = "jti-1",
) -> IdClaims:
    at = auth_time if auth_time is not None else int(datetime.now(UTC).timestamp())
    return IdClaims(sub=sub, auth_time=at, acr=acr, amr=amr, jti=jti, nonce=nonce)


def run(database_url: str, body: Any) -> Any:
    async def go() -> Any:
        pool = await open_pool(database_url, 4)
        try:
            async with pool.connection() as conn:
                await migrate(conn)
                await conn.execute("TRUNCATE users, world_approvals, world_links, world_nullifiers CASCADE")
            return await body(pool)
        finally:
            await pool.close()

    return asyncio.run(go())


async def _user(pool: Pool) -> UUID:
    async with pool.connection() as conn, conn.transaction():
        return await accounts.create_user(conn)


async def _pending(
    pool: Pool, *, user_id: UUID, plan_uuid: UUID | None = None, fields: dict[str, Any] | None = None
) -> approvals.PendingApproval:
    return await approvals.create_approval(
        pool,
        SETTINGS,
        user_id=user_id,
        kind="approve_plan",
        plan_uuid=plan_uuid or uuid.uuid4(),
        fields=fields or FIELDS,
        summary={"plan_id": "p-1", "total_budget_usdc_units": "2", "funding": "wallet"},
    )


async def _begin(pool: Pool, approval_id: UUID, user_id: UUID) -> tuple[str, str, str]:
    async with pool.connection() as conn, conn.transaction():
        return await approvals.begin(conn, approval_id, user_id)


async def _row(pool: Pool, approval_id: UUID) -> tuple[Any, ...] | None:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT status, reason, sub, jti, action_hash FROM world_approvals WHERE approval_id = %s",
            (approval_id,),
        )
        return await cur.fetchone()


# --- action_hash ------------------------------------------------------------------------------------------


def test_action_hash_is_stable_for_identical_input() -> None:
    a = approvals.action_hash("approve_plan", FIELDS)
    b = approvals.action_hash("approve_plan", dict(FIELDS))
    assert a == b


@pytest.mark.parametrize("changed", ["agents", "funding", "total_budget_usdc_units", "plan_uuid"])
def test_action_hash_changes_with_any_field(changed: str) -> None:
    other = {
        "agents": {"0": ["2"]},
        "funding": "credits",
        "total_budget_usdc_units": "3",
        "plan_uuid": "plan-2",
    }
    mutated = FIELDS | {changed: other[changed]}
    assert approvals.action_hash("approve_plan", FIELDS) != approvals.action_hash("approve_plan", mutated)


def test_action_hash_differs_by_kind() -> None:
    assert approvals.action_hash("approve_plan", FIELDS) != approvals.action_hash("open_pr", FIELDS)


# --- PendingApproval.required_error -----------------------------------------------------------------------


def test_required_error_is_the_428_body_of_the_http_contract() -> None:
    approval_id = uuid.uuid4()
    expires_at = datetime(2026, 1, 1, tzinfo=UTC)
    pending = approvals.PendingApproval(approval_id=approval_id, expires_at=expires_at, summary={"a": 1})
    error = pending.required_error()
    assert error.status_code == 428
    assert error.detail == {
        "code": "human_approval_required",
        "approval_id": str(approval_id),
        "start_url": f"/v0/world/approvals/{approval_id}/start",
        "expires_at": expires_at.isoformat(),
        "summary": {"a": 1},
    }


# --- create_approval ----------------------------------------------------------------------------------


def test_create_approval_persists_even_if_the_callers_own_transaction_rolls_back(database_url: str) -> None:
    """Review Focus 1: the row is created on its own connection/transaction. A caller that raises right
    after calling this (as `approve_plan` does, to turn it into the 428) must still find the row."""

    async def body(pool: Pool) -> UUID:
        user_id = await _user(pool)
        pending: approvals.PendingApproval | None = None
        with pytest.raises(RuntimeError):
            # Mirrors routes_plans.approve_plan: an outer transaction is already open (and will roll back)
            # when create_approval is called; create_approval must still use its own, separate connection.
            async with pool.connection() as conn, conn.transaction():
                await conn.execute("INSERT INTO planning_attempts (requester) VALUES ('0xrollback')")
                pending = await _pending(pool, user_id=user_id)
                raise RuntimeError("the caller's own transaction rolls back here")
        assert pending is not None

        # the approval row survives the rollback...
        row = await _row(pool, pending.approval_id)
        assert row is not None
        assert row[0] == "pending"
        # ...but the caller's own insert, in the same (rolled-back) transaction, does not
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) FROM planning_attempts WHERE requester = '0xrollback'")
            assert await cur.fetchone() == (0,)
        return pending.approval_id

    run(database_url, body)


def test_create_approval_computes_and_stores_the_action_hash(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        row = await _row(pool, pending.approval_id)
        assert row is not None
        assert row[4] == approvals.action_hash("approve_plan", FIELDS)

    run(database_url, body)


# --- begin ---------------------------------------------------------------------------------------------


def test_begin_sets_state_nonce_and_verifier_on_an_owned_pending_row(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, nonce, verifier = await _begin(pool, pending.approval_id, user_id)
        assert state and nonce and verifier
        assert len({state, nonce, verifier}) == 3
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT state, nonce, code_verifier FROM world_approvals WHERE approval_id = %s",
                (pending.approval_id,),
            )
            row = await cur.fetchone()
        assert row == (state, nonce, verifier)

    run(database_url, body)


def test_begin_refuses_someone_elses_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        owner = await _user(pool)
        someone_else = await _user(pool)
        pending = await _pending(pool, user_id=owner)
        with pytest.raises(approvals.ApprovalInvalid) as excinfo:
            await _begin(pool, pending.approval_id, someone_else)
        assert excinfo.value.reason == "not_yours"

    run(database_url, body)


def test_begin_refuses_an_expired_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        async with pool.connection() as conn:
            await conn.execute(
                "UPDATE world_approvals SET expires_at = now() - interval '1 second' WHERE approval_id = %s",
                (pending.approval_id,),
            )
        with pytest.raises(approvals.ApprovalInvalid) as excinfo:
            await _begin(pool, pending.approval_id, user_id)
        assert excinfo.value.reason == "expired"

    run(database_url, body)


def test_begin_refuses_an_already_decided_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        async with pool.connection() as conn:
            await conn.execute(
                "UPDATE world_approvals SET status = 'consumed' WHERE approval_id = %s",
                (pending.approval_id,),
            )
        with pytest.raises(approvals.ApprovalInvalid) as excinfo:
            await _begin(pool, pending.approval_id, user_id)
        assert excinfo.value.reason == "used"

    run(database_url, body)


# --- record --------------------------------------------------------------------------------------------


async def _record(pool: Pool, state: str, claim: IdClaims | None, error: str | None) -> tuple[UUID, str]:
    async with pool.connection() as conn, conn.transaction():
        return await approvals.record(conn, state, claim, error, SETTINGS, datetime.now(UTC))


def test_record_approves_a_fresh_valid_token_and_links_the_sub(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, nonce, _ = await _begin(pool, pending.approval_id, user_id)
        approval_id, status = await _record(pool, state, claims(nonce=nonce, sub="sub-a"), None)
        assert (approval_id, status) == (pending.approval_id, "approved")
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT sub FROM world_links WHERE user_id = %s", (user_id,))
            row = await cur.fetchone()
        assert row == ("sub-a",)

    run(database_url, body)


def test_record_denies_cancel_at_world(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, _, _ = await _begin(pool, pending.approval_id, user_id)
        approval_id, status = await _record(pool, state, None, "access_denied")
        assert (approval_id, status) == (pending.approval_id, "denied")
        row = await _row(pool, pending.approval_id)
        assert row is not None and row[1] == "access_denied"

    run(database_url, body)


def test_record_fails_closed_on_a_world_side_or_token_error(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, _, _ = await _begin(pool, pending.approval_id, user_id)
        approval_id, status = await _record(pool, state, None, "token_invalid")
        assert (approval_id, status) == (pending.approval_id, "failed")

    run(database_url, body)


def test_record_denies_a_nonce_mismatch(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, _nonce, _ = await _begin(pool, pending.approval_id, user_id)
        _, status = await _record(pool, state, claims(nonce="wrong-nonce"), None)
        assert status == "denied"
        row = await _row(pool, pending.approval_id)
        assert row is not None and row[1] == "nonce_mismatch"

    run(database_url, body)


def _stale_claims(nonce: str) -> IdClaims:
    return claims(nonce=nonce, auth_time=int(datetime.now(UTC).timestamp()) - 121)


def _missing_pop_claims(nonce: str) -> IdClaims:
    return claims(nonce=nonce, amr=())


@pytest.mark.parametrize(
    ("make_claims", "expected_reason"),
    [(_stale_claims, "stale_auth_time"), (_missing_pop_claims, "missing_pop")],
    ids=["stale_auth_time", "missing_pop"],
)
def test_stale_auth_time_and_missing_pop_are_denied(
    database_url: str, make_claims: Any, expected_reason: str
) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, nonce, _ = await _begin(pool, pending.approval_id, user_id)
        _, status = await _record(pool, state, make_claims(nonce), None)
        assert status == "denied"
        row = await _row(pool, pending.approval_id)
        assert row is not None and row[1] == expected_reason

    run(database_url, body)


def test_acr_outside_the_allowlist_is_denied(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, nonce, _ = await _begin(pool, pending.approval_id, user_id)
        _, status = await _record(pool, state, claims(nonce=nonce, acr="device"), None)
        assert status == "denied"
        row = await _row(pool, pending.approval_id)
        assert row is not None and row[1] == "acr_not_allowed"

    run(database_url, body)


def test_a_different_human_cannot_approve(database_url: str) -> None:
    """The account already has a linked `sub`; a token for a *different* human is denied, not re-linked."""

    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        first = await _pending(pool, user_id=user_id)
        state1, nonce1, _ = await _begin(pool, first.approval_id, user_id)
        await _record(pool, state1, claims(nonce=nonce1, sub="sub-a", jti="jti-a"), None)

        second = await _pending(pool, user_id=user_id)
        state2, nonce2, _ = await _begin(pool, second.approval_id, user_id)
        claims2 = claims(nonce=nonce2, sub="sub-b", jti="jti-b")
        approval_id, status = await _record(pool, state2, claims2, None)
        assert (approval_id, status) == (second.approval_id, "denied")
        row = await _row(pool, second.approval_id)
        assert row is not None and row[1] == "different_human"

    run(database_url, body)


def test_world_id_linked_to_another_account_is_denied(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        owner = await _user(pool)
        first = await _pending(pool, user_id=owner)
        state1, nonce1, _ = await _begin(pool, first.approval_id, owner)
        await _record(pool, state1, claims(nonce=nonce1, sub="shared-sub", jti="jti-owner"), None)

        other_user = await _user(pool)
        second = await _pending(pool, user_id=other_user)
        state2, nonce2, _ = await _begin(pool, second.approval_id, other_user)
        approval_id, status = await _record(
            pool, state2, claims(nonce=nonce2, sub="shared-sub", jti="jti-other"), None
        )
        assert (approval_id, status) == (second.approval_id, "denied")
        row = await _row(pool, second.approval_id)
        assert row is not None and row[1] == "linked_to_another_account"
        # the attacker's account must not end up with any link at all
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT sub FROM world_links WHERE user_id = %s", (other_user,))
            assert await cur.fetchone() is None

    run(database_url, body)


def test_replayed_id_token_is_denied(database_url: str) -> None:
    """The same `jti` used to decide one approval cannot also decide a second one, even for the same user
    and even though every other check about the second token looks fine."""

    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        first = await _pending(pool, user_id=user_id)
        state1, nonce1, _ = await _begin(pool, first.approval_id, user_id)
        _, status1 = await _record(pool, state1, claims(nonce=nonce1, sub="sub-a", jti="reused-jti"), None)
        assert status1 == "approved"

        second = await _pending(pool, user_id=user_id)
        state2, nonce2, _ = await _begin(pool, second.approval_id, user_id)
        approval_id, status2 = await _record(
            pool, state2, claims(nonce=nonce2, sub="sub-a", jti="reused-jti"), None
        )
        assert (approval_id, status2) == (second.approval_id, "denied")
        row = await _row(pool, second.approval_id)
        assert row is not None and row[1] == "replayed_jti" and row[3] is None

    run(database_url, body)


def test_record_is_idempotent_for_a_redelivered_callback(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        pending = await _pending(pool, user_id=user_id)
        state, nonce, _ = await _begin(pool, pending.approval_id, user_id)
        first = await _record(pool, state, claims(nonce=nonce), None)
        second = await _record(pool, state, claims(nonce=nonce), None)
        assert first == second == (pending.approval_id, "approved")

    run(database_url, body)


# --- consume -------------------------------------------------------------------------------------------


async def _approve(pool: Pool, user_id: UUID, plan_uuid: UUID, fields: dict[str, Any]) -> UUID:
    pending = await _pending(pool, user_id=user_id, plan_uuid=plan_uuid, fields=fields)
    state, nonce, _ = await _begin(pool, pending.approval_id, user_id)
    _, status = await _record(pool, state, claims(nonce=nonce), None)
    assert status == "approved"
    return pending.approval_id


def test_consume_succeeds_once_then_refuses_reuse(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        approval_id = await _approve(pool, user_id, plan_uuid, fields)

        async with pool.connection() as conn, conn.transaction():
            await approvals.consume(
                conn,
                approval_id,
                user_id=user_id,
                kind="approve_plan",
                plan_uuid=plan_uuid,
                fields=fields,
                now=datetime.now(UTC),
            )
        row = await _row(pool, approval_id)
        assert row is not None and row[0] == "consumed"

        async def second() -> None:
            async with pool.connection() as conn, conn.transaction():
                await approvals.consume(
                    conn,
                    approval_id,
                    user_id=user_id,
                    kind="approve_plan",
                    plan_uuid=plan_uuid,
                    fields=fields,
                    now=datetime.now(UTC),
                )

        with pytest.raises(approvals.ApprovalInvalid) as excinfo:
            await second()
        assert excinfo.value.reason == "used"

    run(database_url, body)


def test_consume_refuses_a_changed_action_after_approval(database_url: str) -> None:
    """Review Focus 2: approved for one budget, then the caller tries to spend a different one."""

    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        approval_id = await _approve(pool, user_id, plan_uuid, fields)

        changed = fields | {"total_budget_usdc_units": "999"}
        async with pool.connection() as conn, conn.transaction():
            with pytest.raises(approvals.ApprovalInvalid) as excinfo:
                await approvals.consume(
                    conn,
                    approval_id,
                    user_id=user_id,
                    kind="approve_plan",
                    plan_uuid=plan_uuid,
                    fields=changed,
                    now=datetime.now(UTC),
                )
        assert excinfo.value.reason == "action_mismatch"
        row = await _row(pool, approval_id)
        assert row is not None and row[0] == "approved"  # untouched: the mismatch must not consume it

    run(database_url, body)


def test_consume_refuses_an_expired_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        approval_id = await _approve(pool, user_id, plan_uuid, fields)
        async with pool.connection() as conn:
            await conn.execute(
                "UPDATE world_approvals SET expires_at = now() - interval '1 second' WHERE approval_id = %s",
                (approval_id,),
            )
        async with pool.connection() as conn, conn.transaction():
            with pytest.raises(approvals.ApprovalInvalid) as excinfo:
                await approvals.consume(
                    conn,
                    approval_id,
                    user_id=user_id,
                    kind="approve_plan",
                    plan_uuid=plan_uuid,
                    fields=fields,
                    now=datetime.now(UTC),
                )
        assert excinfo.value.reason == "expired"

    run(database_url, body)


def test_consume_refuses_someone_elses_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        owner = await _user(pool)
        someone_else = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        approval_id = await _approve(pool, owner, plan_uuid, fields)
        async with pool.connection() as conn, conn.transaction():
            with pytest.raises(approvals.ApprovalInvalid) as excinfo:
                await approvals.consume(
                    conn,
                    approval_id,
                    user_id=someone_else,
                    kind="approve_plan",
                    plan_uuid=plan_uuid,
                    fields=fields,
                    now=datetime.now(UTC),
                )
        assert excinfo.value.reason == "not_yours"

    run(database_url, body)


def test_consume_refuses_an_approval_for_another_plan(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_a = uuid.uuid4()
        fields_a = FIELDS | {"plan_uuid": str(plan_a)}
        approval_id = await _approve(pool, user_id, plan_a, fields_a)

        plan_b = uuid.uuid4()
        fields_b = FIELDS | {"plan_uuid": str(plan_b)}
        async with pool.connection() as conn, conn.transaction():
            with pytest.raises(approvals.ApprovalInvalid) as excinfo:
                await approvals.consume(
                    conn,
                    approval_id,
                    user_id=user_id,
                    kind="approve_plan",
                    plan_uuid=plan_b,
                    fields=fields_b,
                    now=datetime.now(UTC),
                )
        assert excinfo.value.reason == "not_yours"

    run(database_url, body)


def test_consume_refuses_a_denied_approval(database_url: str) -> None:
    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        pending = await _pending(pool, user_id=user_id, plan_uuid=plan_uuid, fields=fields)
        state, _, _ = await _begin(pool, pending.approval_id, user_id)
        _, status = await _record(pool, state, None, "access_denied")
        assert status == "denied"
        async with pool.connection() as conn, conn.transaction():
            with pytest.raises(approvals.ApprovalInvalid) as excinfo:
                await approvals.consume(
                    conn,
                    pending.approval_id,
                    user_id=user_id,
                    kind="approve_plan",
                    plan_uuid=plan_uuid,
                    fields=fields,
                    now=datetime.now(UTC),
                )
        assert excinfo.value.reason == "denied"

    run(database_url, body)


def test_consume_is_atomic_under_concurrent_calls(database_url: str) -> None:
    """Two concurrent redemptions of the same approval: exactly one succeeds, the other must find the row
    already `consumed` (not both succeed, which would mean the plan gets funded twice)."""

    async def body(pool: Pool) -> None:
        user_id = await _user(pool)
        plan_uuid = uuid.uuid4()
        fields = FIELDS | {"plan_uuid": str(plan_uuid)}
        approval_id = await _approve(pool, user_id, plan_uuid, fields)

        async def attempt() -> str | None:
            async with pool.connection() as conn, conn.transaction():
                try:
                    await approvals.consume(
                        conn,
                        approval_id,
                        user_id=user_id,
                        kind="approve_plan",
                        plan_uuid=plan_uuid,
                        fields=fields,
                        now=datetime.now(UTC),
                    )
                    return None
                except approvals.ApprovalInvalid as invalid:
                    return invalid.reason

        results = await asyncio.gather(attempt(), attempt())
        assert sorted(r or "ok" for r in results) == ["ok", "used"]
        row = await _row(pool, approval_id)
        assert row is not None and row[0] == "consumed"

    run(database_url, body)
