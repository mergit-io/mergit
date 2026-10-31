"""Start-up checks and housekeeping for a worker that lives on its own VM (plan task O10)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from mergit_worker.config import ConfigError
from mergit_worker.startup import agents_without_key, sweep_workspaces

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
