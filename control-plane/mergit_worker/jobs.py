"""The job queue as the worker sees it: Postgres rows claimed with `FOR UPDATE SKIP LOCKED`.

All SQL for the worker lives in this file. It relies on the tables of plan tasks O3 and O4; the columns
it reads and writes are listed in `control-plane/README.md` and exercised by `tests/jobs_schema.sql`, so
a change to those tables shows up here as a failing test.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, Protocol, TypeVar, cast

import psycopg
from psycopg.rows import dict_row

from .models import Job, RunOutcome

log = logging.getLogger(__name__)

_T = TypeVar("_T")

_CLAIM = """
WITH next AS (
    SELECT task_id FROM jobs
    WHERE status = 'queued'
    ORDER BY created_at, task_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE jobs SET status = 'running', claimed_by = %(worker)s, claimed_at = now()
FROM next WHERE jobs.task_id = next.task_id
RETURNING jobs.task_id
"""

_LOAD = """
SELECT j.task_id, j.plan_uuid, p.plan_id, j."index", j.attempt, j.agent_id,
       p.requester, p.category, p.repo_url, p.ref, t.title, t.instructions, t.phi,
       t.budget_usdc_units, t.depends_on
FROM jobs j
JOIN plans p ON p.plan_uuid = j.plan_uuid
JOIN tasks t ON t.plan_uuid = j.plan_uuid AND t."index" = j."index"
WHERE j.task_id = %(task_id)s
"""

_DEPENDENCY_PATCHES = """
SELECT "index", patch FROM jobs
WHERE plan_uuid = %(plan_uuid)s AND "index" = ANY(%(indexes)s) AND phi_holds = true AND patch IS NOT NULL
"""

_REPORT = """
UPDATE jobs SET status = %(status)s, phi_holds = %(holds)s, receipt_root = %(root)s,
                notes = %(notes)s, patch = %(patch)s, cost_micros = %(cost_micros)s, finished_at = now()
WHERE task_id = %(task_id)s AND status = 'running' AND claimed_by = %(worker)s
"""

_FAIL_OWN_RUNNING = """
UPDATE jobs SET status = 'error', claimed_by = NULL, claimed_at = NULL,
                notes = 'worker restarted mid-run; a fresh attempt is needed', finished_at = now()
WHERE status = 'running' AND claimed_by = %(worker)s
"""

_RECLAIM_STALE = """
UPDATE jobs SET status = 'error', claimed_by = NULL, claimed_at = NULL,
                notes = 'claim exceeded its lease with no result; a fresh attempt is needed',
                finished_at = now()
WHERE status = 'running' AND claimed_at < now() - make_interval(secs => %(lease_s)s)
"""


class JobStore(Protocol):
    def claim(self) -> Job | None: ...
    def report(self, outcome: RunOutcome) -> None: ...
    def fail(self, task_id: str, message: str) -> None: ...


class PgJobStore:
    """One job row is never silently resumed after a crash: `fail_own_running` and `reclaim_stale` both
    mark an interrupted attempt `error` rather than put it back on the queue under the same `task_id`.
    Resuming would mean re-running the agent loop (paying twice) and re-sealing a bundle that may have
    already reached the store, which the store then refuses as a second bundle for one task. A fresh
    attempt, decided by plan task O6, gets a new `task_id` and a clean run instead.

    Every public method goes through `_retrying`, which reopens the connection once and retries on a
    dropped connection: a worker process runs for a long time, and losing the one connection it holds
    must not be fatal to it.
    """

    def __init__(self, database_url: str, conn: psycopg.Connection[dict[str, Any]], worker_id: str) -> None:
        self._database_url = database_url
        self._conn = conn
        self._worker = worker_id

    @classmethod
    def connect(cls, database_url: str, worker_id: str) -> PgJobStore:
        return cls(database_url, cls._open(database_url), worker_id)

    @staticmethod
    def _open(database_url: str) -> psycopg.Connection[dict[str, Any]]:
        return cast(
            "psycopg.Connection[dict[str, Any]]",
            psycopg.connect(database_url, autocommit=True, row_factory=dict_row),  # pyright: ignore[reportArgumentType]
        )

    def _retrying(self, fn: Callable[[], _T]) -> _T:
        try:
            return fn()
        except (psycopg.OperationalError, psycopg.InterfaceError):
            log.warning("database connection for worker %s was lost; reconnecting", self._worker)
            self._conn = self._open(self._database_url)
            return fn()

    def fail_own_running(self) -> int:
        """At start-up: a `running` job claimed under this worker id was left by a crashed process of
        the same worker. A worker never touches another worker's jobs here; `reclaim_stale` covers one
        that died under a different id."""

        def run() -> int:
            return self._conn.execute(_FAIL_OWN_RUNNING, {"worker": self._worker}).rowcount

        return self._retrying(run)

    def reclaim_stale(self, lease_s: float) -> int:
        """At start-up: a `running` job whose claim is older than `lease_s`, under any worker id, is
        presumed abandoned (the process that claimed it is gone and never requeued it itself)."""
        return self._retrying(lambda: self._conn.execute(_RECLAIM_STALE, {"lease_s": lease_s}).rowcount)

    def claim(self) -> Job | None:
        return self._retrying(self._claim_once)

    def _claim_once(self) -> Job | None:
        with self._conn.transaction():
            claimed = self._conn.execute(_CLAIM, {"worker": self._worker}).fetchone()
            if claimed is None:
                return None
            row = self._conn.execute(_LOAD, {"task_id": claimed["task_id"]}).fetchone()
            depends_on: list[int] = []
            patches: dict[int, str] = {}
            if row is not None:  # the plan or task row is missing: put nothing back, surface it
                depends_on = [int(i) for i in row["depends_on"]]
                if depends_on:
                    patches = {
                        int(r["index"]): r["patch"]
                        for r in self._conn.execute(
                            _DEPENDENCY_PATCHES, {"plan_uuid": row["plan_uuid"], "indexes": depends_on}
                        ).fetchall()
                    }
        if row is None:
            self.fail(claimed["task_id"], "job has no plan or task row")
            return None
        return Job(
            task_id=row["task_id"],
            plan_uuid=str(row["plan_uuid"]),
            plan_id=row["plan_id"],
            index=row["index"],
            attempt=row["attempt"],
            agent_id=str(row["agent_id"]),
            requester=row["requester"],
            category=row["category"],
            repo_url=row["repo_url"],
            ref=row["ref"],
            title=row["title"],
            instructions=row["instructions"],
            phi=row["phi"],
            budget_usdc_units=int(row["budget_usdc_units"]),
            depends_on=tuple(depends_on),
            # "" (not a dependency's own absence) means that attempt made no tracked change to apply.
            dependency_patches=tuple(patches.get(i, "") for i in depends_on),
        )

    def report(self, outcome: RunOutcome) -> None:
        """Store the Φ result (`holds` is None when Φ could not run) on the job row for O6."""
        self._finish(
            outcome.task_id,
            "done",
            outcome.holds,
            outcome.root,
            "; ".join(outcome.notes),
            outcome.patch,
            outcome.cost_micros,
        )

    def fail(self, task_id: str, message: str) -> None:
        """The task could not be run or sealed. `phi_holds` stays NULL: inconclusive, a person decides.
        There is no sealed cost to record from this path, so `cost_micros` stays NULL too."""
        self._finish(task_id, "error", None, None, message[:2000], None, None)

    def _finish(
        self,
        task_id: str,
        status: str,
        holds: bool | None,
        root: str | None,
        notes: str,
        patch: str | None,
        cost_micros: int | None,
    ) -> None:
        self._retrying(
            lambda: self._conn.execute(
                _REPORT,
                {
                    "task_id": task_id,
                    "status": status,
                    "holds": holds,
                    "root": root,
                    "notes": notes,
                    "patch": patch,
                    "cost_micros": cost_micros,
                    "worker": self._worker,
                },
            )
        )

    def close(self) -> None:
        self._conn.close()
