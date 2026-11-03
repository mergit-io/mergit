"""The worker VM connects to the control-plane database as its own least-privilege role (plan task O10).

``deploy/worker-vm/db-role.sql`` is the grant list. These tests run it as shipped against a database built by
the real migrations, then act as that role: every statement the worker issues must work, and nothing else may.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import errors
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from mergit_cp.db import migrate
from mergit_cp.pr_store import _CHANGES, PgPrStore
from mergit_worker import jobs as worker_jobs
from mergit_worker.jobs import PgJobStore
from mergit_worker.startup import WorkerIdLock, watch_lock

pytestmark = pytest.mark.postgres

GRANTS = Path(__file__).resolve().parents[2] / "deploy" / "worker-vm" / "db-role.sql"
CREATE_ROLE = GRANTS.with_name("create-db-role.sh")
# Roles belong to the whole cluster, not to one database. A name of this run's own, so that dropping it can
# never drop the real mergit_worker (or another run's role) on a cluster the tests were pointed at by mistake.
RUN = uuid4().hex[:8]
ROLE = f"mergit_worker_{RUN}"
PASSWORD = "role-test-password"
DB = f"worker_role_test_{RUN}"
TASK = "0x" + "0" * 64
PLAN = "00000000-0000-0000-0000-000000000000"
WORKER_TABLES = {"jobs", "pr_requests", "plans", "tasks"}
SENSITIVE = {"sessions", "users", "identities", "wallets", "email_otps", "oauth_states", "wallet_interest"}


async def _migrate(url: str) -> None:
    async with await psycopg.AsyncConnection.connect(url) as conn:
        await migrate(conn)


def _run_grants(url: str) -> None:
    """Run db-role.sql for this run's role, as create-db-role.sh does with WORKER_DB_ROLE."""
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"SET mergit.worker_role = '{ROLE}'")  # pyright: ignore[reportArgumentType]
        conn.execute(GRANTS.read_text())  # pyright: ignore[reportArgumentType]


@pytest.fixture(scope="module", autouse=True)
def _only_a_throwaway_cluster(database_url: str) -> None:
    """These tests create and drop roles and databases, which belong to the whole cluster. The
    ``database_url`` fixture is a testcontainer on this machine (database ``test``); refuse anything else
    unless the operator says so, so a changed fixture or a stray URL can never point this at a real server."""
    if os.environ.get("MERGIT_TEST_ALLOW_ANY_DB") == "1":
        return
    info = conninfo_to_dict(database_url)
    if info.get("host") not in ("localhost", "127.0.0.1", "::1") or info.get("dbname") != "test":
        pytest.skip(
            "database_url is not a local throwaway test database (host localhost, database 'test'); "
            "set MERGIT_TEST_ALLOW_ANY_DB=1 to run against it anyway"
        )


@pytest.fixture(scope="module")
def admin_url(database_url: str) -> Iterator[str]:
    """A throwaway database with every migration applied and the grants file run, as the real script does."""
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"DROP DATABASE IF EXISTS {DB}")
        root.execute(f"CREATE DATABASE {DB}")
    url = make_conninfo(database_url, dbname=DB)
    asyncio.run(_migrate(url))
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"CREATE ROLE {ROLE} LOGIN PASSWORD '{PASSWORD}'")
    _run_grants(url)
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
    _run_grants(admin_url)
    with psycopg.connect(role_url, autocommit=True) as conn, pytest.raises(errors.InsufficientPrivilege):
        conn.execute("SELECT 1 FROM sessions LIMIT 1")


def test_the_worker_role_has_connect_revoked_from_public(
    database_url: str, admin_url: str, role_url: str
) -> None:
    """Every role may connect to a new database (PUBLIC has CONNECT); the grants take that away, so a role
    made later for something else cannot open the control-plane database unless it is given CONNECT itself."""
    other = f"mergit_other_{RUN}"
    with psycopg.connect(database_url, autocommit=True) as root:
        root.execute(f"CREATE ROLE {other} LOGIN PASSWORD '{PASSWORD}'")  # pyright: ignore[reportArgumentType]
    try:
        with pytest.raises(psycopg.OperationalError, match="permission denied for database"):
            psycopg.connect(make_conninfo(admin_url, user=other, password=PASSWORD)).close()
        with psycopg.connect(role_url) as conn:
            assert conn.execute("SELECT 1").fetchone() == (1,)
    finally:
        with psycopg.connect(database_url, autocommit=True) as root:
            root.execute(f"DROP ROLE {other}")  # pyright: ignore[reportArgumentType]


def test_running_the_grants_again_takes_away_default_privileges_on_later_tables(
    admin_url: str, role_url: str
) -> None:
    """REVOKE ALL ON ALL TABLES covers the tables that exist now. A default privilege (ALTER DEFAULT
    PRIVILEGES) would hand every table a later migration creates to the role, or to everyone; the grants must
    undo that."""
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO {ROLE}")  # pyright: ignore[reportArgumentType]
        conn.execute("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC")
        conn.execute("CREATE TABLE later_leak (secret text)")
    try:
        with psycopg.connect(role_url, autocommit=True) as conn:
            conn.execute("SELECT * FROM later_leak")  # the default privileges really did leak it
        _run_grants(admin_url)
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("CREATE TABLE later_table (secret text)")
        with psycopg.connect(role_url, autocommit=True) as conn:
            for table in ("later_leak", "later_table"):
                with pytest.raises(errors.InsufficientPrivilege):
                    conn.execute(f"SELECT * FROM {table}")  # pyright: ignore[reportArgumentType]
    finally:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DROP TABLE IF EXISTS later_leak, later_table")
            conn.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {ROLE}")  # pyright: ignore[reportArgumentType]
            conn.execute("ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC")


@pytest.mark.skipif(shutil.which("psql") is None, reason="needs psql on PATH")
def test_the_create_script_makes_the_role_it_is_told_to_with_only_the_grants(
    database_url: str, admin_url: str
) -> None:
    """create-db-role.sh as shipped, through psql, with WORKER_DB_ROLE naming a role of this run's own."""
    name = f"mergit_script_{RUN}"
    password = "script-test-password-0123456789"
    target = database_url.rsplit("/", 1)[0] + f"/{DB}"  # a URI: PSQL is split on spaces
    env = {
        "PATH": os.environ["PATH"],
        "PSQL": f"psql -X {target} -v ON_ERROR_STOP=1 -q",
        "WORKER_DB_ROLE": name,
        "WORKER_DB_PASSWORD": password,
    }
    try:
        run = subprocess.run(["bash", str(CREATE_ROLE)], env=env, capture_output=True, text=True, check=False)
        assert run.returncode == 0, run.stderr
        assert f"postgres://{name}:" in run.stdout
        url = make_conninfo(admin_url, user=name, password=password)
        with psycopg.connect(url, autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM jobs").fetchone() is not None
            with pytest.raises(errors.InsufficientPrivilege):
                conn.execute("SELECT 1 FROM sessions LIMIT 1")
    finally:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            if conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone():
                conn.execute(f"DROP OWNED BY {name}")  # its grants, here and on the database  # pyright: ignore[reportArgumentType]
                conn.execute(f"DROP ROLE {name}")  # pyright: ignore[reportArgumentType]


@pytest.mark.skipif(shutil.which("psql") is None, reason="needs psql on PATH")
def test_create_db_role_refuses_a_superuser_name(database_url: str, admin_url: str) -> None:
    """WORKER_DB_ROLE naming an existing superuser must not reset its password or print a URL for it. (The
    names `postgres` and `pg_*` are refused before psql runs: tests/test_deploy_scripts.py.)"""
    name = f"mergit_super_{RUN}"
    target = database_url.rsplit("/", 1)[0] + f"/{DB}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f"CREATE ROLE {name} SUPERUSER LOGIN PASSWORD 'old-password-0123456789'")  # pyright: ignore[reportArgumentType]
        before = conn.execute("SELECT rolpassword FROM pg_authid WHERE rolname = %s", (name,)).fetchone()
    env = {
        "PATH": os.environ["PATH"],
        "PSQL": f"psql -X {target} -v ON_ERROR_STOP=1 -q",
        "WORKER_DB_ROLE": name,
        "WORKER_DB_PASSWORD": "new-password-0123456789abcdef",
    }
    try:
        run = subprocess.run(["bash", str(CREATE_ROLE)], env=env, capture_output=True, text=True, check=False)
        assert run.returncode != 0
        assert "superuser" in run.stderr
        assert "postgres://" not in run.stdout and "new-password" not in run.stdout + run.stderr
        with psycopg.connect(admin_url) as conn:  # the password was not reset
            after = conn.execute("SELECT rolpassword FROM pg_authid WHERE rolname = %s", (name,)).fetchone()
        assert after == before
    finally:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f"DROP OWNED BY {name}")  # pyright: ignore[reportArgumentType]
            conn.execute(f"DROP ROLE {name}")  # pyright: ignore[reportArgumentType]


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
    _kill_lock_session(database_url, dead)
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


def test_the_lock_connection_has_tcp_keepalives_on_both_ends(role_url: str) -> None:
    """After a worker VM loses power the server keeps its backend, and the lock, until the server's own
    keepalive gives up: by default about two hours, during which the restarted worker cannot start. The
    lock session lowers that to about a minute; and the role may set it, which is the part that can fail."""
    lock = WorkerIdLock.acquire(role_url, "keepalive-id")
    assert lock is not None
    try:
        conn = lock._conn  # pyright: ignore[reportPrivateUsage]
        assert conn is not None
        options = conn.pgconn.info
        client = {o.keyword.decode(): (o.val or b"").decode() for o in options if o.keyword != b"password"}
        assert {
            k: client[k] for k in ("keepalives", "keepalives_idle", "keepalives_interval", "keepalives_count")
        } == {
            "keepalives": "1",
            "keepalives_idle": "30",
            "keepalives_interval": "10",
            "keepalives_count": "3",
        }
        assert client["tcp_user_timeout"] == "60000"
        assert client["connect_timeout"] == "10"
        # pg_settings.setting is the raw value in the setting's base unit (s, s, none, ms). current_setting()
        # and SHOW may render it with a unit ("30s", "1min"), which would not compare to the numbers.
        rows = conn.execute(
            "SELECT name, setting FROM pg_settings WHERE name = ANY(%s)",
            (["tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count", "tcp_user_timeout"],),
        ).fetchall()
        server = {str(name): str(setting) for name, setting in rows}
        assert server == {  # the test container is reached over TCP; on a Unix socket these read 0
            "tcp_keepalives_idle": "30",
            "tcp_keepalives_interval": "10",
            "tcp_keepalives_count": "3",
            "tcp_user_timeout": "60000",
        }
    finally:
        lock.close()


# -- the lock survives a database restart, and a dead database is a clean exit ---------------------------


def _terminate(database_url: str, pid: int) -> None:
    """End one backend and wait (up to 5 s) until it has exited, so its advisory lock is released."""
    with psycopg.connect(database_url, autocommit=True) as admin:
        row = admin.execute("SELECT pg_terminate_backend(%s, 5000)", (pid,)).fetchone()
    assert row == (True,)


def _kill_lock_session(database_url: str, lock: WorkerIdLock) -> None:
    """End the session holding this lock, found by its pid: matching on the query text would also end any
    other backend whose last query mentions advisory locks, and misses this one once it has run anything
    else."""
    conn = lock._conn  # pyright: ignore[reportPrivateUsage]
    assert conn is not None
    _terminate(database_url, conn.info.backend_pid)


def test_the_lock_is_taken_again_after_the_database_drops_the_session(database_url: str) -> None:
    """What a cp_postgres restart does to a live worker: the session and its lock vanish. Without this the
    process runs on unguarded and a second one with the same id would fail its jobs.

    The session is ended by its pid: after still_held() its last query is ``SELECT 1``, so matching on
    ``pg_try_advisory_lock`` would end nothing and the reconnect below would never be exercised."""
    lock = WorkerIdLock.acquire(database_url, "restart-held-id")
    assert lock is not None
    try:
        assert lock.still_held() is True
        old = lock._conn  # pyright: ignore[reportPrivateUsage]
        assert old is not None
        old_pid = old.info.backend_pid
        _terminate(database_url, old_pid)
        assert lock.still_held() is True  # reconnected and locked again
        new = lock._conn  # pyright: ignore[reportPrivateUsage]
        assert new is not None and new is not old and old.closed
        assert new.info.backend_pid != old_pid  # a new session, not the one that was ended
        assert WorkerIdLock.acquire(database_url, "restart-held-id") is None  # and it really is held
    finally:
        lock.close()


def test_a_lock_another_process_took_while_the_database_was_down_is_reported_lost(database_url: str) -> None:
    lock = WorkerIdLock.acquire(database_url, "stolen-id")
    assert lock is not None
    thief = None
    try:
        _kill_lock_session(database_url, lock)
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
        _kill_lock_session(database_url, lock)
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
        worker_id_lock_grace_s=0.0,
        database_url=SecretStr("postgresql://nobody@127.0.0.1:1/none?connect_timeout=1"),
    )
    monkeypatch.setattr(entry, "load_config", lambda: cfg)
    monkeypatch.setattr(entry, "agents_without_key", lambda _path: [])
    with caplog.at_level("ERROR"):
        assert entry.main() == 1
    assert "cannot reach the database at start-up" in caplog.text
    assert not any(r.exc_info for r in caplog.records)
