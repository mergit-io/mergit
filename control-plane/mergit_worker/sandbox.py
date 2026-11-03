"""Docker sandbox for everything the model causes to execute.

The container has no network, no secrets, one volume (the checkout), CPU, memory and pid limits, a
read-only root filesystem and no capabilities. gVisor is selected with `runtime="runsc"`.
A command that exceeds its time limit kills the whole container (every process in it), and the
container is started again on the same checkout, so no stray process survives a timeout.
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import docker
import docker.errors
from docker.models.containers import Container

from .models import CommandResult
from .workspace import GitLimits, Workspace, relative_parts

_OCI_EXEC_FAILED = b"OCI runtime exec failed"
LABEL = "mergit.sandbox"
WORKSPACE_MOUNT = "/workspace"
# The only environment the container gets. None of it is secret; it keeps test runners from writing
# caches into the checkout, which would show up as changed paths and fail an `allowed_paths` check.
SANDBOX_ENV = {
    "HOME": "/tmp",  # noqa: S108  # the container's own tmpfs
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTEST_ADDOPTS": "-p no:cacheprovider",
    "NO_COLOR": "1",
}


# How long to wait for an exec stream to end once its container was killed. A healthy daemon ends it at once.
_STREAM_END_AFTER_KILL_S = 30.0

log = logging.getLogger(__name__)


class SandboxError(Exception):
    """The sandbox could not be created or used."""


class SandboxPort(Protocol):
    """What the harness needs from a sandbox. `Sandbox` is the production implementation; tests that do
    not need isolation provide a process-based stand-in."""

    workspace: Workspace

    def run(self, argv: list[str], workdir: str, timeout_s: int) -> CommandResult: ...
    def reset_processes(self) -> None: ...
    def destroy(self) -> None: ...


@dataclass(frozen=True, slots=True)
class SandboxConfig:
    image: str
    memory: str
    nano_cpus: int
    pids_limit: int
    runtime: str | None
    max_output_bytes: int
    workspace_root: Path
    git: GitLimits
    owner: str  # worker id; a restarted worker reaps only its own containers


class Sandbox:
    def __init__(
        self,
        workspace: Workspace,
        container: Container,
        cfg: SandboxConfig,
        client: docker.DockerClient,
    ) -> None:
        self.workspace = workspace
        self._container = container
        self._cfg = cfg
        self._api: Any = client.api
        self._lock = threading.Lock()

    # -- lifecycle -----------------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        repo_url: str,
        ref: str,
        cfg: SandboxConfig,
        client: docker.DockerClient | None = None,
    ) -> Sandbox:
        dc = client or docker.from_env()
        try:
            dc.images.get(cfg.image)
        except docker.errors.ImageNotFound as exc:
            raise SandboxError(f"sandbox image {cfg.image!r} is not built on this host") from exc
        workspace = Workspace.clone(repo_url, ref, cfg.workspace_root, cfg.git)
        try:
            container = _create_container(dc, workspace.work, cfg)
            container.start()
        except BaseException:
            workspace.destroy()
            raise
        return cls(workspace, container, cfg, dc)

    def destroy(self) -> None:
        with contextlib.suppress(docker.errors.APIError):
            self._container.remove(force=True, v=True)
        self.workspace.destroy()

    @property
    def container_id(self) -> str | None:
        return self._container.id

    def reset_processes(self) -> None:
        """Kill every process in the container and start it again. Files on the checkout stay."""
        with self._lock:
            self._restart()

    def inspect_env(self) -> list[str]:
        """The environment the container was created with, for tests and audits."""
        self._container.reload()
        return list(self._container.attrs["Config"]["Env"] or [])

    # -- commands ------------------------------------------------------------------------------

    def run(self, argv: list[str], workdir: str, timeout_s: int) -> CommandResult:
        if not argv or any("\x00" in a for a in argv):
            raise SandboxError("argv must be a non-empty list of strings")
        parts = relative_parts(workdir)
        cwd = "/".join([WORKSPACE_MOUNT, *parts])
        with self._lock:
            return self._run_locked(argv, cwd, timeout_s)

    def _run_locked(self, argv: list[str], cwd: str, timeout_s: int) -> CommandResult:
        api = self._api
        started = time.monotonic()
        try:
            exec_id = api.exec_create(
                self._container.id, argv, workdir=cwd, user=_user(), stdout=True, stderr=True
            )["Id"]
        except docker.errors.APIError as exc:
            return _not_started(str(exc), started)
        cap = self._cfg.max_output_bytes
        out, err = _Capture(cap), _Capture(cap)
        error: list[BaseException] = []

        def pump() -> None:
            try:
                stream: Iterator[tuple[bytes | None, bytes | None]] = api.exec_start(
                    exec_id, stream=True, demux=True
                )
                for o, e in stream:
                    if o:
                        out.add(o)
                    if e:
                        err.add(e)
            except BaseException as exc:  # reported to the caller below
                error.append(exc)

        # A daemon thread, not an executor: an executor's `with` block waits for its thread on exit, so a
        # stream the daemon never ends would hang the worker there however the wait above is bounded.
        pumper = threading.Thread(target=pump, name="sandbox-exec-pump", daemon=True)
        pumper.start()
        pumper.join(timeout_s)
        if pumper.is_alive():
            try:
                self._restart()  # kills the process tree; the pump's stream then normally ends
            except Exception as exc:  # a stuck or refusing daemon: say so, do not hang or crash the worker
                raise SandboxError(
                    f"command timed out and the sandbox could not be restarted: {exc}"
                ) from exc
            pumper.join(_STREAM_END_AFTER_KILL_S)
            if pumper.is_alive():
                # The container is killed and started again, so nothing the command ran survives; only the
                # stream reader is stuck. It is abandoned (daemon) and what it captured so far is returned.
                log.warning(
                    "exec stream did not end %.0fs after the sandbox was restarted", _STREAM_END_AFTER_KILL_S
                )
            return CommandResult(-1, out.bytes(), err.bytes(), _ms(started), timed_out=True)
        if error:
            exc = error[0]
            if isinstance(exc, docker.errors.APIError):
                return _not_started(str(exc), started)
            raise SandboxError(f"exec stream failed: {exc}") from exc
        code = api.exec_inspect(exec_id).get("ExitCode")
        if code in (126, 127) and out.bytes().startswith(_OCI_EXEC_FAILED):
            # The daemon reports an executable it could not start as ordinary output with exit 126/127.
            return _not_started(out.bytes().decode("utf-8", "replace").strip(), started)
        return CommandResult(-1 if code is None else int(code), out.bytes(), err.bytes(), _ms(started))

    def _restart(self) -> None:
        with contextlib.suppress(docker.errors.APIError):  # already stopped
            self._container.kill()
        self._container.start()


class _Capture:
    """Keeps the first `cap + 1` bytes (so truncation is detectable) and drains the rest."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._buf = bytearray()

    def add(self, chunk: bytes) -> None:
        room = self._cap + 1 - len(self._buf)
        if room > 0:
            self._buf += chunk[:room]

    def bytes(self) -> bytes:
        return bytes(self._buf)


def _user() -> str:
    return f"{os.getuid()}:{os.getgid()}"


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _not_started(message: str, started: float) -> CommandResult:
    return CommandResult(127, b"", message.encode(), _ms(started), could_not_start=True)


def _create_container(dc: docker.DockerClient, work: Path, cfg: SandboxConfig) -> Container:
    kwargs: dict[str, object] = {
        "image": cfg.image,
        "command": ["sleep", "infinity"],
        "name": f"mergit-sbx-{uuid.uuid4().hex[:12]}",
        "detach": True,
        "network_mode": "none",
        "mem_limit": cfg.memory,
        "memswap_limit": cfg.memory,
        "nano_cpus": cfg.nano_cpus,
        "pids_limit": cfg.pids_limit,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges"],
        "read_only": True,
        "tmpfs": {"/tmp": "rw,size=512m,mode=1777"},  # noqa: S108
        "user": _user(),
        "working_dir": WORKSPACE_MOUNT,
        "volumes": {str(work): {"bind": WORKSPACE_MOUNT, "mode": "rw"}},
        "environment": dict(SANDBOX_ENV),
        "labels": {LABEL: cfg.owner},
    }
    if cfg.runtime:
        kwargs["runtime"] = cfg.runtime
    try:
        return dc.containers.create(**kwargs)  # type: ignore[arg-type]
    except docker.errors.APIError as exc:
        raise SandboxError(f"cannot create sandbox container: {exc}") from exc


def reap_stale(owner: str, client: docker.DockerClient | None = None) -> int:
    """Remove sandbox containers a crashed worker left behind. Only this worker's own, by label."""
    dc = client or docker.from_env()
    removed = 0
    for c in dc.containers.list(all=True, filters={"label": f"{LABEL}={owner}"}):
        try:
            c.remove(force=True, v=True)
            removed += 1
        except docker.errors.APIError:
            continue
    return removed
