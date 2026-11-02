"""Reputation, derived: every posterior here can be rebuilt from the money ledger and the recorded costs.

Three steps, none of which writes anything the others do not own:

1. ``task_outcomes`` (a view, migrations 0015 and 0019) says which tasks are validated outcomes: audited, or
   challenged and adjudicated. Only those count (invariant 4); a release nobody audited or challenged, or a
   deadline return, is not evidence.
2. ``record_missing_costs`` copies each such task's metered cost from the gateway's on-chain commitment
   into ``task_costs``, once. A cost that cannot be read yet leaves the outcome pending; it is never taken
   as zero.
3. ``refresh_posteriors`` folds the counted outcomes, oldest first, into ``agent_posteriors``. Work funded
   from free credits is kept out of the fold (invariant 6: faucet-tier work accrues no transferable
   reputation).

The posteriors are recomputed from the ledger rather than updated in place, so an outcome that is overturned
later, or a cost that arrives late, can never leave a posterior that disagrees with a rebuild. A pass over the
few outcomes there are is cheap; if that stops being true the fold can be made incremental per agent and
category without changing what it computes.

Nothing here touches the task graph: it reads ``money_events``, ``task_costs`` and the plan's funding and
category, and writes ``task_costs`` and ``agent_posteriors``.
"""

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, cast

import httpx

from .config import Settings
from .db import Pool
from .reputation_model import Params, Posterior

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class AgentCategory:
    agent_id: str
    category: str


class GatewayUnavailable(Exception):
    """The gateway cannot be asked right now: unreachable, failing, refusing us, or not answering with a list
    of commitments. Every task would get the same answer, so the pass stops and tries again next time."""


class BadCommitment(ValueError):
    """The gateway's answer about this one task cannot be used (another task's commitment, a cost that is not
    a non-negative integer, a row that is not an object, a request refused for this task id). Other tasks are
    not affected, so the pass goes on to them."""


class GatewayCosts:
    """Reads a task's committed cost from the gateway (``GET /v0/commitments?task_id=``)."""

    def __init__(
        self, base_url: str, *, timeout_s: float = 5.0, client: httpx.AsyncClient | None = None
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/v0/commitments"
        self._http = client or httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def cost_micros(self, task_id: str) -> int | None:
        """The cost in USDC micros, or None when the gateway has not seen the commitment yet. Raises
        ``GatewayUnavailable`` when the gateway as a whole cannot answer, ``BadCommitment`` when its answer
        about this task is unusable."""
        try:
            response = await self._http.get(self._url, params={"task_id": task_id, "limit": 1})
        except httpx.HTTPError as problem:
            raise GatewayUnavailable(f"{type(problem).__name__}: {problem}") from problem
        if response.status_code in (400, 422):  # the gateway refused this task id, not every request
            raise BadCommitment(f"HTTP {response.status_code}")
        if not response.is_success:
            raise GatewayUnavailable(f"HTTP {response.status_code}")
        try:
            rows: object = response.json()
        except ValueError as problem:
            raise GatewayUnavailable("the gateway's answer is not JSON") from problem
        if not isinstance(rows, list):
            raise GatewayUnavailable("the gateway's answer is not a list")
        if not rows:
            return None
        row = cast("list[object]", rows)[0]
        if not isinstance(row, dict):
            raise BadCommitment("the gateway's commitment is not an object")
        fields = cast("dict[str, Any]", row)
        if fields.get("task_id") != task_id:
            raise BadCommitment("the gateway answered with another task's commitment")
        raw = fields.get("cost_micros")
        if not isinstance(raw, str | int) or isinstance(raw, bool):
            raise BadCommitment("the commitment has no cost")
        try:
            cost = int(raw)
        except ValueError as problem:
            raise BadCommitment(f"the cost {raw!r} is not an integer") from problem
        if cost < 0:
            raise BadCommitment("a negative cost")
        return cost


async def record_missing_costs(pool: Pool, costs: GatewayCosts) -> int:
    """Writes ``task_costs`` for counted outcomes that lack one. Returns how many were written.

    Every pending outcome is tried, oldest first, in one pass. A task whose commitment is not there yet, or
    whose answer is unusable, is left for the next pass and does not hold back the tasks after it (a
    commitment that never arrives must not block every newer outcome). Only a gateway that cannot answer at
    all ends the pass early, since every remaining task would fail the same way."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT task_id FROM task_outcomes WHERE cost_micros IS NULL ORDER BY position"
        )
        pending = [row[0] for row in await cur.fetchall()]
    written = 0
    for task_id in pending:
        try:
            cost = await costs.cost_micros(task_id)
        except GatewayUnavailable as problem:
            log.warning("costs not read this pass (%d pending): %s", len(pending), problem)
            break  # the gateway is unwell; do not hammer it for each remaining task
        except BadCommitment as problem:
            log.warning("cost of %s not read: %s", task_id, problem)
            continue
        if cost is None:
            continue
        async with pool.connection() as conn:
            cur = await conn.execute(
                "INSERT INTO task_costs (task_id, cost_micros) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (task_id, cost),
            )
            written += cur.rowcount  # 0 when another instance recorded it first
    return written


async def refresh_posteriors(pool: Pool, settings: Settings) -> int:
    """Rebuilds ``agent_posteriors`` from the counted outcomes. Returns the number of agent-category rows."""
    prior = Posterior.prior(Params(tau0=float(settings.reputation_cost_prior_micros)))
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext('reputation'))")
        # An outcome whose cost is still pending waits (it is never taken as zero). A recorded cost of 0 is a
        # true copy of the commitment: the outcome's success or failure counts like any other, but the cost
        # model needs c > 0 (paper §8.3), so it adds nothing to the cost posterior rather than a made-up cost.
        cur = await conn.execute(
            "SELECT agent_id, category, success, cost_micros FROM task_outcomes"
            " WHERE funding = 'wallet' AND cost_micros IS NOT NULL ORDER BY position, task_id"
        )
        folded: dict[tuple[str, str], Posterior] = {}
        for agent_id, category, success, cost in await cur.fetchall():
            key = (agent_id, category)
            folded[key] = folded.get(key, prior).observe(bool(success), float(cost) if cost > 0 else None)
        await conn.execute("DELETE FROM agent_posteriors")
        for (agent_id, category), p in sorted(folded.items()):
            await conn.execute(
                "INSERT INTO agent_posteriors (agent_id, category, alpha, beta, kappa, tau, n)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (agent_id, category, p.alpha, p.beta, p.kappa, p.tau, p.n),
            )
    return len(folded)


class ReputationUpdater:
    """Runs both steps on a timer, the same shape as ``OutcomeProcessor``: a failing pass is logged and
    retried, never fatal, and ``run`` returns as soon as ``stop`` is set."""

    def __init__(self, pool: Pool, settings: Settings, costs: GatewayCosts) -> None:
        self._pool = pool
        self._settings = settings
        self._costs = costs

    async def update(self) -> None:
        await record_missing_costs(self._pool, self._costs)
        await refresh_posteriors(self._pool, self._settings)

    async def run(self, poll_s: float, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.update()
            except Exception:
                log.exception("reputation pass failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_s)
