"""Job queue against a real Postgres (testcontainers). Run with `pytest -m postgres`."""

from __future__ import annotations

import json
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import mergit_receipt
import psycopg
import pytest
from psycopg.rows import dict_row
from testcontainers.community.postgres import PostgresContainer

from mergit_worker.jobs import PgJobStore
from mergit_worker.models import RunOutcome
from tests.support import REQUESTER, phi

pytestmark = pytest.mark.postgres
SCHEMA = (Path(__file__).parent / "jobs_schema.sql").read_text()


@pytest.fixture(scope="module")
def dsn() -> Iterator[str]:
    with PostgresContainer("postgres:16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(SCHEMA)
        yield url


@pytest.fixture
def db(dsn: str) -> Iterator[psycopg.Connection[dict[str, Any]]]:
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:  # type: ignore[arg-type]
        conn.execute("TRUNCATE jobs, tasks, plans CASCADE")
        yield conn  # type: ignore[misc]


def seed(
    db: psycopg.Connection[dict[str, Any]],
    n: int = 1,
    agent: str = "1",
    depends_on: dict[int, list[int]] | None = None,
) -> list[str]:
    plan_uuid = str(uuid.uuid4())
    plan_id = mergit_receipt.plan_id(plan_uuid)
    db.execute(
        "INSERT INTO plans VALUES (%s, %s, %s, 'https://x/y.git', 'main', 'test-repair')",
        (plan_uuid, plan_id, REQUESTER),
    )
    depends_on = depends_on or {}
    ids: list[str] = []
    for i in range(n):
        task_id = mergit_receipt.task_id(plan_id, i, 1)
        db.execute(
            'INSERT INTO tasks (plan_uuid, "index", title, instructions, phi, budget_usdc_units, depends_on)'
            " VALUES (%s, %s, 't', 'do it', %s, 1000000, %s)",
            (plan_uuid, i, json.dumps(phi()), depends_on.get(i, [])),
        )
        db.execute(
            'INSERT INTO jobs (task_id, plan_uuid, "index", attempt, agent_id) VALUES (%s,%s,%s,1,%s)',
            (task_id, plan_uuid, i, agent),
        )
        ids.append(task_id)
    return ids


def test_claim_returns_the_joined_job_and_marks_it_running(dsn: str, db: Any):
    (task_id,) = seed(db)
    job = PgJobStore.connect(dsn, "w1").claim()
    assert job is not None
    assert job.task_id == task_id
    assert job.plan_id == mergit_receipt.plan_id(job.plan_uuid)
    assert job.phi == phi()
    assert job.budget_usdc_units == 1_000_000
    row = db.execute("SELECT status, claimed_by FROM jobs").fetchone()
    assert (row["status"], row["claimed_by"]) == ("running", "w1")
    assert job.depends_on == ()
    assert job.dependency_patches == ()


def test_claim_includes_the_dependencys_stored_patch(dsn: str, db: Any):
    """A task that depends on another must start from that dependency's actual passing change (plan
    task O4 dispatches it only once that dependency has passed), not the plan's bare base ref."""
    ids = seed(db, n=2, depends_on={1: [0]})
    plan_uuid = db.execute("SELECT plan_uuid FROM jobs WHERE task_id = %s", (ids[0],)).fetchone()["plan_uuid"]
    db.execute(
        "UPDATE jobs SET status = 'done', phi_holds = true, patch = %s WHERE task_id = %s",
        ("diff --git a/x b/x\n@@ -0,0 +1 @@\n+x\n", ids[0]),
    )
    job = PgJobStore.connect(dsn, "w1").claim()
    assert job is not None
    assert job.task_id == ids[1]
    assert job.depends_on == (0,)
    assert job.dependency_patches == ("diff --git a/x b/x\n@@ -0,0 +1 @@\n+x\n",)
    assert plan_uuid is not None  # sanity: the fixture really did seed one plan for both tasks


def test_claim_reports_a_dependency_with_no_change_as_an_empty_patch(dsn: str, db: Any):
    ids = seed(db, n=2, depends_on={1: [0]})
    db.execute("UPDATE jobs SET status = 'done', phi_holds = true WHERE task_id = %s", (ids[0],))
    job = PgJobStore.connect(dsn, "w1").claim()
    assert job is not None
    assert job.dependency_patches == ("",)


def test_claim_ignores_a_dependency_that_has_not_passed_yet(dsn: str, db: Any):
    """Plan task O4's own dispatch rule already stops this from happening in practice, but the worker
    does not trust that: a dependency that failed, or has not finished, contributes no patch."""
    ids = seed(db, n=2, depends_on={1: [0]})
    db.execute(
        "UPDATE jobs SET status = 'done', phi_holds = false, patch = NULL WHERE task_id = %s", (ids[0],)
    )
    job = PgJobStore.connect(dsn, "w1").claim()
    assert job is not None
    assert job.dependency_patches == ("",)


def test_empty_queue(dsn: str, db: Any):
    assert PgJobStore.connect(dsn, "w1").claim() is None


def test_concurrent_workers_never_claim_the_same_job(dsn: str, db: Any):
    ids = set(seed(db, n=30))
    claimed: list[str] = []
    lock = threading.Lock()

    def drain(name: str) -> None:
        store = PgJobStore.connect(dsn, name)
        while (job := store.claim()) is not None:
            with lock:
                claimed.append(job.task_id)

    threads = [threading.Thread(target=drain, args=(f"w{i}",)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(claimed) == len(set(claimed)) == 30  # none lost, none twice
    assert set(claimed) == ids


def test_report_stores_phi_result_on_the_job_row(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.report(RunOutcome(task_id, True, "0xroot", ["finished"]))
    row = db.execute("SELECT status, phi_holds, receipt_root, notes FROM jobs").fetchone()
    assert row == {"status": "done", "phi_holds": True, "receipt_root": "0xroot", "notes": "finished"}


def test_inconclusive_result_is_null_not_false(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.report(RunOutcome(task_id, None, "0xroot", ["llm_error"]))
    assert db.execute("SELECT phi_holds FROM jobs").fetchone()["phi_holds"] is None


def test_fail_marks_error_with_null_result(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.fail(task_id, "boom")
    row = db.execute("SELECT status, phi_holds, notes FROM jobs").fetchone()
    assert (row["status"], row["phi_holds"], row["notes"]) == ("error", None, "boom")


def test_report_stores_cost(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.report(RunOutcome(task_id, True, "0xroot", ["finished"], cost_micros=1234))
    row = db.execute("SELECT cost_micros FROM jobs").fetchone()
    assert row["cost_micros"] == 1234

    (task_id_2,) = seed(db)
    store2 = PgJobStore.connect(dsn, "w1")
    store2.claim()
    store2.fail(task_id_2, "boom")
    row2 = db.execute("SELECT cost_micros FROM jobs WHERE task_id = %s", (task_id_2,)).fetchone()
    assert row2["cost_micros"] is None


def test_another_worker_cannot_overwrite_a_claim(dsn: str, db: Any):
    (task_id,) = seed(db)
    PgJobStore.connect(dsn, "w1").claim()
    PgJobStore.connect(dsn, "w2").report(RunOutcome(task_id, True))
    assert db.execute("SELECT status FROM jobs").fetchone()["status"] == "running"


def test_a_finished_job_is_not_reported_twice(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.report(RunOutcome(task_id, True))
    store.report(RunOutcome(task_id, False))
    assert db.execute("SELECT phi_holds FROM jobs").fetchone()["phi_holds"] is True


def test_fail_own_running_only_touches_this_workers_jobs_and_never_requeues_them(dsn: str, db: Any):
    """A crashed and restarted worker must not silently resume the same task_id: that would pay the
    model twice and the store would refuse a second bundle for one task. The job ends `error` instead,
    for plan task O6 to redispatch as a new attempt with its own task_id."""
    seed(db, n=2)
    PgJobStore.connect(dsn, "w1").claim()
    PgJobStore.connect(dsn, "w2").claim()
    assert PgJobStore.connect(dsn, "w1").fail_own_running() == 1
    rows = {r["claimed_by"]: r["status"] for r in db.execute("SELECT claimed_by, status FROM jobs")}
    assert rows == {None: "error", "w2": "running"}


def test_reclaim_stale_touches_any_workers_claim_past_its_lease(dsn: str, db: Any):
    seed(db, n=2)
    PgJobStore.connect(dsn, "w1").claim()
    PgJobStore.connect(dsn, "w2").claim()
    db.execute("UPDATE jobs SET claimed_at = now() - interval '2 hours' WHERE claimed_by = 'w1'")
    assert PgJobStore.connect(dsn, "w3").reclaim_stale(lease_s=3600) == 1
    rows = {r["claimed_by"]: r["status"] for r in db.execute("SELECT claimed_by, status FROM jobs")}
    assert rows == {None: "error", "w2": "running"}


def test_claim_reconnects_after_the_connection_is_lost(dsn: str, db: Any):
    """A worker runs for a long time; losing the one connection it holds (an idle timeout, a Postgres
    restart) must not be fatal to it."""
    seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store._conn.close()  # simulate the connection dying under it, between jobs
    job = store.claim()
    assert job is not None


def test_missing_plan_or_task_row_fails_the_job_instead_of_hanging(dsn: str, db: Any):
    (task_id,) = seed(db)
    db.execute("DELETE FROM tasks")
    assert PgJobStore.connect(dsn, "w1").claim() is None
    row = db.execute("SELECT status, notes FROM jobs WHERE task_id = %s", (task_id,)).fetchone()
    assert row["status"] == "error"


def test_passing_patch_is_stored_and_failures_store_none(dsn: str, db: Any):
    (task_id,) = seed(db)
    store = PgJobStore.connect(dsn, "w1")
    store.claim()
    store.report(RunOutcome(task_id, True, "0xroot", ["finished"], patch="diff --git a/x b/x\n"))
    assert db.execute("SELECT patch FROM jobs").fetchone()["patch"] == "diff --git a/x b/x\n"
