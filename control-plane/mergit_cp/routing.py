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
in-flight commitment -- *unless* it has already sat there past `dispatch.DISPATCH_DEADLINE_S` seconds, the
same deadline `task.dispatch_requested` itself carries (fix round 1, Finding 1): a dispatch that never
escrows at all (the gateway rejects it, or the outbox event's retry window expires) would otherwise count
against its operator forever, since nothing ever arrives to resolve it. Reusing the dispatch's own stated
deadline means it stops blocking a future attempt for its operator exactly when the dispatch itself gives up
hope of ever being escrowed, not on some separately invented clock.

**The cap-adjusted redirect.** When `route`'s draw is exploratory but the chosen agent's operator is already
at its exploration cap, the draw is replaced with one that dispatches `greedy` instead, `exploratory=False`
(the agent actually being dispatched is the deterministic baseline, not the sampled pick) -- built with
`dataclasses.replace(draw, chosen=draw.greedy, exploratory=False)`, keeping the same `samples` and `greedy`
so the full sampled picture stays visible in the stored row even though a different agent was dispatched.
`PendingDraw.original_chosen` separately remembers what the pre-redirect exploratory pick actually was
(`None` when no redirect happened), since `draw.chosen` itself no longer carries that once redirected (fix
round 1, Finding 3).
When `greedy` is also `None` (Task 4's `draw()` only ever sets `greedy` when some arm is feasible by
*posterior mean*; it can be `None` even while `chosen` is set, when a sampled draw happened to be feasible by
*sampled* cost), there is nothing safe to dispatch -- `route` returns `None`, never a `PendingDraw` wrapping a
`None` chosen agent.

**Storing enough to replay a draw from the row alone.** `record_draw` writes each arm's posterior parameters
(`alpha`/`beta`/`kappa`/`tau`), not just the sampled `theta`/`cost_micros`/`density`/`feasible` derived from
them, into `samples` (fix round 1, Finding 3): `reputation_posteriors` mutates in place over time, so by the
time anyone wants to replay an old draw, the *live* posteriors have already moved on past what was actually
sampled from. Without the posterior parameters captured at draw time, a `routing_draws` row cannot
reconstruct the `Arm`s `router.draw()` was actually called with, and so cannot genuinely replay itself. The
budget tolerance the draw used is stored alongside for the same reason (final review m6): it is a setting,
and a setting can change.

**Over budget is structural, not transient (final review C1).** An agent no draw will realistically route
for a task's budget is excluded from that task's draws (`over_budget`), and an auto index with no untried
agent that can fit its budget is told apart from one merely waiting for capacity (`budget_infeasible`), so
it is reported as needing the requester instead of being retried by the capacity sweep forever.
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
from .dispatch import DISPATCH_DEADLINE_S
from .plans import StoredPlan, StoredTask
from .reputation import Posterior, in_probation, posterior
from .router import Arm, Draw, Mode, draw, feasible_probability, mean_feasible

ALREADY_TRIED = "already tried on this task"
OVER_BUDGET = "over budget for this task"
IN_PROBATION = "operator in probation"
AT_CAP = "operator at concurrency cap"
"""The reasons `candidates` gives for leaving an agent out of a draw. The first two are structural for the
index: nothing puts an agent back once it has been tried here, and an agent stays over budget until its cost
posterior moves, which only new evidence from other tasks can do. The last two are transient and clear on
their own."""

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
#
# The staleness carve-out (fix round 1, Finding 1): a dispatch with no `jobs` row AND older than
# `DISPATCH_DEADLINE_S` never escrowed and never will -- it must not count forever. `j.status IS NULL` is
# only true when no `jobs` row exists at all (a dispatch that *did* escrow always gets one, whatever its
# later status); a dispatch that still has no `jobs` row but is still *within* its deadline is a real
# in-flight commitment and keeps counting.
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
  AND NOT (j.status IS NULL AND d.dispatched_at < now() - make_interval(secs => %(deadline_s)s))
GROUP BY d.agent_id
"""

# Same "unresolved" definition as `_UNRESOLVED_BY_AGENT` above (staleness carve-out included), applied to
# `routing_draws` instead of `task_dispatches` directly (one `routing_draws` row per `task_dispatches` row,
# same primary key, joined here for `dispatched_at`), and restricted to draws that were actually dispatched
# exploratory (`exploratory = true`, which is the chosen agent actually running, not the original sample
# before any cap-redirect -- see `record_draw`/`PendingDraw.original_chosen`).
_UNRESOLVED_EXPLORATORY_BY_AGENT = """
SELECT count(*)
FROM routing_draws rd
JOIN task_dispatches d ON d.task_id = rd.task_id
LEFT JOIN jobs j ON j.task_id = rd.task_id
WHERE rd.exploratory = true
  AND rd.chosen_agent = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM money_events m
      WHERE m.task_id = rd.task_id AND m.kind IN ('task.released', 'task.returned')
  )
  AND NOT COALESCE(j.status = 'error' AND j.receipt_root IS NULL, false)
  AND NOT (j.status IS NULL AND d.dispatched_at < now() - make_interval(secs => %(deadline_s)s))
"""


def _task(plan: StoredPlan, index: int) -> StoredTask:
    task = next((t for t in plan.tasks if t.draft.index == index), None)
    if task is None:
        raise ValueError(f"plan {plan.plan_uuid} has no task at index {index}")
    return task


def over_budget(post: Posterior, budget_micros: int, settings: Settings) -> bool:
    """True when not even a Thompson draw will realistically pick this agent for this budget: the chance
    that one sample of its cost fits (`router.feasible_probability`) is below
    `settings.router_min_feasible_probability`. Mode-independent: such an agent's mean cost is over budget
    too, so `explore=False` would never pick it either. (If the mean fits, `tau / limit <= kappa`, and the
    chance is at least `Q(kappa, kappa)`, about 0.37 for `kappa = 1` and rising toward 0.5 -- every posterior
    here has `kappa >= 1`, and the setting is capped at 0.25.) `candidates` leaves it out of every draw."""
    p = feasible_probability(post, budget_micros, settings.router_budget_tolerance)
    return p < settings.router_min_feasible_probability


def routable(post: Posterior, budget_micros: int, explore: bool, settings: Settings) -> bool:
    """Whether `route` could ever dispatch this agent for this budget under this mode, if it were otherwise
    eligible. With `explore`, any agent not `over_budget`: a draw may sample its cost under budget. Without
    it, only an agent whose posterior mean cost fits, since `chosen == greedy` and `greedy` only ever looks
    at means (`router.mean_feasible`)."""
    if explore:
        return not over_budget(post, budget_micros, settings)
    return mean_feasible(post, budget_micros, settings.router_budget_tolerance)


async def _tried(conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int) -> set[str]:
    cur = await conn.execute(
        'SELECT DISTINCT agent_id FROM task_dispatches WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, index),
    )
    return {row[0] for row in await cur.fetchall()}


async def budget_infeasible(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, settings: Settings
) -> bool:
    """The structural reason `route` returns `None` (final review C1), told apart from the transient one.

    True when no roster agent that has not already been tried on this index is `routable` for the task's
    budget under the task's own `explore` setting -- whatever its probation or concurrency-cap state right
    now, since those clear on their own and a budget-fitting agent behind them is still worth waiting for.
    `route` can then never dispatch this index (`candidates` leaves every `over_budget` agent out of the
    draw, and with exploring off `greedy`, hence `chosen`, is `None` when no mean cost fits), and the
    capacity sweep would retry it forever. `outcomes.stuck_indexes` reports it as needing the requester,
    and the dispatch paths skip it without taking `route`'s advisory lock, the same way they treat
    `roster_exhausted`.

    It reads only posteriors and `task_dispatches`, so it is not permanent in the strict sense: new cost
    evidence for one of the untried agents from some other task can make it routable again, and the next
    sweep then dispatches it. Always `False` for a `'pick'` task, and for an empty roster (mirroring
    `roster_exhausted`)."""
    task = _task(plan, index)
    if task.routing != "auto":
        return False
    agents = roster(settings)
    if not agents:
        return False
    tried = await _tried(conn, plan, index)
    for a in agents:
        if a.agent_id in tried:
            continue
        post = await posterior(conn, a.agent_id, plan.category, settings)
        if routable(post, task.draft.budget_usdc_units, task.explore, settings):
            return False
    return True


async def candidates(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, settings: Settings
) -> tuple[list[Arm], dict[str, str]]:
    """The arms a router may draw from for `(plan.plan_uuid, index)`, plus a map of every other roster
    agent to a human-readable reason it was excluded.

    Exclusion is checked in priority order, first match wins, so an agent is never double-reported:
    already dispatched on this index (any attempt, any agent) > over budget for this task (`over_budget`)
    > its operator in probation > its operator at the concurrency cap. The two structural reasons come
    first, so a transient reason on an agent always means it would be drawable once that reason clears.
    """
    agents = roster(settings)
    if not agents:
        return [], {}
    agent_ids = [a.agent_id for a in agents]
    budget_micros = _task(plan, index).draft.budget_usdc_units

    already_tried = await _tried(conn, plan, index)

    cur = await conn.execute(
        _UNRESOLVED_BY_AGENT, {"agent_ids": agent_ids, "deadline_s": DISPATCH_DEADLINE_S}
    )
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
            ineligible[a.agent_id] = ALREADY_TRIED
            continue
        post = await posterior(conn, a.agent_id, plan.category, settings)
        if over_budget(post, budget_micros, settings):
            ineligible[a.agent_id] = OVER_BUDGET
        elif probation_by_operator[a.operator]:
            ineligible[a.agent_id] = IN_PROBATION
        elif unresolved_by_operator.get(a.operator, 0) >= settings.router_operator_concurrency_cap:
            ineligible[a.agent_id] = AT_CAP
        else:
            arms.append(Arm(a.agent_id, post))
    return arms, ineligible


async def roster_exhausted(
    conn: AsyncConnection[TupleRow],
    plan: StoredPlan,
    index: int,
    last_processed_attempt: int,
    settings: Settings,
) -> bool:
    """True once every agent in the roster has been dispatched, at or before ``last_processed_attempt``,
    for `(plan.plan_uuid, index)` -- `candidates`' "already tried" exclusion then rules out every one of
    them, forever, so there is structurally nothing left for `route` to ever draw for this index again
    (unlike the concurrency cap or probation, both transient).

    Shared by `dispatch.py` (to skip calling `route` -- and so skip taking its global advisory lock -- for
    an index already known to be hopeless, rather than re-discovering that the hard way on every sweep) and
    `outcomes.py`'s `stuck_indexes` (to report ``needs_requester``), so the one roster-exhaustion rule lives
    in one place, next to the eligibility rule (`candidates`) it mirrors.

    Only counts a dispatch toward exhaustion if its attempt is ``<= last_processed_attempt``: an attempt
    still in flight (dispatched, but not yet processed) might still pass, so it must never count as "this
    agent already failed" -- the same restriction pick-mode's own `_next_agent` gets for free by only ever
    looking at the latest *processed* attempt.
    """
    agents = roster(settings)
    if not agents:
        return False
    cur = await conn.execute(
        "SELECT DISTINCT agent_id FROM task_dispatches"
        ' WHERE plan_uuid = %s AND "index" = %s AND attempt <= %s',
        (plan.plan_uuid, index, last_processed_attempt),
    )
    tried = {row[0] for row in await cur.fetchall()}
    return {a.agent_id for a in agents}.issubset(tried)


@dataclass(frozen=True)
class PendingDraw:
    """What `route` decided, ready for `record_draw` to persist once the caller actually dispatches
    `draw.chosen`. `draw.chosen` is never `None` here -- `route` returns Python `None` instead of a
    `PendingDraw` whenever nothing should be dispatched.

    `arms` is the exact arm set (agent + posterior) `route` drew over, kept so `record_draw` can write each
    arm's posterior parameters alongside its sample (Finding 3). `original_chosen` is the pre-redirect
    exploratory pick when a cap-redirect happened in `route`, `None` otherwise.
    """

    seed: str
    draw: Draw
    budget_micros: int
    mode: Mode
    ineligible: dict[str, str]
    arms: list[Arm]
    original_chosen: str | None
    tolerance: float
    """`settings.router_budget_tolerance` as `draw()` was actually called with it, stored by `record_draw`
    so a replay does not depend on the setting never changing (final review m6)."""


async def route(
    conn: AsyncConnection[TupleRow], plan: StoredPlan, index: int, attempt: int, settings: Settings
) -> PendingDraw | None:
    """Draw an agent for `(plan.plan_uuid, index)`, or `None` when nothing is eligible or feasible.

    **Two reasons for `None` (final review C1).** Transient: every agent that could fit the budget is
    momentarily excluded (its operator in probation or at the concurrency cap), or an `explore=True` draw
    simply sampled nothing feasible this time -- the capacity sweep retries it. Structural: no untried
    agent can fit the budget under this task's mode at all (`budget_infeasible`), so no later retry will
    ever do better. `None` itself does not say which; callers that need to know ask `budget_infeasible`,
    which classifies from the same rules this function applies (`candidates`' `over_budget` exclusion and
    `draw`'s mean-cost `greedy`), so the two can never disagree about an index.

    **Locking contract (fix round 1, Finding 2).** This takes
    `pg_advisory_xact_lock(hashtext('mergit.routing'))` as its very first statement, the same pattern
    `reputation.ingest_due` uses for its own advisory lock -- serialising concurrent `route` calls so two
    routers can never both read "one below the operator cap" and both dispatch into it, overshooting the
    cap this whole mechanism exists to enforce.

    THIS ONLY WORKS IF THE CALLER RUNS `route`, THE ACTUAL DISPATCH INSERT (e.g. `dispatch.dispatch_task`),
    AND `record_draw` ALL INSIDE ONE TRANSACTION/CONNECTION. `pg_advisory_xact_lock` releases automatically
    at transaction end; if the caller commits `route`'s own read in a separate transaction from the dispatch
    insert that acts on it, the lock has already been released by the time the insert happens and provides
    no protection whatsoever against the overshoot it exists to prevent. Whichever later task wires `route`
    into the real dispatch flow must honor this -- one transaction, start to finish.

    `attempt` is not used by the eligibility or draw logic itself (which only ever cares about the index:
    "already tried" already covers every attempt), but is accepted so a caller already holding
    `(plan, index, attempt)` for `dispatch_task` can pass it straight through without picking it apart.

    The seed is `secrets.randbits(63)`, kept as the actual int for `random.Random` (so this draw and a
    later replay from the stored value agree bit-for-bit) and stored on `PendingDraw.seed` as `str(...)` --
    text, not a float or a bare int, so it round-trips through Postgres and JSON exactly (`random.Random`
    seeded from the int recovered via `int(stored_seed)` reproduces the same draw; seeding `random.Random`
    from the *string* form directly would not, since `random.seed` treats `str` and `int` seeds
    differently).

    Raises `ValueError` for a programming error -- no `tasks` row for `(plan.plan_uuid, index)`, or `index`
    not one of `plan.tasks` -- rather than returning `None`, which would make a caller bug indistinguishable
    from a legitimate "nothing eligible" routing decision (the same discipline `dispatch.dispatch_task`
    already uses for its own `phi_hash` precondition).
    """
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext('mergit.routing'))")

    cur = await conn.execute(
        'SELECT explore, retry_tolerant FROM tasks WHERE plan_uuid = %s AND "index" = %s',
        (plan.plan_uuid, index),
    )
    row = await cur.fetchone()
    if row is None:
        raise ValueError(f"route(): no tasks row for plan {plan.plan_uuid} index {index}")
    explore, retry_tolerant = row
    mode = Mode(explore=explore, retry_tolerant=retry_tolerant)

    task = next((t for t in plan.tasks if t.draft.index == index), None)
    if task is None:
        raise ValueError(f"route(): plan {plan.plan_uuid} has no task at index {index}")
    budget_usdc_units = task.draft.budget_usdc_units

    arms, ineligible = await candidates(conn, plan, index, settings)
    if not arms:
        return None

    seed_value = secrets.randbits(63)
    seed = str(seed_value)
    rng = random.Random(seed_value)  # noqa: S311 -- Thompson sampling, not a cryptographic use
    tolerance = settings.router_budget_tolerance
    result = draw(arms, budget_usdc_units, mode, tolerance, rng)
    if result.chosen is None:
        return None

    original_chosen: str | None = None
    if result.exploratory:
        agents_by_id = {a.agent_id: a for a in roster(settings)}
        chosen_operator = agents_by_id[result.chosen].operator
        operator_agent_ids = [a.agent_id for a in roster(settings) if a.operator == chosen_operator]
        cur = await conn.execute(
            _UNRESOLVED_EXPLORATORY_BY_AGENT,
            {"agent_ids": operator_agent_ids, "deadline_s": DISPATCH_DEADLINE_S},
        )
        count_row = await cur.fetchone()
        exploratory_count = count_row[0] if count_row else 0
        if exploratory_count >= settings.router_explore_cap_per_operator:
            if result.greedy is None:
                # The cross-task constraint from Task 4's fix round: `greedy` can be `None` even when
                # `chosen` is set. There is nothing safe left to dispatch once the exploratory pick itself
                # is capped out -- never fall through and dispatch `result.chosen` anyway.
                return None
            original_chosen = result.chosen
            result = replace(result, chosen=result.greedy, exploratory=False)

    return PendingDraw(
        seed=seed,
        draw=result,
        budget_micros=budget_usdc_units,
        mode=mode,
        ineligible=ineligible,
        arms=arms,
        original_chosen=original_chosen,
        tolerance=tolerance,
    )


async def record_draw(conn: AsyncConnection[TupleRow], task_id: str, pending: PendingDraw) -> None:
    """Persist the draw actually acted on: `chosen_agent` is whichever agent is really being dispatched
    (the original sample, or `greedy` when a cap-redirect happened in `route`), and `exploratory` is honest
    about that -- `false` for a redirected draw, even though the underlying sample was exploratory.

    `samples` stores, per arm, both the sampled values (`theta`/`cost_micros`/`density`/`feasible`) and the
    posterior parameters (`alpha`/`beta`/`kappa`/`tau`) they were sampled from, plus `original_chosen` (the
    pre-redirect exploratory pick, `None` when no redirect happened) and `budget_tolerance` (the
    `router_budget_tolerance` the draw's feasibility filter used; final review m6) -- enough, together with
    the stored `seed`, `budget_micros` and mode, for `router.draw()` to replay this exact draw from the row
    alone, independent of whatever `reputation_posteriors` or the settings have since moved on to (fix
    round 1, Finding 3).
    """
    if pending.draw.chosen is None:
        raise ValueError("record_draw called with a PendingDraw whose chosen agent is None")
    posterior_by_agent = {a.agent_id: a.posterior for a in pending.arms}
    samples = {
        "arms": [
            {
                **asdict(s),
                "alpha": posterior_by_agent[s.agent_id].alpha,
                "beta": posterior_by_agent[s.agent_id].beta,
                "kappa": posterior_by_agent[s.agent_id].kappa,
                "tau": posterior_by_agent[s.agent_id].tau,
            }
            for s in pending.draw.samples
        ],
        "original_chosen": pending.original_chosen,
        "budget_tolerance": pending.tolerance,
    }
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
            Jsonb(samples),
            Jsonb(pending.ineligible),
            pending.draw.chosen,
            pending.draw.greedy,
            pending.draw.exploratory,
        ),
    )
