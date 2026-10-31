"""The worker VM connects to the control-plane database as its own least-privilege role (plan task O10).

``deploy/worker-vm/db-role.sql`` is the grant list. These tests run it as shipped against a database built by
the real migrations, then act as that role: every statement the worker issues must work, and nothing else may.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg import errors
from psycopg.conninfo import make_conninfo

from mergit_cp.db import migrate
from mergit_cp.pr_store import _CHANGES, PgPrStore
from mergit_worker import jobs as worker_jobs
from mergit_worker.jobs import PgJobStore
from mergit_worker.startup import WorkerIdLock, watch_lock

pytestmark = pytest.mark.postgres

GRANTS = Path(__file__).resolve().parents[2] / "deploy" / "worker-vm" / "db-role.sql"
ROLE = "mergit_worker"
PASSWORD = "role-test-password"
DB = "worker_role_test"
TASK = "0x" + "0" * 64
PLAN = "00000000-0000-0000-0000-000000000000"
WORKER_TABLES = {"jobs", "pr_requests", "plans", "tasks"}
SENSITIVE = {"sessions", "users", "identities", "wallets", "email_otps", "oauth_states", "wallet_interest"}


async def _migrate(url: str) -> None:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        await migrate(conn)


@pytest.fixture(scope="module")
def admin_url(database_url: str) -> Iterator[str]:
    """A throwaway database with every migration applied and the grants file run, as the real script does."""
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"DROP DATABASE IF EXISTS {DB}")
        root.execute(f"CREATE DATABASE {DB}")
    url = make_conninfo(database_url, dbname=DB)
    asyncio.run(_migrate(url))
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"DROP ROLE IF EXISTS {ROLE}")  # a previous run's role, owned by nothing now
        root.execute(f"CREATE ROLE {ROLE} LOGIN PASSWORD '{PASSWORD}'")
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(GRANTS.read_text())  # pyright: ignore[reportArgumentType]
    yield url
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"DROP DATABASE {DB} WITH (FORCE)")
        root.execute(f"DROP ROLE {ROLE}")


@pytest.fixture
def role_url(admin_url: str) -> str:
    return make_conninfo(admin_url, user=ROLE, password=PASSWORD)


def _tables(admin_url: str) -> set[str]:
    with psycopg.connect(admin_url) as conn:
        rows = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'").fetchall()
    return {r[0] for r in rows}


# -- everything the worker does works ------------------------------------------------------------------


def test_the_job_queue_methods_work_as_the_role(role_url: str) -> None:
    store = PgJobStore.connect(role_url, "role-test")
    try:
        assert store.fail_own_running() == 0
        assert store.reclaim_stale(3600.0) == 0
        assert store.claim() is None  # SELECT ... FOR UPDATE SKIP LOCKED, then UPDATE
        store.fail(TASK, "nothing to fail")  # UPDATE ... WHERE task_id
    finally:
        store.close()


def test_the_job_loading_queries_work_as_the_role(role_url: str) -> None:
    """_LOAD joins plans and tasks, and a dependent task reads its dependencies' patches: both need SELECT."""
    with psycopg.connect(role_url, autocommit=True) as conn:
        assert conn.execute(worker_jobs._LOAD, {"task_id": TASK}).fetchall() == []
        assert (
            conn.execute(worker_jobs._DEPENDENCY_PATCHES, {"plan_uuid": PLAN, "indexes": [0]}).fetchall()
            == []
        )
        params = {"status": "done", "holds": True, "root": None, "notes": None, "patch": None}
        assert conn.execute(worker_jobs._REPORT, {**params, "task_id": TASK, "worker": "w"}).rowcount == 0


def test_the_pull_request_queue_methods_work_as_the_role(role_url: str) -> None:
    store = PgPrStore.connect(role_url, "role-test")
    try:
        assert store.claim() is None
        assert store.requeue_own_running() == 0
        assert store.reclaim_stale(3600.0) == 0
        assert store.plan(PLAN) is None  # SELECT FROM plans
        assert store.request(PLAN) is None
        store.finish(PLAN, "branch", "a" * 40, 1, "https://example.test/pr/1")
        store.fail(PLAN, "nothing to fail")
    finally:
        store.close()
    with psycopg.connect(role_url, autocommit=True) as conn:
        assert conn.execute(_CHANGES, {"plan": PLAN}).fetchall() == []  # tasks LEFT JOIN jobs


# -- and nothing else does ------------------------------------------------------------------------------


def test_the_sensitive_tables_exist_so_the_next_test_is_not_vacuous(admin_url: str) -> None:
    assert _tables(admin_url) >= SENSITIVE


def test_the_role_cannot_read_any_table_it_was_not_given(admin_url: str, role_url: str) -> None:
    denied = sorted(_tables(admin_url) - WORKER_TABLES)
    assert set(denied) >= SENSITIVE
    with psycopg.connect(role_url, autocommit=True) as conn:
        for table in denied:
            with pytest.raises(errors.InsufficientPrivilege):
                conn.execute(f'SELECT * FROM "{table}" LIMIT 1')  # pyright: ignore[reportArgumentType]


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM jobs",
        "DELETE FROM pr_requests",
        "INSERT INTO pr_requests (plan_uuid, requested_by) VALUES ('{plan}', 'x')",
        "UPDATE plans SET state = 'done'",
        "DELETE FROM plans",
        "UPDATE tasks SET title = 'x'",
        "DELETE FROM tasks",
        "TRUNCATE jobs",
        "CREATE TABLE stolen (x int)",
        "ALTER TABLE jobs ADD COLUMN x int",
        "DROP TABLE jobs",
    ],
    ids=lambda s: s.split(" (")[0],
)
def test_the_role_cannot_change_more_than_the_worker_needs(role_url: str, sql: str) -> None:
    with psycopg.connect(role_url, autocommit=True) as conn, pytest.raises(errors.InsufficientPrivilege):
        conn.execute(sql.format(plan=PLAN))  # pyright: ignore[reportArgumentType]


def test_running_the_grants_again_takes_extra_rights_away(admin_url: str, role_url: str) -> None:
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f"GRANT SELECT ON sessions TO {ROLE}")
    with psycopg.connect(role_url, autocommit=True) as conn:
        conn.execute("SELECT 1 FROM sessions LIMIT 1")  # the leak the next run must close
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(GRANTS.read_text())  # pyright: ignore[reportArgumentType]
    with psycopg.connect(role_url, autocommit=True) as conn, pytest.raises(errors.InsufficientPrivilege):
        conn.execute("SELECT 1 FROM sessions LIMIT 1")


# -- one process per worker id --------------------------------------------------------------------------


def test_a_second_process_with_the_same_worker_id_is_refused(database_url: str) -> None:
    first = WorkerIdLock.acquire(database_url, "dup-id")
    assert first is not None
    try:
        assert WorkerIdLock.acquire(database_url, "dup-id") is None
    finally:
        first.close()


def test_different_worker_ids_do_not_block_each_other(database_url: str) -> None:
    a = WorkerIdLock.acquire(database_url, "id-a")
    b = WorkerIdLock.acquire(database_url, "id-b")
    assert a is not None and b is not None
    a.close()
    b.close()


def test_the_id_is_free_again_once_the_holder_exits(database_url: str) -> None:
    first = WorkerIdLock.acquire(database_url, "restart-id")
    assert first is not None
    first.close()
    again = WorkerIdLock.acquire(database_url, "restart-id")
    assert again is not None
    again.close()


def test_a_killed_worker_does_not_block_its_own_restart(database_url: str) -> None:
    """A SIGKILLed container never calls close(); Postgres drops the session and with it the lock."""
    dead = WorkerIdLock.acquire(database_url, "killed-id")
    assert dead is not None
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
            " WHERE pid <> pg_backend_pid() AND query LIKE '%pg_try_advisory_lock%'"
        )
    restarted = None
    for _ in range(50):  # the server notices the dropped connection almost at once
        restarted = WorkerIdLock.acquire(database_url, "killed-id")
        if restarted is not None:
            break
        asyncio.run(asyncio.sleep(0.1))
    assert restarted is not None
    restarted.close()


def test_the_role_can_take_the_lock_too(role_url: str) -> None:
    lock = WorkerIdLock.acquire(role_url, "role-lock-id")
    assert lock is not None
    lock.close()


# -- the lock survives a database restart, and a dead database is a clean exit ---------------------------


def _kill_lock_sessions(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
            " WHERE pid <> pg_backend_pid() AND query LIKE '%pg_try_advisory_lock%'"
        )


def test_the_lock_is_taken_again_after_the_database_drops_the_session(database_url: str) -> None:
    """What a cp_postgres restart does to a live worker: the session and its lock vanish. Without this the
    process runs on unguarded and a second one with the same id would fail its jobs."""
    lock = WorkerIdLock.acquire(database_url, "restart-held-id")
    assert lock is not None
    try:
        assert lock.still_held() is True
        _kill_lock_sessions(database_url)
        assert lock.still_held() is True  # reconnected and locked again
        assert WorkerIdLock.acquire(database_url, "restart-held-id") is None  # and it really is held
    finally:
        lock.close()


def test_a_lock_another_process_took_while_the_database_was_down_is_reported_lost(database_url: str) -> None:
    lock = WorkerIdLock.acquire(database_url, "stolen-id")
    assert lock is not None
    thief = None
    try:
        _kill_lock_sessions(database_url)
        for _ in range(50):  # the drop is noticed almost at once; the thief takes the id
            thief = WorkerIdLock.acquire(database_url, "stolen-id")
            if thief is not None:
                break
            asyncio.run(asyncio.sleep(0.1))
        assert thief is not None
        assert lock.still_held() is False
    finally:
        lock.close()
        if thief is not None:
            thief.close()


def test_an_unreachable_database_is_unknown_not_lost(database_url: str) -> None:
    lock = WorkerIdLock.acquire(database_url, "down-id")
    assert lock is not None
    try:
        lock._url = make_conninfo(database_url, port=1, connect_timeout=1)  # pyright: ignore[reportPrivateUsage]
        _kill_lock_sessions(database_url)
        assert lock.still_held() is None  # nothing can have taken the id from a database that is down
    finally:
        lock.close()


def test_the_watchdog_calls_on_lost_once_and_stops(database_url: str) -> None:
    import threading

    class Lost:
        def still_held(self) -> bool:
            return False

    calls: list[int] = []
    watch_lock(Lost(), threading.Event(), 0.01, lambda: calls.append(1))  # type: ignore[arg-type]
    assert calls == [1]


def test_a_database_that_is_down_at_start_exits_cleanly_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from types import SimpleNamespace

    from pydantic import SecretStr

    import mergit_worker.__main__ as entry

    cfg = SimpleNamespace(
        worker_id="boot-id",
        agents_file=Path("unused"),
        require_all_agent_keys=False,
        database_url=SecretStr("postgresql://nobody@127.0.0.1:1/none?connect_timeout=1"),
    )
    monkeypatch.setattr(entry, "load_config", lambda: cfg)
    monkeypatch.setattr(entry, "agents_without_key", lambda _path: [])
    with caplog.at_level("ERROR"):
        assert entry.main() == 1
    assert "cannot reach the database at start-up" in caplog.text
    assert not any(r.exc_info for r in caplog.records)
