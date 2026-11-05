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
        os.chmod(dirpath, 0o700)
        for name in dirnames:
            child = os.path.join(dirpath, name)
            if not os.path.islink(child):
                os.chmod(child, 0o700)
    shutil.rmtree(path)


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


# How the lock's connection notices that the other end is gone. Without keepalives a worker VM that loses
# power or its network sends no FIN, so its backend, and the advisory lock it holds, stay alive until the OS
# gives up on the socket (about two hours): the restarted worker is refused its own id ("already running") all
# that time. The `options` set the server's side of this one session (the backend's socket, which is what
# holds the lock); the libpq keywords set the worker's own side, so a dead database is noticed too instead of
# a call hanging. Every value is user-settable, so the restricted mergit_worker role can set them. Roughly a
# minute either way.
LOCK_KEEPALIVE_IDLE_S = 30
LOCK_KEEPALIVE_INTERVAL_S = 10
LOCK_KEEPALIVE_COUNT = 3
LOCK_TCP_USER_TIMEOUT_MS = 60_000


def _connect_for_lock(database_url: str) -> psycopg.Connection[tuple[object, ...]]:
    server_side = (
        f"-c tcp_keepalives_idle={LOCK_KEEPALIVE_IDLE_S}"
        f" -c tcp_keepalives_interval={LOCK_KEEPALIVE_INTERVAL_S}"
        f" -c tcp_keepalives_count={LOCK_KEEPALIVE_COUNT}"
        f" -c tcp_user_timeout={LOCK_TCP_USER_TIMEOUT_MS}"
    )
    return psycopg.connect(  # pyright: ignore[reportArgumentType]
        database_url,
        autocommit=True,
        # Without a timeout, a database that is down or unreachable (a dead host, a network partition) hangs
        # this call forever instead of letting start-up fail and Docker's restart policy retry it.
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=LOCK_KEEPALIVE_IDLE_S,
        keepalives_interval=LOCK_KEEPALIVE_INTERVAL_S,
        keepalives_count=LOCK_KEEPALIVE_COUNT,
        tcp_user_timeout=LOCK_TCP_USER_TIMEOUT_MS,
        options=server_side,
    )


class WorkerIdLock:
    """A session-level Postgres advisory lock named for the worker id, held while the process lives.

    A worker id must belong to one process. At start-up a worker fails every job still ``running`` under its
    id and removes every sandbox container labelled with it, so a second process sharing the id would
    destroy the first one's live work. Postgres releases the lock when the connection ends, whether the
    process exits cleanly or is killed, so a crashed worker never blocks its own restart. A worker VM that
    dies without closing its socket (power loss, a partition) is covered by the keepalives above: its backend,
    and so the lock, is dropped within about a minute instead of hours.

    A live ``cp_postgres`` restart is a different failure: the database closes every session cleanly, which
    drops the lock out from under a worker that is otherwise still healthy. ``still_held`` notices that,
    reconnects and takes the lock again, and reports False only when another process has taken the id in the
    meantime: that process has already failed this one's jobs, so this one must stop.
    """

    def __init__(self, conn: psycopg.Connection[tuple[object, ...]], database_url: str, key: str) -> None:
        self._conn: psycopg.Connection[tuple[object, ...]] | None = conn
        self._url = database_url
        self._key = key

    @classmethod
    def acquire(cls, database_url: str, worker_id: str) -> WorkerIdLock | None:
        key = f"mergit_worker:{worker_id}"
        conn = _take(database_url, key)
        return None if conn is None else cls(conn, database_url, key)

    def still_held(self) -> bool | None:
        """True while the lock is held, False once another process owns the id, None while the database
        cannot be reached (try again later: nothing can have taken the id from a database that is down)."""
        try:
            if self._conn is not None and not self._conn.closed:
                self._conn.execute("SELECT 1")
                return True
        except psycopg.Error:
            self._drop()
        try:
            self._conn = _take(self._url, self._key)
        except psycopg.Error:
            return None
        if self._conn is None:
            return False
        log.warning("the worker-id lock was lost with the database connection and has been taken again")
        return True

    def _drop(self) -> None:
        if self._conn is not None:
            with contextlib.suppress(psycopg.Error):
                self._conn.close()
        self._conn = None

    def close(self) -> None:
        self._drop()


def _take(database_url: str, key: str) -> psycopg.Connection[tuple[object, ...]] | None:
    # The same keepalives as a fresh acquire: a retake after a database restart must still be noticed if the
    # VM that holds it then dies without closing its socket.
    conn = _connect_for_lock(database_url)
    try:
        row = conn.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (key,)).fetchone()
    except BaseException:
        conn.close()
        raise
    if row is not None and row[0] is True:
        return conn
    conn.close()
    return None


LOCK_CHECK_INTERVAL_S = 10.0
# Worst case, one still_held() call blocks for the keepalives' own detection window (idle + interval * count)
# before it gives up on a dead connection and retakes the lock; the watcher must be given at least that long
# to notice ``stop`` and return before the process closes the lock out from under it. A margin on top for the
# retake itself.
WATCHER_JOIN_S = 10 + LOCK_KEEPALIVE_IDLE_S + LOCK_KEEPALIVE_INTERVAL_S * LOCK_KEEPALIVE_COUNT + 5


def watch_lock(
    lock: WorkerIdLock, stop: threading.Event, interval_s: float, on_lost: Callable[[], None]
) -> None:
    """Check the lock every ``interval_s`` until ``stop`` is set, calling ``on_lost`` once if another
    process takes the worker id."""
    while not stop.wait(interval_s):
        if lock.still_held() is False:
            on_lost()
            return
