"""Cost-adjusted reputation: a Beta x Gamma posterior per agent (paper sections 8.2-8.7).

The top half of this module (`Posterior` through `update_weight`) is pure math only, no database, no I/O:
`Posterior` is a plain value, and every function there is a total function of its arguments.

The Beta half (`alpha`, `beta`) tracks the agent's success rate; the Gamma half (`kappa`, `tau`) tracks its
mean cost in micro-USD. `density` combines the two into the quantity the router ranks agents by: expected
success per micro-USD spent.

The bottom half is the SQL side: it turns the money ledger
(`mergit_cp/money.py`'s `money_events`) and sealed jobs (`jobs.cost_micros`) into an append-only log,
`reputation_observations`, and folds that log into `reputation_posteriors`, one row per (agent, category)
plus one agent-level row per agent (`category = '*'`). `ingest_due` is the only writer of either table;
everything else here only reads.

Nothing here reaches into the task graph or the money ledger's own Python module -- it reads
`money_events`, `jobs`, `task_dispatches`, `tasks` and `plans` with its own SQL, but imports none of
`money.py`, `dispatch.py`, `outcomes.py`, `graph.py` or `plans.py`, and writes none of their tables
(`tests/test_reputation_store.py::test_reputation_writes_only_its_tables`).

`gamma` is fixed by the paper at 0.95 (this plan's Global Constraints): every fold through
`with_outcome`/`with_cost` on the SQL side uses `_GAMMA`, not a configurable value -- `gamma` stays a
parameter on the pure functions only because Task 2's own tests exercise other values.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, LiteralString, cast

from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from .config import Settings
from .db import Pool

log = logging.getLogger(__name__)

_GAMMA = 0.95
"""Fixed by the paper (this plan's Global Constraints), not a deployment choice."""


@dataclass(frozen=True)
class Posterior:
    alpha: float
    beta: float
    kappa: float
    tau: float

    def __post_init__(self) -> None:
        if self.alpha <= 0 or self.beta <= 0 or self.kappa <= 0 or self.tau <= 0:
            raise ValueError(
                "Posterior fields must all be strictly positive, "
                f"got alpha={self.alpha}, beta={self.beta}, kappa={self.kappa}, tau={self.tau}"
            )

    @property
    def theta_mean(self) -> float:
        """Posterior mean success probability."""
        return self.alpha / (self.alpha + self.beta)

    @property
    def cost_mean_micros(self) -> float:
        """Posterior mean cost, in micro-USD."""
        return self.tau / self.kappa

    @property
    def density(self) -> float:
        """The expected validated successes per unit expected spend -- the *mean* of the distribution
        Thompson sampling draws from, not the sampled value itself (paper 8.8). The router (a later task)
        ranks agents by a sample drawn from each posterior, not by this mean: an agent with a wide,
        uncertain posterior can have a low mean density but still get picked because its draw came out
        high."""
        return self.theta_mean / self.cost_mean_micros


def base_prior(prior_cost_micros: int) -> Posterior:
    """The uninformative prior seeded for an agent with no history: Beta(1, 1), Gamma(1, prior_cost)."""
    return Posterior(1, 1, 1, prior_cost_micros)


def with_outcome(p: Posterior, success: bool, weight: float, gamma: float) -> Posterior:
    """Fold one task outcome into the Beta half, decaying prior evidence by `gamma` (paper 8.3-8.4).

    `gamma < 1` makes old evidence count for less than new evidence, so a posterior tracks an agent whose
    true success rate drifts over time rather than averaging over its whole history equally.
    """
    if success:
        alpha, beta = gamma * p.alpha + weight, gamma * p.beta
    else:
        alpha, beta = gamma * p.alpha, gamma * p.beta + weight
    return Posterior(alpha, beta, p.kappa, p.tau)


def with_cost(p: Posterior, cost_micros: int, gamma: float) -> Posterior:
    """Fold one observed cost into the Gamma half, decaying prior evidence by `gamma` (paper 8.3-8.4).

    Raises ValueError when `cost_micros` is not strictly positive: a non-positive cost cannot be a real
    observation (the sealed cost on a job row is always positive once a task actually ran).
    """
    if cost_micros <= 0:
        raise ValueError(f"cost_micros must be positive, got {cost_micros}")
    kappa, tau = gamma * p.kappa + 1, gamma * p.tau + cost_micros
    return Posterior(p.alpha, p.beta, kappa, tau)


def pooled_prior(agent_level: Posterior | None, base: Posterior, w: float) -> Posterior:
    """The prior a router falls back on before an agent has strong agent-level evidence (paper 8.5).

    With no agent-level posterior, that's just `base` (the global, uninformative prior). Otherwise it
    keeps the agent-level posterior's mean (both the success rate and the mean cost) but gives it strength
    `w` times the agent-level evidence, floored at the base prior's own strength -- `w * Beta(1, 1)` would
    be a U-shaped prior that Thompson draws near 0 or 1, which is worse than no agent-level evidence at
    all. The cost side mirrors this exactly: `k0 = max(base.kappa, w * agent_level.kappa)`, and `tau0` is
    picked so the pooled posterior's mean cost equals the agent-level posterior's mean cost
    (`tau0 = k0 * agent_level.cost_mean_micros`), the same way the Beta side preserves `theta_mean`.
    """
    if agent_level is None:
        return base
    n0 = max(base.alpha + base.beta, w * (agent_level.alpha + agent_level.beta))
    mean = agent_level.theta_mean
    new_alpha, new_beta = mean * n0, (1 - mean) * n0
    k0 = max(base.kappa, w * agent_level.kappa)
    tau0 = k0 * agent_level.cost_mean_micros
    return Posterior(new_alpha, new_beta, k0, tau0)


def update_weight(budget_usdc_units: int, value_ref: int, prior_from_requester: int) -> float:
    """How much one outcome from this task should count, relative to a full-weight (weight 1) update
    (paper 8.7): a value term, scaling down for a small budget, times a concentration discount, scaling
    down for a requester who has already supplied `prior_from_requester` outcomes for this agent.

    Predicate strength is folded in as 1 (not a separate factor) because v0 has one predicate kind
    (`exec/0`), and `check_predicate` already refuses predicates that cannot fail -- there is no weaker
    and stronger predicate to tell apart yet.
    """
    return min(1.0, budget_usdc_units / value_ref) / (1 + prior_from_requester)


# --- SQL side: the observation log and the posteriors folded from it -----------------------------------

_OUTCOME_CANDIDATES = """
WITH earliest AS (
    -- A task can carry more than one verdict.recorded row (a redelivery under a different tx, or a
    -- genuine double-send); only the first validated verdict is ever this task's outcome.
    SELECT DISTINCT ON (m.task_id) m.id, m.task_id, m.verdict
    FROM money_events m
    WHERE m.kind = 'verdict.recorded' AND m.verdict IN ('pass', 'fail')
    ORDER BY m.task_id, m.id
)
SELECT e.id, e.task_id, e.verdict, d.agent_id, p.category, p.requester, t.budget_usdc_units
FROM earliest e
JOIN task_dispatches d ON d.task_id = e.task_id
-- A task this service no longer has a definition for (its `tasks` row is gone) has no budget to weigh
-- the outcome by -- it is skipped, not an error, the same way an unknown task is skipped elsewhere.
JOIN tasks t ON t.plan_uuid = d.plan_uuid AND t."index" = d."index"
JOIN plans p ON p.plan_uuid = d.plan_uuid
WHERE p.funding = 'wallet'
  -- An agent with no known operator never consumes a LIMIT slot: without this, 50 permanently-unresolvable
  -- candidates at the head of the id order would stall every newer, real event behind them forever.
  AND d.agent_id = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM reputation_observations ro WHERE ro.kind = 'outcome' AND ro.task_id = e.task_id
  )
ORDER BY e.id
LIMIT %(limit)s
"""

_COST_CANDIDATES = """
SELECT j.task_id, d.agent_id, p.category, p.requester, j.cost_micros
FROM jobs j
JOIN task_dispatches d ON d.task_id = j.task_id
JOIN plans p ON p.plan_uuid = d.plan_uuid
WHERE j.cost_micros > 0 AND j.receipt_root IS NOT NULL AND p.funding = 'wallet'
  AND d.agent_id = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM reputation_observations ro WHERE ro.kind = 'cost' AND ro.task_id = j.task_id
  )
  -- A falsified receipt's own claimed cost must not feed any posterior either, not just its outcome
  -- (controller ruling, fix round 1). Forward-looking only: this does not retroactively unwind a cost
  -- observation already folded into a posterior before a late-arriving falsification verdict -- that
  -- residual gap is acceptable and matches the paper's own "mitigates rather than eliminates" stance on
  -- manipulation resistance (paper 7.8, 8.7).
  AND NOT EXISTS (
      SELECT 1 FROM money_events m
      WHERE m.task_id = j.task_id
        AND ((m.kind = 'verdict.recorded' AND m.verdict = 'invalid')
             OR (m.kind = 'challenge.resolved' AND m.upheld = true))
  )
ORDER BY j.task_id
LIMIT %(limit)s
"""

_FALSIFICATION_CANDIDATES = """
WITH earliest AS (
    SELECT DISTINCT ON (m.task_id) m.id, m.task_id
    FROM money_events m
    WHERE (m.kind = 'verdict.recorded' AND m.verdict = 'invalid')
       OR (m.kind = 'challenge.resolved' AND m.upheld = true)
    ORDER BY m.task_id, m.id
)
SELECT e.task_id, d.agent_id, p.category, p.requester
FROM earliest e
JOIN task_dispatches d ON d.task_id = e.task_id
JOIN plans p ON p.plan_uuid = d.plan_uuid
WHERE p.funding = 'wallet'
  AND d.agent_id = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM reputation_observations ro WHERE ro.kind = 'falsification' AND ro.task_id = e.task_id
  )
ORDER BY e.id
LIMIT %(limit)s
"""


async def _ingest_outcomes(
    conn: AsyncConnection[TupleRow], settings: Settings, operators: Mapping[str, str], limit: int
) -> int:
    cur = await conn.execute(_OUTCOME_CANDIDATES, {"agent_ids": list(operators.keys()), "limit": limit})
    candidates = await cur.fetchall()
    if not candidates:
        return 0
    pairs = {(agent_id, requester) for _, _, _, agent_id, _, requester, _ in candidates}
    counts: dict[tuple[str, str], int] = dict.fromkeys(pairs, 0)
    agent_ids = [a for a, _ in pairs]
    requesters = [r for _, r in pairs]
    cur = await conn.execute(
        "SELECT agent_id, requester, count(*) FROM reputation_observations"
        " WHERE kind = 'outcome' AND agent_id = ANY(%s) AND requester = ANY(%s)"
        " GROUP BY agent_id, requester",
        (agent_ids, requesters),
    )
    for agent_id, requester, n in await cur.fetchall():
        if (agent_id, requester) in counts:
            counts[(agent_id, requester)] = n
    placeholders: list[str] = []
    values: list[Any] = []
    for _, task_id, verdict, agent_id, category, requester, budget in candidates:
        # The SQL above already filters to d.agent_id = ANY(operators), so this is unreachable in correct
        # operation; kept as a defensive guard, not a reachable control path.
        operator = operators.get(agent_id)
        if operator is None:
            log.warning("outcome for task %s: agent %s has no known operator; skipped", task_id, agent_id)
            continue
        pair = (agent_id, requester)
        weight = update_weight(budget, settings.reputation_value_ref_usdc_units, counts[pair])
        counts[pair] += 1
        placeholders.append("(%s, %s, %s, %s, %s, %s, %s, %s)")
        values += ["outcome", task_id, agent_id, operator, category, requester, verdict == "pass", weight]
    if not placeholders:
        return 0
    query = (
        "INSERT INTO reputation_observations"  # noqa: S608 -- placeholders are counts, not values
        " (kind, task_id, agent_id, operator, category, requester, success, weight)"
        " VALUES " + ", ".join(placeholders) + " ON CONFLICT (kind, task_id) DO NOTHING RETURNING id"
    )
    cur = await conn.execute(cast(LiteralString, query), values)
    return len(await cur.fetchall())


async def _ingest_costs(conn: AsyncConnection[TupleRow], operators: Mapping[str, str], limit: int) -> int:
    cur = await conn.execute(_COST_CANDIDATES, {"agent_ids": list(operators.keys()), "limit": limit})
    candidates = await cur.fetchall()
    if not candidates:
        return 0
    placeholders: list[str] = []
    values: list[Any] = []
    for task_id, agent_id, category, requester, cost_micros in candidates:
        # The SQL above already filters to d.agent_id = ANY(operators), so this is unreachable in correct
        # operation; kept as a defensive guard, not a reachable control path.
        operator = operators.get(agent_id)
        if operator is None:
            log.warning("cost for task %s: agent %s has no known operator; skipped", task_id, agent_id)
            continue
        placeholders.append("(%s, %s, %s, %s, %s, %s, %s)")
        values += ["cost", task_id, agent_id, operator, category, requester, cost_micros]
    if not placeholders:
        return 0
    query = (
        "INSERT INTO reputation_observations (kind, task_id, agent_id, operator, category, requester,"  # noqa: S608 -- placeholders are counts, not values
        " cost_micros) VALUES " + ", ".join(placeholders) + " ON CONFLICT (kind, task_id) DO NOTHING"
        " RETURNING id"
    )
    cur = await conn.execute(cast(LiteralString, query), values)
    return len(await cur.fetchall())


async def _ingest_falsifications(
    conn: AsyncConnection[TupleRow], operators: Mapping[str, str], limit: int
) -> int:
    cur = await conn.execute(_FALSIFICATION_CANDIDATES, {"agent_ids": list(operators.keys()), "limit": limit})
    candidates = await cur.fetchall()
    if not candidates:
        return 0
    placeholders: list[str] = []
    values: list[Any] = []
    for task_id, agent_id, category, requester in candidates:
        # The SQL above already filters to d.agent_id = ANY(operators), so this is unreachable in correct
        # operation; kept as a defensive guard, not a reachable control path.
        operator = operators.get(agent_id)
        if operator is None:
            log.warning(
                "falsification for task %s: agent %s has no known operator; skipped", task_id, agent_id
            )
            continue
        placeholders.append("(%s, %s, %s, %s, %s, %s)")
        values += ["falsification", task_id, agent_id, operator, category, requester]
    if not placeholders:
        return 0
    query = (
        "INSERT INTO reputation_observations (kind, task_id, agent_id, operator, category, requester)"  # noqa: S608 -- placeholders are counts, not values
        " VALUES " + ", ".join(placeholders) + " ON CONFLICT (kind, task_id) DO NOTHING RETURNING id"
    )
    cur = await conn.execute(cast(LiteralString, query), values)
    return len(await cur.fetchall())


@dataclass
class _Entry:
    """One (agent_id, category) posterior as it is folded across a batch of observations, in memory."""

    posterior: Posterior
    outcomes: int = 0
    costs: int = 0


async def _replay(
    rows: Sequence[tuple[str, str, str, bool | None, int | None, float | None]],
    settings: Settings,
    seed: Callable[[str, str], Awaitable[_Entry | None]],
) -> dict[tuple[str, str], _Entry]:
    """Fold `rows` (kind, agent_id, category, success, cost_micros, weight), in the order given, into
    posteriors -- the one piece of logic both `ingest_due`'s incremental apply step and `rebuild`'s full
    replay share, so the two can never drift apart from each other.

    `seed(agent_id, category)` supplies a key's starting `_Entry` the first time this replay touches it
    (the current `reputation_posteriors` row, for the incremental path; always `None`, for a from-scratch
    replay). Absent a seed, a fresh `'*'` row is `base_prior`, and a fresh category row is pooled from
    whatever the `'*'` row is *at that point in the replay* (paper 8.5) -- falling back to `base_prior`
    itself when even that is fresh.
    """
    entries: dict[tuple[str, str], _Entry] = {}

    async def ensure(agent_id: str, category: str) -> _Entry:
        key = (agent_id, category)
        if key in entries:
            return entries[key]
        existing = await seed(agent_id, category)
        if existing is not None:
            entry = existing
        elif category == "*":
            entry = _Entry(base_prior(settings.router_prior_cost_micros))
        else:
            agent_entry = await ensure(agent_id, "*")
            pooled = pooled_prior(
                agent_entry.posterior,
                base_prior(settings.router_prior_cost_micros),
                settings.reputation_pooling_weight,
            )
            entry = _Entry(pooled)
        entries[key] = entry
        return entry

    for kind, agent_id, category, success, cost_micros, weight in rows:
        if kind == "falsification":
            # A proven false receipt never updates a capability posterior (paper 7.5 iii): it only ever
            # feeds `in_probation`, which reads the log directly, not these folded rows.
            continue
        agent_entry = await ensure(agent_id, "*")
        cat_entry = await ensure(agent_id, category)
        if kind == "outcome":
            assert success is not None and weight is not None
            agent_entry.posterior = with_outcome(agent_entry.posterior, success, weight, _GAMMA)
            cat_entry.posterior = with_outcome(cat_entry.posterior, success, weight, _GAMMA)
            agent_entry.outcomes += 1
            cat_entry.outcomes += 1
        else:
            assert cost_micros is not None
            agent_entry.posterior = with_cost(agent_entry.posterior, cost_micros, _GAMMA)
            cat_entry.posterior = with_cost(cat_entry.posterior, cost_micros, _GAMMA)
            agent_entry.costs += 1
            cat_entry.costs += 1
    return entries


async def _seed_from_posteriors(
    conn: AsyncConnection[TupleRow], agent_id: str, category: str
) -> _Entry | None:
    cur = await conn.execute(
        "SELECT alpha, beta, kappa, tau, outcomes, costs FROM reputation_posteriors"
        " WHERE agent_id = %s AND category = %s",
        (agent_id, category),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    alpha, beta, kappa, tau, outcomes, costs = row
    return _Entry(Posterior(alpha, beta, kappa, tau), outcomes, costs)


async def _apply_due(conn: AsyncConnection[TupleRow], settings: Settings) -> None:
    """Fold every observation not yet applied into `reputation_posteriors`. Must run with the
    `mergit.reputation` advisory lock already held by the caller (`ingest_due` takes it as its very first
    statement, before any candidate insert) -- see `ingest_due`'s docstring for why that ordering, not
    "lock here", is what makes a high-water-mark `last_id` sound."""
    # The migration seeds this row exactly once; re-create it if it is ever missing (the test suite's own
    # global per-test reset, conftest.py's `client` fixture, truncates every public table between tests,
    # this one included -- same reasoning as the append-only trigger's own comment above).
    await conn.execute(
        "INSERT INTO reputation_applied (one, last_id) VALUES (true, 0) ON CONFLICT (one) DO NOTHING"
    )
    cur = await conn.execute("SELECT last_id FROM reputation_applied")
    row = await cur.fetchone()
    assert row is not None  # guaranteed by the INSERT just above
    last_id: int = row[0]
    cur = await conn.execute(
        "SELECT id, kind, agent_id, category, success, cost_micros, weight"
        " FROM reputation_observations WHERE id > %s ORDER BY id",
        (last_id,),
    )
    rows = await cur.fetchall()
    if not rows:
        return
    observed = [row[1:] for row in rows]  # drop the id column; _replay only needs it for ordering
    entries = await _replay(
        observed, settings, lambda agent_id, category: _seed_from_posteriors(conn, agent_id, category)
    )
    for (agent_id, category), entry in entries.items():
        await conn.execute(
            "INSERT INTO reputation_posteriors (agent_id, category, alpha, beta, kappa, tau, outcomes, costs)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (agent_id, category) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta,"
            " kappa = excluded.kappa, tau = excluded.tau, outcomes = excluded.outcomes,"
            " costs = excluded.costs",
            (
                agent_id,
                category,
                entry.posterior.alpha,
                entry.posterior.beta,
                entry.posterior.kappa,
                entry.posterior.tau,
                entry.outcomes,
                entry.costs,
            ),
        )
    await conn.execute("UPDATE reputation_applied SET last_id = %s", (rows[-1][0],))


async def ingest_due(
    conn: AsyncConnection[TupleRow], settings: Settings, operators: Mapping[str, str], limit: int = 50
) -> int:
    """Insert new observations (outcome/cost/falsification) from `money_events` and `jobs`, for
    wallet-funded plans only (invariant 6: a credits-funded plan yields no observation at all), then fold
    every unapplied observation into the posterior rows. Returns how many new observations were inserted
    (not how many were applied -- an observation inserted by a concurrent, still-uncommitted updater is
    counted there, not here).

    Each of the three sources is capped at `limit` candidates per call; a deployment with more than `limit`
    outstanding events of one kind catches up over a few polls rather than in one unbounded pass.

    The advisory lock is taken here, as the very first statement, before any candidate `SELECT`/`INSERT` --
    not inside `_apply_due`, after them (fix round 1: a reviewer-traced bug). `reputation_observations.id`
    is a bare `bigserial`: two concurrent calls can allocate ids out of commit order (the one that allocates
    the *higher* id can still commit *first*). A high-water-mark `last_id` is only sound if id allocation
    itself happens in lock order -- otherwise the call that commits first can advance `last_id` past an id a
    still-in-flight call already allocated for a row it hasn't committed yet, permanently stranding that row
    below the new `last_id` once it does commit (`id > last_id` excludes it forever, independent of MVCC
    visibility -- a plain numeric comparison bug, not a visibility race). Locking before allocation forces
    every concurrent `ingest_due` call to run its entire insert-then-apply-then-commit cycle one at a time.
    """
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext('mergit.reputation'))")
    inserted = await _ingest_outcomes(conn, settings, operators, limit)
    inserted += await _ingest_costs(conn, operators, limit)
    inserted += await _ingest_falsifications(conn, operators, limit)
    await _apply_due(conn, settings)
    return inserted


async def posterior(
    conn: AsyncConnection[TupleRow], agent_id: str, category: str, settings: Settings
) -> Posterior:
    """The posterior a router should use for this agent and category: the category row if one exists,
    else pooled from the agent-level row (or `base_prior`, if even that does not exist yet -- `pooled_prior`
    already does this itself when `agent_level is None`)."""
    cur = await conn.execute(
        "SELECT alpha, beta, kappa, tau FROM reputation_posteriors WHERE agent_id = %s AND category = %s",
        (agent_id, category),
    )
    row = await cur.fetchone()
    if row is not None:
        return Posterior(*row)
    cur = await conn.execute(
        "SELECT alpha, beta, kappa, tau FROM reputation_posteriors WHERE agent_id = %s AND category = '*'",
        (agent_id,),
    )
    agent_row = await cur.fetchone()
    agent_level = Posterior(*agent_row) if agent_row is not None else None
    return pooled_prior(
        agent_level, base_prior(settings.router_prior_cost_micros), settings.reputation_pooling_weight
    )


async def rebuild(conn: AsyncConnection[TupleRow], settings: Settings) -> dict[tuple[str, str], Posterior]:
    """Replay the whole `reputation_observations` log in memory from scratch (ignoring `reputation_applied`
    and `reputation_posteriors` entirely) and return what every (agent_id, category) posterior would be.
    Writes nothing. Used only by tests, to check the incremental updater agrees with a full replay.

    No `operators` parameter: each `reputation_observations` row already stores its own `operator` value
    from ingest time, so a replay never needs to look it up again.
    """
    cur = await conn.execute(
        "SELECT kind, agent_id, category, success, cost_micros, weight"
        " FROM reputation_observations ORDER BY id"
    )
    rows = await cur.fetchall()

    async def no_seed(agent_id: str, category: str) -> _Entry | None:
        del agent_id, category
        return None

    entries = await _replay(rows, settings, no_seed)
    return {key: entry.posterior for key, entry in entries.items()}


async def in_probation(
    conn: AsyncConnection[TupleRow], operator: str, now: datetime, probation_s: int
) -> bool:
    """True if `operator` has any `falsification` observation within the last `probation_s` seconds
    (paper 7.5 iii: a proven false receipt sets p=1 -- maximal exploration, forcing a fresh draw rather
    than trusting the posterior -- for a probationary period)."""
    cur = await conn.execute(
        "SELECT EXISTS (SELECT 1 FROM reputation_observations"
        " WHERE kind = 'falsification' AND operator = %s AND observed_at > %s)",
        (operator, now - timedelta(seconds=probation_s)),
    )
    row = await cur.fetchone()
    return bool(row and row[0])


class ReputationUpdater:
    """Runs `ingest_due` on a timer, the same shape as `OutcomeProcessor`: a failing pass is logged and
    retried, never fatal, and `run` returns as soon as `stop` is set rather than waiting out a full poll
    interval."""

    def __init__(self, pool: Pool, settings: Settings, operators: Mapping[str, str]) -> None:
        self._pool = pool
        self._settings = settings
        self._operators = operators

    async def ingest_due(self, limit: int = 50) -> int:
        async with self._pool.connection() as conn, conn.transaction():
            return await ingest_due(conn, self._settings, self._operators, limit)

    async def run(self, poll_s: float, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.ingest_due()
            except Exception:
                log.exception("reputation ingestion pass failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_s)
