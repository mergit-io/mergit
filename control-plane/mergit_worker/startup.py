"""Start-up checks and housekeeping for one worker process (plan task O10).

The worker runs on its own VM, restarted by Docker and redeployed by hand, so what it leaves behind when it
stops has to be cleaned up by the next start: jobs, sandbox containers (sandbox.reap_stale) and workspace
directories (here). Everything below is a plain function over a path, an environment or a database URL, so it
is tested without a Docker daemon.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path

import psycopg

from .config import ConfigError

log = logging.getLogger(__name__)

_AGENT_KEY = re.compile(r"^0x[0-9a-fA-F]{64}$")
WORKSPACE_PREFIX = "ws-"  # workspace.Workspace.clone names its directories ws-<random>


def agents_without_key(agents_file: Path, environ: Mapping[str, str] | None = None) -> list[str]:
    """Agent ids in the agents file that have no usable ``MERGIT_AGENT_KEY_<id>`` here.

    The key is read when a job for that agent starts, so a missing one is otherwise found only after a
    requester has picked the agent, funded the plan and burned an attempt on it.
    """
    env = os.environ if environ is None else environ
    try:
        registry: list[dict[str, object]] = json.loads(agents_file.read_text())["agents"]
    except (OSError, KeyError, ValueError) as exc:
        raise ConfigError(f"cannot read agent configuration: {exc}") from exc
    ids = [str(a["agent_id"]) for a in registry if "agent_id" in a]
    return [i for i in ids if not _AGENT_KEY.match(env.get(f"MERGIT_AGENT_KEY_{i}", ""))]


def _remove_workspace(path: Path) -> None:
    """Delete one workspace tree, including directories a sandbox left unreadable.

    Never follows a symlink: a sandboxed agent can plant one, and chmod or rmtree through it would reach
    outside the workspace root.
    """
    for dirpath, dirnames, _files in os.walk(path, followlinks=False):
        _chmod_700(dirpath)
        for name in dirnames:
            child = os.path.join(dirpath, name)
            if not os.path.islink(child):
                _chmod_700(child)
    shutil.rmtree(path)


def _chmod_700(path: str) -> None:
    """chmod that never follows a symlink where the platform can say so (a link swapped in after the
    ``islink`` check, by a sandbox still running, must not redirect it). Linux cannot chmod a link itself,
    and raises NotImplementedError for follow_symlinks=False on one; that means it was a link, so skip it."""
    try:
        os.chmod(path, 0o700, follow_symlinks=False)
    except NotImplementedError:
        if not os.path.islink(path):
            raise


def sweep_workspaces(root: Path, older_than_s: float, *, now: float | None = None) -> int:
    """Remove ``ws-*`` directories under ``root`` that nothing can still be using. Returns how many.

    A crash or a SIGKILL skips the normal clean-up, and ``reap_stale`` removes containers only, so without
    this the VM's disk fills one abandoned checkout at a time. ``older_than_s`` must exceed the longest a
    job can run (the lease, which is also when its row is reclaimed), so a job still in flight in another
    process on this host is never touched.
    """
    if not root.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - older_than_s
    removed = 0
    for entry in root.iterdir():
        if not entry.name.startswith(WORKSPACE_PREFIX) or entry.is_symlink() or not entry.is_dir():
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            _remove_workspace(entry)
            removed += 1
        except OSError as exc:
            log.warning("could not remove stale workspace %s: %s", entry, exc)
    return removed


type _Conn = psycopg.Connection[tuple[object, ...]]

# The lock lives exactly as long as its connection, so both ends must notice a peer that vanished without
# closing it (power loss, a network partition). Left to the kernel, a TCP connection to a dead peer lingers:
# about two hours while idle, about fifteen minutes of retransmission while data is unacknowledged.
#
# Two mechanisms, because each covers a case the other does not:
# - Keepalives probe a socket that has been idle for 30 s, every 10 s, and give up after 3 misses. They
#   matter on the server's side: once a worker's VM loses power nothing arrives, the server's socket goes
#   idle, and the backend (and the lock) is dropped about a minute after the last packet. On this process's
#   side they rarely fire, since the watcher sends ``SELECT 1`` every 10 s and the socket is never idle 30 s.
# - tcp_user_timeout aborts a connection whose sent data has gone unacknowledged for 60 s. That is the case
#   here when the database host dies: the next ``SELECT 1`` (or a query in ``_take`` right after connecting)
#   is never acknowledged, and the kernel fails it after a minute instead of retransmitting for fifteen. On
#   the server's side it covers a worker that dies while a reply to it is in flight.
KEEPALIVES_IDLE_S = 30
KEEPALIVES_INTERVAL_S = 10
KEEPALIVES_COUNT = 3
TCP_USER_TIMEOUT_MS = 60_000
LOCK_CONNECT_OPTIONS: dict[str, int] = {
    "keepalives": 1,
    "keepalives_idle": KEEPALIVES_IDLE_S,
    "keepalives_interval": KEEPALIVES_INTERVAL_S,
    "keepalives_count": KEEPALIVES_COUNT,
    "tcp_user_timeout": TCP_USER_TIMEOUT_MS,
    "connect_timeout": 10,
}
# The options above set this process's socket only. The server's socket for the same connection follows the
# server's own settings, which these session-level GUCs override (Postgres ignores them on a Unix socket).
_SERVER_KEEPALIVES = (
    "SELECT set_config('tcp_keepalives_idle', %s, false),"
    " set_config('tcp_keepalives_interval', %s, false),"
    " set_config('tcp_keepalives_count', %s, false),"
    " set_config('tcp_user_timeout', %s, false)"
)
_SERVER_KEEPALIVE_VALUES = (
    str(KEEPALIVES_IDLE_S),
    str(KEEPALIVES_INTERVAL_S),
    str(KEEPALIVES_COUNT),
    str(TCP_USER_TIMEOUT_MS),
)
# How long one ``SELECT 1`` may take before the lock's state counts as unknown. statement_timeout cannot help
# when the query never reaches the server, and tcp_user_timeout fails it only after a minute; until then the
# check reports "unknown" every 10 s rather than stall the watcher thread for that minute.
LOCK_PROBE_TIMEOUT_S = 10.0


def _close_quietly(conn: _Conn) -> None:
    with contextlib.suppress(psycopg.Error):
        conn.close()


class _Probe:
    """One ``SELECT 1`` on its own daemon thread, so a socket that never answers stalls that thread only."""

    def __init__(self, conn: _Conn) -> None:
        self.conn = conn
        self.error: BaseException | None = None
        self.done = threading.Event()
        self.warned = False
        self._lock = threading.Lock()
        self._close_when_done = False
        threading.Thread(target=self._run, name="worker-id-lock-probe", daemon=True).start()

    def _run(self) -> None:
        try:
            self.conn.execute("SELECT 1")
        except BaseException as exc:  # handed to the caller of still_held, which decides
            self.error = exc
        with self._lock:
            self.done.set()
            close = self._close_when_done
        if close:
            _close_quietly(self.conn)

    def close_when_done(self) -> None:
        """Close the connection now if the query has returned, otherwise as soon as it does. psycopg's
        close() frees the libpq connection, which must not happen under a thread still waiting on it."""
        with self._lock:
            if not self.done.is_set():
                self._close_when_done = True
                return
        _close_quietly(self.conn)


class WorkerIdLock:
    """A session-level Postgres advisory lock named for the worker id, held while the process lives.

    A worker id must belong to one process. At start-up a worker fails every job still ``running`` under its
    id and removes every sandbox container labelled with it, so a second process sharing the id would
    destroy the first one's live work. Postgres releases the lock when the connection ends, whether the
    process exits cleanly or is killed, so a crashed worker never blocks its own restart. A worker whose VM
    lost power or its network never ends the connection; the server ends it once TCP keepalives or
    tcp_user_timeout give up (``LOCK_CONNECT_OPTIONS``, ``_SERVER_KEEPALIVES``), about a minute after its
    last packet, and until then its restart is refused.

    The same rule means a database restart drops the lock while this process lives on. ``still_held``
    notices that, reconnects and takes the lock again, and reports False only when another process has
    taken the id in the meantime: that process has already failed this one's jobs, so this one must stop.

    ``still_held`` runs on the watcher thread and ``close`` on the main one. ``_mutex`` guards ``_conn``,
    ``_probe`` and ``_closed`` (never network I/O), so a connection made after ``close`` is closed, not kept.
    """

    def __init__(self, conn: _Conn, database_url: str, key: str) -> None:
        self._conn: _Conn | None = conn
        self._url = database_url
        self._key = key
        self._mutex = threading.Lock()
        self._closed = False
        self._probe: _Probe | None = None

    @classmethod
    def acquire(cls, database_url: str, worker_id: str) -> WorkerIdLock | None:
        key = f"mergit_worker:{worker_id}"
        conn = _take(database_url, key)
        return None if conn is None else cls(conn, database_url, key)

    def still_held(self) -> bool | None:
        """True while the lock is held, False once another process owns the id, None while that cannot be
        told: the database cannot be reached (nothing can have taken the id from a database that is down),
        the lock is closed, or ``SELECT 1`` has not answered within ``LOCK_PROBE_TIMEOUT_S``.

        A query that has not answered is waited for again on the next call, never abandoned for a new
        connection: the old session may still hold the lock, and a new one would then report it lost."""
        with self._mutex:
            if self._closed:
                return None
            conn, probe = self._conn, self._probe
            if probe is None and conn is not None and not conn.closed:
                probe = self._probe = _Probe(conn)
        if probe is not None:
            if not probe.done.wait(LOCK_PROBE_TIMEOUT_S):
                if not probe.warned:
                    probe.warned = True
                    log.warning(
                        "the worker-id lock's connection has not answered for %.0f s; treating the lock as "
                        "unknown until it does or the connection fails",
                        LOCK_PROBE_TIMEOUT_S,
                    )
                return None
            with self._mutex:
                if self._probe is probe:
                    self._probe = None
            if probe.error is None:
                return True
            if not isinstance(probe.error, psycopg.Error):
                raise probe.error
            self._drop(probe.conn)
        return self._retake()

    def _retake(self) -> bool | None:
        try:
            conn = _take(self._url, self._key)
        except psycopg.Error:
            return None
        with self._mutex:
            closed = self._closed
            if not closed:
                self._conn = conn
        if closed:  # close() ran while this was connecting: keeping the connection would keep the lock
            if conn is not None:
                _close_quietly(conn)
            return None
        if conn is None:
            return False
        log.warning("the worker-id lock was lost with the database connection and has been taken again")
        return True

    def _drop(self, conn: _Conn) -> None:
        with self._mutex:
            if self._conn is conn:
                self._conn = None
        _close_quietly(conn)

    def close(self) -> None:
        """Release the lock. Never blocks on the network: a connection a probe is still waiting on is
        closed by that probe when its query returns (or by the OS when the process exits)."""
        with self._mutex:
            self._closed = True
            conn, self._conn = self._conn, None
            probe, self._probe = self._probe, None
        if probe is not None and probe.conn is conn:
            probe.close_when_done()
        elif conn is not None:
            _close_quietly(conn)


def _take(database_url: str, key: str) -> _Conn | None:
    conn: _Conn = psycopg.connect(database_url, autocommit=True, **LOCK_CONNECT_OPTIONS)  # pyright: ignore[reportArgumentType]
    try:
        conn.execute(_SERVER_KEEPALIVES, _SERVER_KEEPALIVE_VALUES)
        row = conn.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (key,)).fetchone()
    except BaseException:
        conn.close()
        raise
    if row is not None and row[0] is True:
        return conn
    conn.close()
    return None


LOCK_CHECK_INTERVAL_S = 10.0
LOCK_RETRY_INTERVAL_S = 5.0


def acquire_with_grace(
    database_url: str,
    worker_id: str,
    grace_s: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> WorkerIdLock | None:
    """``WorkerIdLock.acquire``, retried for up to ``grace_s`` while another session holds the id.

    After a power loss or a network cut that session is this worker's own, dead one, and the database drops it
    about a minute after its last packet. Waiting for that is what lets a reboot recover by itself instead of
    exiting 2 into Docker's restart loop. An unreachable database raises at once, as ``acquire`` does.
    """
    deadline = clock() + grace_s
    waited = False
    while True:
        lock = WorkerIdLock.acquire(database_url, worker_id)
        if lock is not None:
            if waited:
                log.info("the worker-id lock for %r was released; continuing", worker_id)
            return lock
        remaining = deadline - clock()
        if remaining <= 0:
            return None
        if not waited:
            waited = True
            log.warning(
                "the worker-id lock for %r is held by another database session. If this VM just lost power "
                "or its network that is its own previous session, which the database drops within about "
                "a minute; waiting up to %.0f s for it",
                worker_id,
                grace_s,
            )
        sleep(min(LOCK_RETRY_INTERVAL_S, remaining))


def watch_lock(
    lock: WorkerIdLock, stop: threading.Event, interval_s: float, on_lost: Callable[[], None]
) -> None:
    """Check the lock every ``interval_s`` until ``stop`` is set, calling ``on_lost`` once if another
    process takes the worker id."""
    while not stop.wait(interval_s):
        if lock.still_held() is False:
            on_lost()
            return
