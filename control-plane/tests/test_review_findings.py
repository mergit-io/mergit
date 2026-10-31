"""Regression tests for the four findings in issue #31 (left open by the review of #14).

The sandbox tests drive the real `Sandbox.run` with a fake Docker API, so a daemon that wedges can be
simulated without one. Each test names what it would catch if the fix were removed.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from mergit_worker import sandbox as sandbox_mod
from mergit_worker.llm import ToolCall
from mergit_worker.meter import Cost
from mergit_worker.models import OUTPUT_CAP_BYTES, TRUNCATION_MARKER, cap_output, truncation_marker
from mergit_worker.phi import run_phi
from mergit_worker.sandbox import Sandbox, SandboxConfig, SandboxError
from mergit_worker.tools import ToolBox, ToolLimits
from mergit_worker.workspace import GitLimits, WorkspaceError, _find_name
from tests.support import ProcessSandbox, phi

# -- 1. a stuck daemon after the restart must not wedge the worker --------------------------------------


class FakeContainer:
    id = "c1"

    def __init__(self, on_kill: threading.Event, start_error: Exception | None = None) -> None:
        self.calls: list[str] = []
        self._on_kill = on_kill
        self._start_error = start_error

    def kill(self) -> None:
        self.calls.append("kill")
        self._on_kill.set()

    def start(self) -> None:
        self.calls.append("start")
        if self._start_error:
            raise self._start_error


class FakeApi:
    """exec_start streams one chunk, then blocks until `release` is set (a command still running)."""

    def __init__(self, release: threading.Event, honours_kill: bool) -> None:
        self.release = release
        self.honours_kill = honours_kill

    def exec_create(self, *_a: Any, **_k: Any) -> dict[str, str]:
        return {"Id": "e1"}

    def exec_start(self, *_a: Any, **_k: Any) -> Iterator[tuple[bytes | None, bytes | None]]:
        yield b"partial output", None
        self.release.wait(60)  # a stream that never ends unless the container is killed (or the test ends)

    def exec_inspect(self, _id: str) -> dict[str, int]:
        return {"ExitCode": 0}


class FakeClient:
    def __init__(self, api: FakeApi) -> None:
        self.api = api


def make_sandbox(tmp_path: Path, *, honours_kill: bool, start_error: Exception | None = None):
    release = threading.Event()
    container = FakeContainer(release if honours_kill else threading.Event(), start_error)
    cfg = SandboxConfig(
        image="x", memory="1g", nano_cpus=1, pids_limit=1, runtime=None, max_output_bytes=1000,
        workspace_root=tmp_path, git=GitLimits(("file",), 5.0), owner="t",
    )  # fmt: skip
    api = FakeApi(release, honours_kill)
    sbx = Sandbox(object(), container, cfg, FakeClient(api))  # type: ignore[arg-type]
    return sbx, container, release


def test_a_healthy_kill_ends_the_stream_and_reports_the_timeout(tmp_path: Path) -> None:
    sbx, container, _ = make_sandbox(tmp_path, honours_kill=True)
    result = sbx.run(["sleep", "99"], ".", 1)
    assert result.timed_out and result.exit_code == -1
    assert result.stdout == b"partial output"
    assert container.calls == ["kill", "start"]


def test_a_stream_that_never_ends_cannot_wedge_the_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before the fix this line was `future.result()` with no timeout, and the executor's `with` block waited
    for the stuck thread again on the way out: the call below never returned."""
    monkeypatch.setattr(sandbox_mod, "_STREAM_END_AFTER_KILL_S", 0.3)
    sbx, container, release = make_sandbox(tmp_path, honours_kill=False)
    done: list[object] = []
    t = threading.Thread(target=lambda: done.append(sbx.run(["sleep", "99"], ".", 1)), daemon=True)
    started = time.monotonic()
    t.start()
    t.join(10)
    release.set()  # let the abandoned reader thread finish
    assert not t.is_alive(), "Sandbox.run is wedged on a stream the daemon never ended"
    assert time.monotonic() - started < 5
    result = done[0]
    assert result.timed_out and result.stdout == b"partial output"  # type: ignore[attr-defined]
    assert container.calls == ["kill", "start"], "the container must still have been killed and restarted"


def test_the_sandbox_is_usable_again_after_an_abandoned_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox_mod, "_STREAM_END_AFTER_KILL_S", 0.2)
    sbx, _, release = make_sandbox(tmp_path, honours_kill=False)
    sbx.run(["sleep", "99"], ".", 1)
    assert sbx._lock.acquire(timeout=1), "the sandbox lock must be released after an abandoned stream"
    sbx._lock.release()
    release.set()


def test_a_restart_that_fails_is_a_sandbox_error_not_a_hang_or_a_raw_docker_error(tmp_path: Path) -> None:
    sbx, _, release = make_sandbox(tmp_path, honours_kill=False, start_error=ConnectionError("daemon gone"))
    with pytest.raises(SandboxError, match="could not be restarted"):
        sbx.run(["sleep", "99"], ".", 1)
    release.set()


# -- 2. the nested-.git scan is capped, and a cap means refuse, never "none found" ----------------------


def test_the_scan_still_finds_a_nested_git(tmp_path: Path) -> None:
    (tmp_path / "a" / "b").mkdir(parents=True)
    (tmp_path / "a" / "b" / ".git").write_text("x")
    assert _scan(tmp_path) == "a/b/.git"


def test_a_clean_tree_under_the_cap_has_no_nested_git(tmp_path: Path) -> None:
    for i in range(20):
        (tmp_path / f"f{i}").write_text("x")
    assert _scan(tmp_path, limit=1000) is None


def test_a_tree_over_the_cap_is_refused_not_passed(tmp_path: Path) -> None:
    """The dangerous version of this fix returns None at the cap: a `.git` planted after the cutoff would
    then be missed and git would run over it. The scan must raise instead."""
    for i in range(50):
        (tmp_path / f"f{i:02d}").write_text("x")
    with pytest.raises(WorkspaceError, match="more than 10 entries"):
        _scan(tmp_path, limit=10)


def test_a_git_planted_after_the_cap_is_never_reported_as_absent(tmp_path: Path) -> None:
    for i in range(50):
        (tmp_path / f"d{i:02d}").mkdir()
    (tmp_path / "zzz").mkdir()
    (tmp_path / "zzz" / ".git").write_text("gitdir: /hostile\n")
    with pytest.raises(WorkspaceError):
        _scan(tmp_path, limit=10)  # raises; the one outcome it must not have is returning None


def test_the_cap_is_on_entries_not_directories_so_one_huge_folder_is_bounded(tmp_path: Path) -> None:
    wide = tmp_path / "wide"
    wide.mkdir()
    for i in range(200):
        (wide / f"{i}.txt").write_text("x")
    with pytest.raises(WorkspaceError):
        _scan(tmp_path, limit=50)


def test_a_deep_chain_is_bounded_by_the_same_cap(tmp_path: Path) -> None:
    d = tmp_path
    for _ in range(60):
        d = d / "d"
        d.mkdir()
    with pytest.raises(WorkspaceError):
        _scan(tmp_path, limit=20)


def test_the_default_cap_is_generous_enough_for_a_real_repository(sandbox: ProcessSandbox) -> None:
    assert sandbox.workspace.changed_paths() == []  # a normal checkout is nowhere near the default cap


def test_a_scan_the_os_refuses_is_a_workspace_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import mergit_worker.workspace as ws

    (tmp_path / "sub").mkdir()

    def boom(*_a: Any, **_k: Any) -> int:
        raise OSError(24, "Too many open files")

    monkeypatch.setattr(ws, "_openat", boom)
    with pytest.raises(WorkspaceError, match="cannot scan"):
        _scan(tmp_path)


def test_an_oversized_checkout_makes_phi_inconclusive_not_a_crash(
    sandbox: ProcessSandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mergit_worker.workspace as ws

    monkeypatch.setattr(ws, "_MAX_SCAN_ENTRIES", 1)
    run = run_phi(sandbox, phi(), 1000, 1000)
    assert run.holds is None and run.result["exit_code"] == -1  # a person decides, never a guess


def _scan(root: Path, limit: int | None = None) -> str | None:
    import os

    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        return _find_name(fd, ".git", limit)
    finally:
        os.close(fd)


# -- 3. the truncation marker names the cap that was applied --------------------------------------------


def test_the_default_marker_is_exactly_the_literal_the_spec_fixes() -> None:
    assert TRUNCATION_MARKER == b"\n[mergit: output truncated at 1048576 bytes]\n"
    assert truncation_marker(OUTPUT_CAP_BYTES) == TRUNCATION_MARKER


def test_the_default_cap_ships_the_spec_marker() -> None:
    out = cap_output(b"a" * (OUTPUT_CAP_BYTES + 1))
    assert out == b"a" * OUTPUT_CAP_BYTES + TRUNCATION_MARKER


@pytest.mark.parametrize("cap", [1, 100, 4096, 2_000_000])
def test_a_custom_cap_ships_a_marker_that_names_it(cap: int) -> None:
    out = cap_output(b"a" * (cap + 1), cap)
    assert out == b"a" * cap + f"\n[mergit: output truncated at {cap} bytes]\n".encode()
    assert b"1048576" not in out or cap == OUTPUT_CAP_BYTES


def test_output_at_the_cap_is_untouched_whatever_the_cap() -> None:
    assert cap_output(b"a" * 100, 100) == b"a" * 100


# -- 4. SandboxError is one failed step and one inconclusive Φ, never an aborted task -------------------


class RaisingSandbox(ProcessSandbox):
    def run(self, argv: list[str], workdir: str, timeout_s: int) -> Any:
        raise SandboxError("argv must be a non-empty list of strings")

    def reset_processes(self) -> None:
        pass


def test_a_sandbox_error_from_a_tool_call_is_recorded_as_one_failed_step(sandbox: ProcessSandbox) -> None:
    rows: list[tuple[str, bytes, bytes, int | None, Cost]] = []

    def record(step_type: str, inp: bytes, out: bytes, status: int | None, cost: Cost) -> int:
        rows.append((step_type, inp, out, status, cost))
        return len(rows)

    raising = RaisingSandbox(sandbox.workspace)
    box = ToolBox(raising, record, ToolLimits(5, 1000, 100, 1024))
    outcome = box.execute(ToolCall("t1", "run_command", {"argv": ["true"]}))
    assert outcome.is_error and not outcome.finished
    assert len(rows) == 1, "a failure is still exactly one receipt step"
    assert b"non-empty list" in rows[0][2]


def test_a_nul_byte_in_argv_is_a_failed_step_through_the_real_sandbox_check(tmp_path: Path) -> None:
    sbx, _, release = make_sandbox(tmp_path, honours_kill=True)
    rows: list[Any] = []
    box = ToolBox(sbx, lambda *a: rows.append(a) or len(rows), ToolLimits(5, 1000, 100, 1024))  # type: ignore[arg-type]
    outcome = box.execute(ToolCall("t1", "run_command", {"argv": ["echo", "a\x00b"]}))
    release.set()
    assert outcome.is_error and len(rows) == 1


def test_a_sandbox_error_while_running_phi_is_inconclusive_not_an_aborted_task(
    sandbox: ProcessSandbox,
) -> None:
    run = run_phi(RaisingSandbox(sandbox.workspace), phi(), 1000, 1000)
    assert run.result["exit_code"] == -1
    assert run.holds is None
