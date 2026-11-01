"""deploy/server/sync-repo.sh: the deploy host mirrors origin/main. A fast-forward pull stopped every
deploy the day history was rewritten; this resets instead, but never over uncommitted edits, never touches
untracked files (the secrets live there), and says what it dropped."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "server" / "sync-repo.sh"
ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


def git(cwd: Path, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=cwd, env=ENV, capture_output=True, text=True, check=True)
    return done.stdout.strip()


def commit(repo: Path, name: str, text: str, message: str) -> None:
    (repo / name).write_text(text)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", message)


def sync(repo: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f'source "{SCRIPT}"; sync_repo "$@"', "sync", str(repo), *extra],
        env=ENV,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def pair(tmp_path: Path) -> tuple[Path, Path]:
    """(origin work tree that is pushed from, the server's clone)."""
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    work = tmp_path / "work"
    git(tmp_path, "clone", "-q", str(origin), str(work))
    git(work, "checkout", "-q", "-b", "main")
    commit(work, "a.txt", "one\n", "first")
    git(work, "push", "-q", "origin", "main")
    server = tmp_path / "server"
    git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(server))
    return work, server


def test_a_new_commit_on_origin_is_picked_up(pair: tuple[Path, Path]) -> None:
    work, server = pair
    commit(work, "a.txt", "two\n", "second")
    git(work, "push", "-q", "origin", "main")
    done = sync(server)
    assert done.returncode == 0, done.stderr
    assert (server / "a.txt").read_text() == "two\n"
    assert git(server, "rev-parse", "HEAD") == git(work, "rev-parse", "HEAD")


def test_already_up_to_date_is_quiet_and_fine(pair: tuple[Path, Path]) -> None:
    _, server = pair
    done = sync(server)
    assert done.returncode == 0 and done.stdout == "" and done.stderr == ""


def test_rewritten_history_no_longer_stops_the_deploy_and_the_dropped_commits_are_named(
    pair: tuple[Path, Path],
) -> None:
    work, server = pair
    commit(server, "local.txt", "x\n", "a commit made on the server")
    # origin's history is rewritten: the same first commit, amended, then a second.
    git(work, "commit", "-q", "--amend", "-m", "first, reworded")
    commit(work, "a.txt", "three\n", "third")
    git(work, "push", "-q", "--force", "origin", "main")
    # The old behaviour: a fast-forward pull cannot do this.
    pull = subprocess.run(["git", "pull", "--ff-only"], cwd=server, env=ENV, capture_output=True)
    assert pull.returncode != 0
    done = sync(server)
    assert done.returncode == 0, done.stderr
    assert git(server, "rev-parse", "HEAD") == git(work, "rev-parse", "HEAD")
    assert (server / "a.txt").read_text() == "three\n" and not (server / "local.txt").exists()
    assert "a commit made on the server" in done.stderr, "the dropped commit is named"


def test_uncommitted_edits_to_tracked_files_stop_it_and_are_kept(pair: tuple[Path, Path]) -> None:
    work, server = pair
    (server / "a.txt").write_text("hand edit\n")
    commit(work, "a.txt", "two\n", "second")
    git(work, "push", "-q", "origin", "main")
    before = git(server, "rev-parse", "HEAD")
    done = sync(server)
    assert done.returncode != 0 and "uncommitted" in done.stderr
    assert (server / "a.txt").read_text() == "hand edit\n"
    assert git(server, "rev-parse", "HEAD") == before


def test_untracked_files_such_as_secrets_are_never_touched(pair: tuple[Path, Path]) -> None:
    work, server = pair
    (server / "secrets").mkdir()
    (server / "secrets" / "api.env").write_text("TOKEN=keep\n")
    git(work, "commit", "-q", "--amend", "-m", "rewritten")
    git(work, "push", "-q", "--force", "origin", "main")
    done = sync(server)
    assert done.returncode == 0, done.stderr
    assert (server / "secrets" / "api.env").read_text() == "TOKEN=keep\n"


def test_a_missing_directory_is_an_error_not_a_silent_skip(tmp_path: Path) -> None:
    done = sync(tmp_path / "nope")
    assert done.returncode != 0 and "not a git checkout" in done.stderr


def test_another_branch_name_can_be_given(pair: tuple[Path, Path]) -> None:
    work, server = pair
    git(work, "checkout", "-q", "-b", "stable")
    commit(work, "b.txt", "b\n", "on stable")
    git(work, "push", "-q", "origin", "stable")
    git(server, "fetch", "-q", "origin", "stable")
    git(server, "checkout", "-q", "-b", "stable", "origin/stable~1")
    done = sync(server, "stable")
    assert done.returncode == 0, done.stderr
    assert (server / "b.txt").read_text() == "b\n"
