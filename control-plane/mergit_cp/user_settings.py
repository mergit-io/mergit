"""What a user chooses for their own plans: planner model, routing mode, attempts, funding and spend caps.

Nothing here can widen what the deployment allows. The planner model must be one the operator offers (and
priced), attempts stay within ``Settings.max_attempts`` when a plan is approved, and a cap can only make
approval stricter. A user with no saved row gets the defaults below, which are the behaviour before settings.
"""

from dataclasses import dataclass, replace
from typing import Literal
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import TupleRow

Conn = AsyncConnection[TupleRow]
RoutingMode = Literal["greedy", "explore"]
Funding = Literal["credits", "wallet"]


@dataclass(frozen=True, slots=True)
class Preferences:
    planner_model: str | None = None
    routing_mode: RoutingMode = "greedy"
    max_attempts: int = 1
    default_funding: Funding = "credits"
    per_plan_cap_usdc_units: int | None = None
    daily_cap_usdc_units: int | None = None

    def view(self) -> dict[str, object]:
        """The JSON shape: amounts are strings, like every other USDC amount in this API."""
        cap = self.per_plan_cap_usdc_units
        day = self.daily_cap_usdc_units
        return {
            "planner_model": self.planner_model,
            "routing_mode": self.routing_mode,
            "max_attempts": self.max_attempts,
            "default_funding": self.default_funding,
            "per_plan_cap_usdc_units": None if cap is None else str(cap),
            "daily_cap_usdc_units": None if day is None else str(day),
        }


async def load(conn: Conn, user_id: UUID) -> Preferences:
    cur = await conn.execute(
        "SELECT planner_model, routing_mode, max_attempts, default_funding,"
        " per_plan_cap_usdc_units, daily_cap_usdc_units FROM user_settings WHERE user_id = %s",
        (user_id,),
    )
    row = await cur.fetchone()
    if row is None:
        return Preferences()
    return Preferences(row[0], row[1], row[2], row[3], row[4], row[5])


async def save(conn: Conn, user_id: UUID, changes: dict[str, object]) -> Preferences:
    """Applies only the fields in ``changes`` on top of what is stored, and returns the result."""
    merged = replace(await load(conn, user_id), **changes)  # type: ignore[arg-type]
    await conn.execute(
        "INSERT INTO user_settings (user_id, planner_model, routing_mode, max_attempts, default_funding,"
        " per_plan_cap_usdc_units, daily_cap_usdc_units) VALUES (%s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (user_id) DO UPDATE SET planner_model = EXCLUDED.planner_model,"
        " routing_mode = EXCLUDED.routing_mode, max_attempts = EXCLUDED.max_attempts,"
        " default_funding = EXCLUDED.default_funding,"
        " per_plan_cap_usdc_units = EXCLUDED.per_plan_cap_usdc_units,"
        " daily_cap_usdc_units = EXCLUDED.daily_cap_usdc_units, updated_at = now()",
        (
            user_id,
            merged.planner_model,
            merged.routing_mode,
            merged.max_attempts,
            merged.default_funding,
            merged.per_plan_cap_usdc_units,
            merged.daily_cap_usdc_units,
        ),
    )
    return merged


async def cap_problems(
    conn: Conn, prefs: Preferences, owned: list[str], total: int, *, plan_uuid: str
) -> list[str]:
    """Why approving a plan worth ``total`` would break the user's own caps (empty when it would not)."""
    problems: list[str] = []
    per_plan = prefs.per_plan_cap_usdc_units
    if per_plan is not None and total > per_plan:
        problems.append(f"this plan is {total} USDC units, over your per-plan cap of {per_plan}")
    daily = prefs.daily_cap_usdc_units
    if daily is not None:
        cur = await conn.execute(
            "SELECT COALESCE(sum(total_budget_usdc_units), 0)::bigint FROM plans"
            " WHERE requester = ANY(%s) AND approved_at > now() - interval '24 hours' AND plan_uuid <> %s",
            (owned, plan_uuid),
        )
        row = await cur.fetchone()
        assert row is not None
        spent = int(row[0])
        if spent + total > daily:
            problems.append(
                f"{spent} approved in the last 24 hours; with this plan {spent + total},"
                f" over your daily cap of {daily}"
            )
    return problems
