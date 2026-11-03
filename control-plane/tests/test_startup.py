"""Start-up checks and housekeeping for a worker that lives on its own VM (plan task O10)."""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

import mergit_worker.startup as startup
from mergit_worker.config import ConfigError
from mergit_worker.startup import WorkerIdLock, agents_without_key, sweep_workspaces, watch_lock

KEY_A = "0x" + "a" * 64
KEY_B = "0x" + "b" * 64


def agents_file(tmp_path: Path, *ids: str) -> Path:
    path = tmp_path / "agents.json"
    path.write_text(json.dumps({"agents": [{"agent_id": i, "name": f"agent-{i}"} for i in ids]}))
    return path


# -- agents_without_key --------------------------------------------------------------------------------


def test_every_agent_with_a_key_means_nothing_is_missing(tmp_path: Path) -> None:
    env = {"MERGIT_AGENT_KEY_1": KEY_A, "MERGIT_AGENT_KEY_2": KEY_B}
    assert agents_without_key(agents_file(tmp_path, "1", "2"), env) == []


def test_an_agent_with_no_key_is_reported(tmp_path: Path) -> None:
    assert agents_without_key(agents_file(tmp_path, "1", "2"), {"MERGIT_AGENT_KEY_1": KEY_A}) == ["2"]


@pytest.mark.parametrize(
    "bad",
    ["", "0x1234", "0x" + "g" * 64, KEY_A[2:], KEY_A + "00", " " + KEY_A],
    ids=["empty", "short", "not-hex", "no-0x", "too-long", "leading-space"],
)
def test_a_malformed_key_counts_as_missing(tmp_path: Path, bad: str) -> None:
    assert agents_without_key(agents_file(tmp_path, "1"), {"MERGIT_AGENT_KEY_1": bad}) == ["1"]


def test_a_key_for_another_agent_does_not_cover_this_one(tmp_path: Path) -> None:
    assert agents_without_key(agents_file(tmp_path, "10"), {"MERGIT_AGENT_KEY_1": KEY_A}) == ["10"]


def test_an_unreadable_agents_file_is_a_config_error_not_a_crash(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        agents_without_key(tmp_path / "missing.json", {})
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    with pytest.raises(ConfigError):
        agents_without_key(broken, {})
    wrong_shape = tmp_path / "shape.json"
    wrong_shape.write_text('{"not_agents": []}')
    with pytest.raises(ConfigError):
        agents_without_key(wrong_shape, {})


def test_reads_the_process_environment_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MERGIT_AGENT_KEY_7", KEY_A)
    assert agents_without_key(agents_file(tmp_path, "7")) == []


# -- sweep_workspaces ----------------------------------------------------------------------------------

HOUR = 3600.0


def workspace(root: Path, name: str, age_s: float, now: float) -> Path:
    ws = root / name
    (ws / "work").mkdir(parents=True)
    (ws / "git").mkdir()
    (ws / "work" / "file.txt").write_text("checkout")
    os.utime(ws, (now - age_s, now - age_s))
    return ws


def test_an_old_workspace_is_removed_and_a_recent_one_is_kept(tmp_path: Path) -> None:
    now = 1_000_000.0
    old = workspace(tmp_path, "ws-old", 2 * HOUR, now)
    fresh = workspace(tmp_path, "ws-fresh", 60, now)
    assert sweep_workspaces(tmp_path, HOUR, now=now) == 1
    assert not old.exists()
    assert fresh.exists()


def test_a_workspace_exactly_at_the_limit_is_kept(tmp_path: Path) -> None:
    # A job still inside its lease must never lose its checkout.
    now = 1_000_000.0
    edge = workspace(tmp_path, "ws-edge", HOUR, now)
    assert sweep_workspaces(tmp_path, HOUR, now=now) == 0
    assert edge.exists()


def test_only_workspace_directories_are_touched(tmp_path: Path) -> None:
    now = 1_000_000.0
    other_dir = tmp_path / "keep-me"
    other_dir.mkdir()
    loose_file = tmp_path / "ws-not-a-directory"
    loose_file.write_text("x")
    for p in (other_dir, loose_file):
        os.utime(p, (now - 5 * HOUR, now - 5 * HOUR))
    assert sweep_workspaces(tmp_path, HOUR, now=now) == 0
    assert other_dir.exists() and loose_file.exists()


def test_a_missing_root_is_nothing_to_do(tmp_path: Path) -> None:
    assert sweep_workspaces(tmp_path / "does-not-exist", HOUR) == 0


def test_a_workspace_a_sandbox_left_unreadable_is_still_removed(tmp_path: Path) -> None:
    now = 1_000_000.0
    ws = workspace(tmp_path, "ws-locked", 2 * HOUR, now)
    locked = ws / "work" / "locked"
    locked.mkdir()
    (locked / "inner.txt").write_text("x")
    locked.chmod(0o000)
    try:
        assert sweep_workspaces(tmp_path, HOUR, now=now) == 1
    finally:
        if locked.exists():
            locked.chmod(0o700)
    assert not ws.exists()


def test_a_planted_symlink_is_removed_but_never_followed(tmp_path: Path) -> None:
    """A sandboxed agent controls the contents of its workspace. A link to a directory elsewhere must not
    make the sweep chmod or delete what it points at."""
    now = 1_000_000.0
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.txt").write_text("keep")
    outside.chmod(0o755)
    root = tmp_path / "root"
    root.mkdir()
    ws = workspace(root, "ws-evil", 2 * HOUR, now)
    (ws / "work" / "escape").symlink_to(outside, target_is_directory=True)
    (ws / "work" / "dangling").symlink_to(tmp_path / "nowhere")

    assert sweep_workspaces(root, HOUR, now=now) == 1

    assert not ws.exists()
    assert (outside / "precious.txt").read_text() == "keep"
    assert outside.stat().st_mode & 0o777 == 0o755


def test_a_workspace_root_that_is_itself_a_symlink_entry_is_skipped(tmp_path: Path) -> None:
    now = 1_000_000.0
    real = tmp_path / "elsewhere"
    real.mkdir()
    os.utime(real, (now - 5 * HOUR, now - 5 * HOUR))
    root = tmp_path / "root"
    root.mkdir()
    (root / "ws-link").symlink_to(real, target_is_directory=True)
    assert sweep_workspaces(root, HOUR, now=now) == 0
    assert real.exists()


def test_a_removal_failure_is_logged_and_the_rest_still_go(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    now = 1_000_000.0
    stuck = workspace(tmp_path, "ws-a-stuck", 2 * HOUR, now)
    other = workspace(tmp_path, "ws-b-other", 2 * HOUR, now)

    import mergit_worker.startup as startup

    real = startup._remove_workspace

    def flaky(path: Path) -> None:
        if path.name == "ws-a-stuck":
            raise PermissionError("busy")
        real(path)

    monkeypatch.setattr(startup, "_remove_workspace", flaky)
    with caplog.at_level("WARNING"):
        assert sweep_workspaces(tmp_path, HOUR, now=now) == 1
    assert stuck.exists() and not other.exists()
    assert "ws-a-stuck" in caplog.text


# -- WorkerIdLock without a database (the real-Postgres tests are in test_worker_role.py) -----------------


class FakeCursor:
    def __init__(self, row: tuple[object, ...] | None) -> None:
        self.row = row

    def fetchone(self) -> tuple[object, ...] | None:
        return self.row


class FakeConn:
    """Enough of a psycopg connection for WorkerIdLock. ``hang`` makes ``SELECT 1`` block until it is set,
    like a socket whose peer lost power; ``fail`` makes it raise once it returns."""

    def __init__(self, *, locked: bool = True) -> None:
        self.locked = locked
        self.closed = False
        self.sql: list[str] = []
        self.params: list[object] = []
        self.hang: threading.Event | None = None
        self.fail = False

    def execute(self, sql: str, params: object = None) -> FakeCursor:
        self.sql.append(sql)
        self.params.append(params)
        if sql == "SELECT 1":
            if self.hang is not None:
                self.hang.wait(3.0)  # bounded, so a regression fails the test instead of hanging the run
            if self.fail:
                raise psycopg.OperationalError("server closed the connection unexpectedly")
            return FakeCursor((1,))
        if "pg_try_advisory_lock" in sql:
            return FakeCursor((self.locked,))
        return FakeCursor(None)

    def close(self) -> None:
        self.closed = True


def test_the_lock_conninfo_sets_tcp_keepalives_and_a_connect_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without these a peer that lost power or dropped off the network is noticed only when the kernel gives
    up: about two hours idle, or about fifteen minutes with a query unacknowledged. tcp_user_timeout is the
    one that matters for a dead database host, because the watcher's SELECT 1 every 10 s keeps the socket
    from ever being idle long enough for a keepalive. Without a connect timeout a reconnect can wait as
    long."""
    seen: dict[str, str] = {}
    conn = FakeConn()

    def connect(conninfo: str = "", *, autocommit: bool = False, **kwargs: object) -> FakeConn:
        assert autocommit is True
        seen.update(conninfo_to_dict(make_conninfo(conninfo, **kwargs)))  # what psycopg.connect would merge
        return conn

    monkeypatch.setattr(startup.psycopg, "connect", connect)
    lock = WorkerIdLock.acquire("postgresql://worker@db.invalid:5433/mergit_cp", "conninfo-id")
    assert lock is not None
    assert {
        k: seen.get(k) for k in ("keepalives", "keepalives_idle", "keepalives_interval", "keepalives_count")
    } == {
        "keepalives": "1",
        "keepalives_idle": "30",
        "keepalives_interval": "10",
        "keepalives_count": "3",
    }
    assert seen.get("tcp_user_timeout") == "60000"  # milliseconds
    assert seen.get("connect_timeout") == "10"
    assert seen.get("host") == "db.invalid" and seen.get("dbname") == "mergit_cp"  # the URL is kept


def test_the_lock_session_asks_the_server_to_drop_a_client_that_went_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The client's keepalives cannot free the lock: it is the server that holds a powered-off worker's
    backend, and with it the lock, until its own keepalive gives up. The session sets the server's side."""
    conn = FakeConn()
    monkeypatch.setattr(startup.psycopg, "connect", lambda *_a, **_k: conn)  # pyright: ignore[reportUnknownLambdaType]
    assert WorkerIdLock.acquire("postgresql://worker@db.invalid/mergit_cp", "server-side-id") is not None
    at = next(i for i, s in enumerate(conn.sql) if "tcp_keepalives_idle" in s)
    assert conn.sql[at] == (
        "SELECT set_config('tcp_keepalives_idle', %s, false),"
        " set_config('tcp_keepalives_interval', %s, false),"
        " set_config('tcp_keepalives_count', %s, false),"
        " set_config('tcp_user_timeout', %s, false)"
    )
    assert conn.params[at] == ("30", "10", "3", "60000")
    assert at < next(i for i, s in enumerate(conn.sql) if "pg_try_advisory_lock" in s)  # set before locking


def test_a_hung_select_one_does_not_wedge_the_watcher(monkeypatch: pytest.MonkeyPatch) -> None:
    """A half-open socket never answers ``SELECT 1``. The check must give up and report "unknown", not block
    the watcher thread, and must not reconnect while the old session may still hold the lock."""
    monkeypatch.setattr(startup, "LOCK_PROBE_TIMEOUT_S", 0.2)
    takes: list[str] = []
    monkeypatch.setattr(startup, "_take", lambda _url, key: takes.append(key))  # pyright: ignore[reportUnknownLambdaType]
    conn = FakeConn()
    conn.hang = threading.Event()
    lock = WorkerIdLock(conn, "postgresql://unused", "mergit_worker:hung")  # type: ignore[arg-type]
    try:
        started = time.monotonic()
        assert lock.still_held() is None
        assert time.monotonic() - started < 1.5
        assert lock.still_held() is None  # still unknown while the same probe hangs
        assert takes == []

        lost: list[int] = []
        stop = threading.Event()
        watcher = threading.Thread(target=watch_lock, args=(lock, stop, 0.01, lambda: lost.append(1)))
        watcher.start()
        time.sleep(0.5)
        stop.set()
        watcher.join(2.0)
        assert not watcher.is_alive()  # it kept looping and saw the stop
        assert lost == []
        assert conn.sql.count("SELECT 1") == 1  # no pile of probe threads behind the hung one
    finally:
        conn.hang.set()
        lock.close()


def test_a_probe_that_fails_after_hanging_reconnects_on_the_next_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(startup, "LOCK_PROBE_TIMEOUT_S", 0.2)
    fresh = FakeConn()
    monkeypatch.setattr(startup, "_take", lambda _url, _key: fresh)  # pyright: ignore[reportUnknownLambdaType]
    conn = FakeConn()
    conn.hang = threading.Event()
    conn.fail = True
    lock = WorkerIdLock(conn, "postgresql://unused", "mergit_worker:recovers")  # type: ignore[arg-type]
    assert lock.still_held() is None
    conn.hang.set()  # the kernel finally reports the socket dead
    deadline = time.monotonic() + 2.0
    while not conn.closed and time.monotonic() < deadline:
        assert lock.still_held() in (None, True)
        time.sleep(0.01)
    assert conn.closed
    assert lock.still_held() is True
    assert lock._conn is fresh  # pyright: ignore[reportPrivateUsage]
    lock.close()
    assert fresh.closed


def test_close_while_the_watcher_is_reconnecting_leaks_no_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """The process shuts down while the watcher is between connecting and storing the new connection.
    Stored after close(), it would hold the lock (and a server backend) until the process exits."""
    entered, release = threading.Event(), threading.Event()
    fresh = FakeConn()

    def slow_take(_url: str, _key: str) -> FakeConn:
        entered.set()
        release.wait(3.0)
        return fresh

    monkeypatch.setattr(startup, "_take", slow_take)
    broken = FakeConn()
    broken.fail = True
    lock = WorkerIdLock(broken, "postgresql://unused", "mergit_worker:closing")  # type: ignore[arg-type]
    result: list[bool | None] = []
    watcher = threading.Thread(target=lambda: result.append(lock.still_held()))
    watcher.start()
    assert entered.wait(2.0)
    lock.close()
    release.set()
    watcher.join(2.0)
    assert not watcher.is_alive()
    assert broken.closed
    assert fresh.closed
    assert lock._conn is None  # pyright: ignore[reportPrivateUsage]
    assert result == [None]


def test_close_during_a_hung_probe_closes_the_connection_once_the_probe_returns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """close() must not block on a hung socket (it runs in the shutdown path), and must not tear the
    connection down under a thread that is still inside it; the probe closes it on its way out."""
    monkeypatch.setattr(startup, "LOCK_PROBE_TIMEOUT_S", 0.2)
    conn = FakeConn()
    conn.hang = threading.Event()
    lock = WorkerIdLock(conn, "postgresql://unused", "mergit_worker:shutdown")  # type: ignore[arg-type]
    assert lock.still_held() is None
    started = time.monotonic()
    lock.close()
    assert time.monotonic() - started < 0.5
    assert not conn.closed
    conn.hang.set()
    deadline = time.monotonic() + 2.0
    while not conn.closed and time.monotonic() < deadline:
        time.sleep(0.01)
    assert conn.closed
    assert lock.still_held() is None  # a closed lock is never "held" again, and never reconnects


def test_a_refused_start_says_the_previous_session_may_still_be_clearing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """After a power loss the "other process" is this worker's own dead session. The operator is told it
    clears by itself, so the exit-2 restarts that follow for about a minute are not read as a duplicate id."""
    from types import SimpleNamespace

    from pydantic import SecretStr

    import mergit_worker.__main__ as entry

    cfg = SimpleNamespace(
        worker_id="held-id",
        agents_file=Path("unused"),
        require_all_agent_keys=False,
        worker_id_lock_grace_s=0.0,
        database_url=SecretStr("postgresql://nobody@db.invalid/none"),
    )
    monkeypatch.setattr(entry, "load_config", lambda: cfg)
    monkeypatch.setattr(entry, "agents_without_key", lambda _path: [])  # pyright: ignore[reportUnknownLambdaType]
    monkeypatch.setattr(startup.WorkerIdLock, "acquire", classmethod(lambda _cls, _url, _id: None))  # pyright: ignore[reportUnknownLambdaType, reportUnknownArgumentType]
    with caplog.at_level("ERROR"):
        assert entry.main() == 2
    assert "already running as 'held-id'" in caplog.text
    assert "about 60 s after its last packet" in caplog.text


def test_startup_connect_has_a_connect_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every connection the worker process opens at start-up (the id lock, the job store, the pull-request
    store) must give up on an unreachable database instead of waiting on the kernel's TCP timeout. The two
    stores let a timeout set in the URL itself win; the lock's options are fixed."""
    import mergit_cp.pr_store as pr_store_module
    import mergit_worker.jobs as jobs_module

    def seen_by(call: Callable[[str], object], url: str) -> dict[str, str]:
        seen: dict[str, str] = {}

        def connect(
            conninfo: str = "", *, autocommit: bool = False, row_factory: object = None, **kwargs: object
        ) -> FakeConn:
            seen.update(conninfo_to_dict(make_conninfo(conninfo, **kwargs)))
            return FakeConn()

        monkeypatch.setattr(startup.psycopg, "connect", connect)
        with contextlib.suppress(Exception):  # the fake is not a real connection; only the options matter
            call(url)
        return seen

    url = "postgresql://worker@db.invalid:5433/mergit_cp"
    assert seen_by(lambda u: WorkerIdLock.acquire(u, "timeout-id"), url).get("connect_timeout") == "10"
    for name, open_ in (
        ("jobs", jobs_module.PgJobStore._open),
        ("pr_store", pr_store_module.PgPrStore._open),
    ):
        assert seen_by(open_, url).get("connect_timeout") == "10", name
        assert seen_by(open_, url + "?connect_timeout=3").get("connect_timeout") == "3", name


# -- waiting for the worker-id lock at start-up ---------------------------------------------------------


class _Clock:
    """A fake clock whose sleep advances it, so the grace wait runs in no real time."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _acquire_results(monkeypatch: pytest.MonkeyPatch, results: list[object]) -> list[int]:
    calls: list[int] = []

    def acquire(_cls: object, _url: str, _id: str) -> object:
        calls.append(1)
        return results.pop(0) if results else None

    monkeypatch.setattr(startup.WorkerIdLock, "acquire", classmethod(acquire))  # pyright: ignore[reportArgumentType]
    return calls


def test_a_held_lock_is_waited_for_and_taken_once_it_frees(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """After a reboot the holder is this worker's own dead session; it clears within about a minute."""
    sentinel = object()
    calls = _acquire_results(monkeypatch, [None, None, sentinel])
    clock = _Clock()
    with caplog.at_level("INFO", logger="mergit_worker.startup"):
        got = startup.acquire_with_grace(
            "postgresql://x", "w", 90.0, sleep=clock.sleep, clock=lambda: clock.now
        )
    assert got is sentinel
    assert len(calls) == 3
    assert clock.sleeps == [startup.LOCK_RETRY_INTERVAL_S] * 2
    assert "held by another database session" in caplog.text  # says what it is waiting for, once
    assert caplog.text.count("held by another database session") == 1
    assert "was released" in caplog.text


def test_a_lock_that_stays_held_gives_up_after_the_grace_period(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _acquire_results(monkeypatch, [])  # always held
    clock = _Clock()
    assert (
        startup.acquire_with_grace("postgresql://x", "w", 12.0, sleep=clock.sleep, clock=lambda: clock.now)
        is None
    )
    assert clock.now == 12.0  # never waits past the grace period
    assert sum(clock.sleeps) == 12.0
    assert len(calls) == 4  # 0, 5, 10, 12


def test_zero_grace_is_a_single_attempt_with_no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _acquire_results(monkeypatch, [])
    clock = _Clock()
    assert (
        startup.acquire_with_grace("postgresql://x", "w", 0.0, sleep=clock.sleep, clock=lambda: clock.now)
        is None
    )
    assert len(calls) == 1 and clock.sleeps == []


def test_a_free_lock_is_taken_at_once_without_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    sentinel = object()
    calls = _acquire_results(monkeypatch, [sentinel])
    clock = _Clock()
    got = startup.acquire_with_grace("postgresql://x", "w", 90.0, sleep=clock.sleep, clock=lambda: clock.now)
    assert got is sentinel and len(calls) == 1 and clock.sleeps == []


def test_an_unreachable_database_is_not_waited_out(monkeypatch: pytest.MonkeyPatch) -> None:
    def acquire(_cls: object, _url: str, _id: str) -> object:
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(startup.WorkerIdLock, "acquire", classmethod(acquire))  # pyright: ignore[reportArgumentType]
    clock = _Clock()
    with pytest.raises(psycopg.OperationalError):
        startup.acquire_with_grace("postgresql://x", "w", 90.0, sleep=clock.sleep, clock=lambda: clock.now)
    assert clock.sleeps == []


def test_the_grace_period_defaults_to_ninety_seconds_and_is_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mergit_worker.config import WorkerConfig

    assert WorkerConfig.model_fields["worker_id_lock_grace_s"].default == 90.0


def test_a_closed_lock_never_reconnects(monkeypatch: pytest.MonkeyPatch) -> None:
    takes: list[str] = []
    monkeypatch.setattr(startup, "_take", lambda _url, key: takes.append(key))  # pyright: ignore[reportUnknownLambdaType]
    conn = FakeConn()
    conn.fail = True
    lock = WorkerIdLock(conn, "postgresql://unused", "mergit_worker:closed")  # type: ignore[arg-type]
    lock.close()
    assert lock.still_held() is None
    assert takes == []
