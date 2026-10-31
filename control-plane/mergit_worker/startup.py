"""Start-up checks and housekeeping for one worker process (plan task O10).

The worker runs on its own VM, restarted by Docker and redeployed by hand, so what it leaves behind when it
stops has to be cleaned up by the next start: jobs, sandbox containers (sandbox.reap_stale) and workspace
directories (here). Everything below is a plain function over a path, an environment or a database URL, so it
is tested without a Docker daemon.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
from collections.abc import Mapping
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


class WorkerIdLock:
    """A session-level Postgres advisory lock named for the worker id, held while the process lives.

    A worker id must belong to one process. At start-up a worker fails every job still ``running`` under its
    id and removes every sandbox container labelled with it, so a second process sharing the id would
    destroy the first one's live work. Postgres releases the lock when the connection ends, whether the
    process exits cleanly or is killed, so a crashed worker never blocks its own restart.
    """

    def __init__(self, conn: psycopg.Connection[tuple[object, ...]]) -> None:
        self._conn = conn

    @classmethod
    def acquire(cls, database_url: str, worker_id: str) -> WorkerIdLock | None:
        conn = psycopg.connect(database_url, autocommit=True)  # pyright: ignore[reportArgumentType]
        row = conn.execute(
            "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (f"mergit_worker:{worker_id}",)
        ).fetchone()
        if row is not None and row[0] is True:
            return cls(conn)
        conn.close()
        return None

    def close(self) -> None:
        self._conn.close()
