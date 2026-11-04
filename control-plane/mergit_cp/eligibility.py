"""Which roster agents a suggestion must leave out, and why (paper §7.5 ii and iii). Read-only.

Two rules, both per operator rather than per agent, since an operator running several agents can defect
across all of them at once:

* **Probation** (``IN_PROBATION``). An operator is in probation while any task dispatched to any of its
  agents has a proven falsification less than ``routing_probation_s`` old. A falsification is a
  ``money_events`` row with ``kind = 'verdict.recorded' AND verdict = 'invalid'`` or
  ``kind = 'challenge.resolved' AND upheld``, timed by its ``received_at``. A task is falsified once: the
  window runs from the first such row for it, so a second ruling on the same false receipt does not restart
  it. The plan's funding does not matter. Invariant 6 keeps free-credit work out of the posteriors because
  it must not *earn* reputation; a proven false receipt earns nothing, it is evidence of fraud, and
  ignoring it on a credits plan would let an operator forge where the stakes are lowest and stay suggested
  where they are highest. A validated failure (``verdict = 'fail'``) is not a falsification: it is a
  capability signal, and the posteriors already carry it.
* **The concurrency cap** (``AT_CAP``). An operator is at cap while its agents hold, between them, at least
  ``routing_operator_concurrency_cap`` unresolved wallet-funded dispatches. Only wallet-funded ones count,
  unlike probation: invariant 6 says free-credit work must not influence routing, and here it could do so
  cheaply and on purpose, since anyone with a credits grant could send a few plans to a rival operator's
  agents and have its whole roster shown as at cap to everyone. A paid dispatch costs its requester the
  escrow, so holding an operator's capacity is not free. Unresolved means a ``task_dispatches`` row with no
  ``task.released`` or ``task.returned`` row yet, except:

  - a dispatch whose ``jobs`` row has ``status = 'error' AND receipt_root IS NULL``: nothing was sealed for
    that attempt, so there is nothing to forge and nothing in flight, though its escrow only comes back
    on the chain's own deadline;
  - a dispatch with no ``jobs`` row at all that is older than ``dispatch.DISPATCH_DEADLINE_S``: it never
    escrowed and never will (the gateway rejected it, or the outbox gave up), and since nothing will ever
    arrive to resolve it, it would otherwise count against its operator forever. Reusing the dispatch's own
    deadline means it stops counting exactly when the dispatch itself gives up. One still within its
    deadline is a real in-flight commitment and counts.

Probation is checked first, so an operator that is both reports ``IN_PROBATION``. The cap is not relaxed
during probation (paper §7.5 iii); here that is moot, since either one already leaves the agent out.

Which operator an agent belongs to comes from the roster passed in, the same one the suggestions are for:
a dispatch or falsification by an agent no longer on the roster counts toward no operator.

Ported from the reviewed ``in_probation`` and ``_UNRESOLVED_BY_AGENT`` on ``archive/auto-dispatch-routing``.
That branch read probation from its own ``reputation_observations`` log; this one has none, so it reads
``money_events`` through ``task_dispatches`` directly, with the same rule.
"""

from datetime import datetime, timedelta

from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from .agents import Agent
from .config import Settings
from .dispatch import DISPATCH_DEADLINE_S

IN_PROBATION = "operator in probation"
AT_CAP = "operator at concurrency cap"
"""The reasons ``ineligible`` gives. Both are transient: each clears on its own as time passes or as
dispatches resolve."""

# The agents among `agent_ids` with a task whose first falsification was received after `since`.
_FALSIFIED_AGENTS = """
SELECT DISTINCT d.agent_id
FROM task_dispatches d
WHERE d.agent_id = ANY(%(agent_ids)s)
  AND (
      SELECT min(m.received_at) FROM money_events m
      WHERE m.task_id = d.task_id
        AND ((m.kind = 'verdict.recorded' AND m.verdict = 'invalid')
             OR (m.kind = 'challenge.resolved' AND m.upheld))
  ) > %(since)s
"""

# Unresolved wallet-funded dispatches per agent; `ineligible` sums them per operator. `jobs.task_id` is its
# primary key, so the join adds at most one row per dispatch, and `j.status IS NULL` is only true when no
# `jobs` row exists at all (a dispatch that did escrow always has one, whatever its later status).
_UNRESOLVED_BY_AGENT = """
SELECT d.agent_id, count(*)
FROM task_dispatches d
JOIN plans p ON p.plan_uuid = d.plan_uuid AND p.funding = 'wallet'
LEFT JOIN jobs j ON j.task_id = d.task_id
WHERE d.agent_id = ANY(%(agent_ids)s)
  AND NOT EXISTS (
      SELECT 1 FROM money_events m
      WHERE m.task_id = d.task_id AND m.kind IN ('task.released', 'task.returned')
  )
  AND NOT COALESCE(j.status = 'error' AND j.receipt_root IS NULL, false)
  AND NOT (j.status IS NULL AND d.dispatched_at < %(stale_before)s)
GROUP BY d.agent_id
"""


async def ineligible(
    conn: AsyncConnection[TupleRow], agents: list[Agent], settings: Settings, now: datetime
) -> dict[str, str]:
    """Every agent in ``agents`` that must be left out of a suggestion at ``now``, mapped to the reason.
    An agent that may be suggested, as far as these two rules go, is absent: presence means excluded."""
    if not agents:
        return {}
    agent_ids = [a.agent_id for a in agents]

    cur = await conn.execute(
        _FALSIFIED_AGENTS,
        {"agent_ids": agent_ids, "since": now - timedelta(seconds=settings.routing_probation_s)},
    )
    falsified = {row[0] for row in await cur.fetchall()}
    in_probation = {a.operator for a in agents if a.agent_id in falsified}

    cur = await conn.execute(
        _UNRESOLVED_BY_AGENT,
        {"agent_ids": agent_ids, "stale_before": now - timedelta(seconds=DISPATCH_DEADLINE_S)},
    )
    unresolved_by_agent: dict[str, int] = {agent_id: count for agent_id, count in await cur.fetchall()}
    unresolved_by_operator: dict[str, int] = {}
    for a in agents:
        count = unresolved_by_agent.get(a.agent_id, 0)
        unresolved_by_operator[a.operator] = unresolved_by_operator.get(a.operator, 0) + count

    out: dict[str, str] = {}
    for a in agents:
        if a.operator in in_probation:
            out[a.agent_id] = IN_PROBATION
        elif unresolved_by_operator[a.operator] >= settings.routing_operator_concurrency_cap:
            out[a.agent_id] = AT_CAP
    return out
