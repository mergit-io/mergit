"""Eligibility, limits and the draw record (paper 7.5): which agents may even be considered for a task
(operator concurrency caps, probation, already-tried agents), drawing with a reproducible seed, and
recording the draw.

This is the database/eligibility side of routing. The pure Thompson-sampling policy itself (`Arm`, `Mode`,
`draw`) is `mergit_cp/router.py` (Task 4); the pure posterior math (`Posterior`, `posterior`, `in_probation`)
is `mergit_cp/reputation.py` (Tasks 2-3). Nothing here duplicates either: `candidates` and `route` only ever
call into them.

**"Unresolved" dispatches** (used both for the operator concurrency cap here and for the per-operator
exploration cap below) means: a `task_dispatches` row for one of the operator's agents with no
`money_events` row of kind `task.released` or `task.returned` for that `task_id`, excluding a dispatch whose
`jobs` row has `status = 'error' AND receipt_root IS NULL` -- nothing was ever sealed for that attempt, so
there is nothing to forge and it should not count against either cap. A `task_dispatches` row with no
matching `jobs` row yet (still mid-escrow, before `task.escrowed`) counts as unresolved: it is a real
in-flight commitment.

**The cap-adjusted redirect.** When `route`'s draw is exploratory but the chosen agent's operator is already
at its exploration cap, the draw is replaced with one that dispatches `greedy` instead, `exploratory=False`
(the agent actually being dispatched is the deterministic baseline, not the sampled pick) -- built with
`dataclasses.replace(draw, chosen=draw.greedy, exploratory=False)`, keeping the same `samples` and `greedy`
so the full sampled picture stays visible in the stored row even though a different agent was dispatched.
When `greedy` is also `None` (Task 4's `draw()` only ever sets `greedy` when some arm is feasible by
*posterior mean*; it can be `None` even while `chosen` is set, when a sampled draw happened to be feasible by
*sampled* cost), there is nothing safe to dispatch -- `route` returns `None`, never a `PendingDraw` wrapping a
`None` chosen agent.
"""

from __future__ import annotations

import random
import secrets
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime

from psycopg import AsyncConnection
from psycopg.rows import TupleRow
from psycopg.types.json import Jsonb

from .agents import Agent, load_agents
from .config import Settings
from .plans import StoredPlan
from .reputation import in_probation, posterior
from .router import Arm, Draw, Mode, draw

_roster_cache: dict[tuple[str, str], list[Agent]] = {}


def roster(settings: Settings) -> list[Agent]:
    """Every agent this deployment knows about. `agents_file`/`agents_config` are read-only and never
    change at runtime, so this is memoised per (agents_file, agents_config) pair rather than re-parsed on
    every call."""
    key = (settings.agents_file, settings.agents_config)
    cached = _roster_cache.get(key)
    if cached is None:
        cached = load_agents(settings.agents_file, settings.agents_config)
        _roster_cache[key] = cached
    return cached


# Counted per agent_id; `candidates` sums these up per operator itself, since the cap is an operator-wide
# limit, not a per-agent one (paper 7.5 ii: an operator running several agents shares one concurrency
# budget across all of them).
_UNRESOLVED_BY_AGENT = """
SELECT d.agent_id, count(*)
FROM task_dispatches d
LEFT JOIN jobs j ON j.task_id = d.task_id
WHERE d.agent_id = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM money_events m
      WHERE m.task_id = d.task_id AND m.kind IN ('task.released', 'task.returned')
  )
  AND NOT COALESCE(j.status = 'error' AND j.receipt_root IS NULL, false)
GROUP BY d.agent_id
"""

# Same "unresolved" definition as `_UNRESOLVED_BY_AGENT` above, applied to `routing_draws` instead of
# `task_dispatches` directly (one `routing_draws` row per `task_dispatches` row, same primary key), and
# restricted to draws that were actually dispatched exploratory (`exploratory = true`, which is the chosen
# agent actually running, not the original sample before any cap-redirect -- see `record_draw`).
_UNRESOLVED_EXPLORATORY_BY_AGENT = """
SELECT count(*)
FROM routing_draws rd
LEFT JOIN jobs j ON j.task_id = rd.task_id
WHERE rd.exploratory = true
  AND rd.chosen_agent = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM money_events m
      WHERE m.task_id = rd.task_id AND m.kind IN ('task.released', 'task.returned')
  )
  AND NOT COALESCE(j.status = 'error' AND j.receipt_root IS NULL, false)
"""


async def candidates(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, settings: Settings
) -> tuple[list[Arm], dict[str, str]]:
    """The arms a router may draw from for `(plan.plan_uuid, index)`, plus a map of every other roster
    agent to a human-readable reason it was excluded.

    Exclusion is checked in priority order, first match wins, so an agent is never double-reported:
    already dispatched on this index (any attempt, any agent) > its operator in probation > its operator
    at the concurrency cap.
    """
    agents = roster(settings)
    if not agents:
        return [], {}
    agent_ids = [a.agent_id for a in agents]

    cur = await conn.execute(
        'SELECT DISTINCT agent_id FROM task_dispatches WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, index),
    )
    already_tried = {row[0] for row in await cur.fetchall()}

    cur = await conn.execute(_UNRESOLVED_BY_AGENT, {"agent_ids": agent_ids})
    unresolved_by_agent: dict[str, int] = dict(await cur.fetchall())
    unresolved_by_operator: dict[str, int] = {}
    for a in agents:
        count = unresolved_by_agent.get(a.agent_id, 0)
        unresolved_by_operator[a.operator] = unresolved_by_operator.get(a.operator, 0) + count

    now = datetime.now(UTC)
    probation_by_operator: dict[str, bool] = {}
    for operator in {a.operator for a in agents}:
        probation_by_operator[operator] = await in_probation(conn, operator, now, settings.router_probation_s)

    arms: list[Arm] = []
    ineligible: dict[str, str] = {}
    for a in agents:
        if a.agent_id in already_tried:
            ineligible[a.agent_id] = "already tried on this task"
        elif probation_by_operator[a.operator]:
            ineligible[a.agent_id] = "operator in probation"
        elif unresolved_by_operator.get(a.operator, 0) >= settings.router_operator_concurrency_cap:
            ineligible[a.agent_id] = "operator at concurrency cap"
        else:
            arms.append(Arm(a.agent_id, await posterior(conn, a.agent_id, plan.category, settings)))
    return arms, ineligible


@dataclass(frozen=True)
class PendingDraw:
    """What `route` decided, ready for `record_draw` to persist once the caller actually dispatches
    `draw.chosen`. `draw.chosen` is never `None` here -- `route` returns Python `None` instead of a
    `PendingDraw` whenever nothing should be dispatched."""

    seed: str
    draw: Draw
    budget_micros: int
    mode: Mode
    ineligible: dict[str, str]


async def route(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, attempt: int, settings: Settings
) -> PendingDraw | None:
    """Draw an agent for `(plan.plan_uuid, index)`, or `None` when nothing is eligible or feasible.

    `attempt` is not used by the eligibility or draw logic itself (which only ever cares about the index:
    "already tried" already covers every attempt), but is accepted so a caller already holding
    `(plan, index, attempt)` for `dispatch_task` can pass it straight through without picking it apart.

    The seed is `secrets.randbits(63)`, kept as the actual int for `random.Random` (so this draw and a
    later replay from the stored value agree bit-for-bit) and stored on `PendingDraw.seed` as `str(...)` --
    text, not a float or a bare int, so it round-trips through Postgres and JSON exactly (`random.Random`
    seeded from the int recovered via `int(stored_seed)` reproduces the same draw; seeding `random.Random`
    from the *string* form directly would not, since `random.seed` treats `str` and `int` seeds
    differently).
    """
    cur = await conn.execute(
        'SELECT explore, retry_tolerant FROM tasks WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, index),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    explore, retry_tolerant = row
    mode = Mode(explore=explore, retry_tolerant=retry_tolerant)

    task = next((t for t in plan.tasks if t.draft.index == index), None)
    if task is None:
        return None
    budget_usdc_units = task.draft.budget_usdc_units

    arms, ineligible = await candidates(conn, plan, index, settings)
    if not arms:
        return None

    seed_value = secrets.randbits(63)
    seed = str(seed_value)
    rng = random.Random(seed_value)  # noqa: S311 -- Thompson sampling, not a cryptographic use
    result = draw(arms, budget_usdc_units, mode, settings.router_budget_tolerance, rng)
    if result.chosen is None:
        return None

    if result.exploratory:
        agents_by_id = {a.agent_id: a for a in roster(settings)}
        chosen_operator = agents_by_id[result.chosen].operator
        operator_agent_ids = [a.agent_id for a in roster(settings) if a.operator == chosen_operator]
        cur = await conn.execute(_UNRESOLVED_EXPLORATORY_BY_AGENT, {"agent_ids": operator_agent_ids})
        count_row = await cur.fetchone()
        exploratory_count = count_row[0] if count_row else 0
        if exploratory_count >= settings.router_explore_cap_per_operator:
            if result.greedy is None:
                # The cross-task constraint from Task 4's fix round: `greedy` can be `None` even when
                # `chosen` is set. There is nothing safe left to dispatch once the exploratory pick itself
                # is capped out -- never fall through and dispatch `result.chosen` anyway.
                return None
            result = replace(result, chosen=result.greedy, exploratory=False)

    return PendingDraw(
        seed=seed, draw=result, budget_micros=budget_usdc_units, mode=mode, ineligible=ineligible
    )


async def record_draw(conn: AsyncConnection[TupleRow], task_id: str, pending: PendingDraw) -> None:
    """Persist the draw actually acted on: `pending.draw.chosen_agent` is whichever agent is really being
    dispatched (the original sample, or `greedy` when a cap-redirect happened in `route`), and
    `exploratory` is honest about that -- `false` for a redirected draw, even though the underlying sample
    was exploratory."""
    assert pending.draw.chosen is not None, "record_draw called with a PendingDraw whose chosen agent is None"
    await conn.execute(
        "INSERT INTO routing_draws (task_id, seed, explore, retry_tolerant, budget_micros, samples,"
        " ineligible, chosen_agent, greedy_agent, exploratory)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            task_id,
            pending.seed,
            pending.mode.explore,
            pending.mode.retry_tolerant,
            pending.budget_micros,
            Jsonb([asdict(s) for s in pending.draw.samples]),
            Jsonb(pending.ineligible),
            pending.draw.chosen,
            pending.draw.greedy,
            pending.draw.exploratory,
        ),
    )
