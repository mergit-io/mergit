from __future__ import annotations

import os
from pathlib import Path

import pytest

from mergit_worker.workspace import (
    GitLimits,
    Workspace,
    WorkspaceError,
    relative_parts,
    validate_ref,
    validate_repo_url,
)
from tests.support import LOCAL_GIT, ProcessSandbox


def test_clone_records_head_and_checks_out_files(sandbox: ProcessSandbox):
    assert len(sandbox.workspace.head) == 40
    assert (sandbox.workspace.work / "payments" / "refund.py").exists()
    assert not (sandbox.workspace.work / ".git").exists()  # git metadata is outside the mount


@pytest.mark.parametrize(
    "url", ["", "-oProxyCommand=x", "ext::sh -c id", "git@github.com:a/b.git", "http://a/b", "https://a b/c"]
)
def test_repo_url_rejected(url: str):
    with pytest.raises(WorkspaceError):
        validate_repo_url(url, ("https",))


def test_https_url_accepted():
    validate_repo_url("https://github.com/mergit-io/mergit.git", ("https",))


@pytest.mark.parametrize("ref", ["", "--upload-pack=x", "-x", "a..b", "a b", "a;b", "$(id)"])
def test_ref_rejected(ref: str):
    with pytest.raises(WorkspaceError):
        validate_ref(ref)


@pytest.mark.parametrize("ref", ["main", "feature/x-1", "v1.2.3", "a" * 40])
def test_ref_accepted(ref: str):
    validate_ref(ref)


@pytest.mark.parametrize("rel", ["/etc/passwd", "../x", "a/../../x", "a\x00b"])
def test_path_escape_rejected(rel: str):
    with pytest.raises(WorkspaceError):
        relative_parts(rel)


def test_clone_failure_leaves_nothing_behind(tmp_path: Path, repo_url: str):
    root = tmp_path / "ws"
    with pytest.raises(WorkspaceError):
        Workspace.clone(repo_url, "no-such-branch", root, LOCAL_GIT)
    assert list(root.iterdir()) == []


def test_scheme_not_in_allowlist_is_refused(tmp_path: Path, repo_url: str):
    with pytest.raises(WorkspaceError, match="scheme"):
        Workspace.clone(repo_url, "main", tmp_path / "ws", GitLimits(("https",), 30))


def test_destroy_removes_a_directory_the_container_left_unwritable(tmp_path: Path, repo_url: str):
    """The container runs as our own uid, so a directory it left with an unhelpful mode (for example a
    deliberate `chmod 000`) must not make `destroy` silently leave part of the workspace on disk."""
    ws = Workspace.clone(repo_url, "main", tmp_path / "ws", LOCAL_GIT)
    base = ws.work.parent
    locked = ws.work / "locked"
    locked.mkdir()
    (locked / "inside").write_text("x")
    locked.chmod(0o000)
    ws.destroy()
    assert not base.exists()


def test_changed_paths_covers_modified_added_deleted_sorted(sandbox: ProcessSandbox):
    ws = sandbox.workspace
    ws.write_file("payments/refund.py", b"changed\n")
    ws.write_file("new/dir/file.txt", b"x")
    (ws.work / "docs" / "notes.md").unlink()
    assert ws.changed_paths() == ["docs/notes.md", "new/dir/file.txt", "payments/refund.py"]


def test_changed_paths_empty_when_untouched(sandbox: ProcessSandbox):
    assert sandbox.workspace.changed_paths() == []


def test_changed_paths_includes_gitignored_files(sandbox: ProcessSandbox):
    """A `.gitignore` must not be a way to hide a real change from the `allowed_paths` check, so an
    ignored path still counts as changed."""
    sandbox.workspace.write_file(".gitignore", b"payments/\n")
    sandbox.workspace.write_file("payments/refund.py", b"changed\n")
    assert "payments/refund.py" in sandbox.workspace.changed_paths()


def test_diff_from_head_includes_gitignored_files(sandbox: ProcessSandbox):
    """The same file `changed_paths` now counts as changed must not then silently drop out of the
    stored patch (used for the PR and passed on to a dependent task's checkout)."""
    sandbox.workspace.write_file(".gitignore", b"payments/\n")
    sandbox.workspace.write_file("payments/refund.py", b"changed\n")
    diff = sandbox.workspace.diff_from_head()
    assert "payments/refund.py" in diff
    assert "changed" in diff


def test_planted_git_file_is_refused_not_silently_worked_around(sandbox: ProcessSandbox, tmp_path: Path):
    """The container could write a `.git` that points at a hostile git dir with a code-running config.
    Refusing the whole operation is simpler to get right than trusting that every git invocation that
    might ever walk the tree carries the flag that happens to defeat this particular shape of attack."""
    ws = sandbox.workspace
    hostile = tmp_path / "hostile-gitdir"
    hostile.mkdir()
    marker = tmp_path / "pwned"
    (hostile / "config").write_text(f"[core]\n\tfsmonitor = touch {marker}\n")
    (ws.work / ".git").write_text(f"gitdir: {hostile}\n")
    ws.write_file("payments/refund.py", b"changed\n")
    with pytest.raises(WorkspaceError, match=r"\.git"):
        ws.changed_paths()
    with pytest.raises(WorkspaceError, match=r"\.git"):
        ws.diff_from_head()
    assert not marker.exists()


def test_nested_git_directory_is_refused(sandbox: ProcessSandbox, tmp_path: Path):
    """The same attack, planted as a real nested repository (what `git status`/`add` would recurse
    into as a gitlink) rather than a `.git` file at the checkout root."""
    ws = sandbox.workspace
    marker = tmp_path / "pwned"
    nested = ws.work / "vendor" / "lib" / ".git"
    nested.mkdir(parents=True)
    (nested / "config").write_text(f"[core]\n\tfsmonitor = touch {marker}\n")
    with pytest.raises(WorkspaceError, match=r"\.git"):
        ws.changed_paths()
    assert not marker.exists()


def test_read_through_symlink_is_refused(sandbox: ProcessSandbox, tmp_path: Path):
    secret = tmp_path / "secret.txt"
    secret.write_text("host secret")
    os.symlink(secret, sandbox.workspace.work / "link")
    with pytest.raises(WorkspaceError, match="symlink"):
        sandbox.workspace.read_file("link", 100)


def test_write_through_symlink_is_refused(sandbox: ProcessSandbox, tmp_path: Path):
    target = tmp_path / "victim.txt"
    target.write_text("original")
    os.symlink(target, sandbox.workspace.work / "link")
    with pytest.raises(WorkspaceError, match="symlink"):
        sandbox.workspace.write_file("link", b"overwritten")
    assert target.read_text() == "original"


def test_symlinked_directory_in_path_is_refused(sandbox: ProcessSandbox, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, sandbox.workspace.work / "escape")
    with pytest.raises(WorkspaceError, match="symlink"):
        sandbox.workspace.write_file("escape/pwn.txt", b"x")
    assert list(outside.iterdir()) == []
    with pytest.raises(WorkspaceError):
        sandbox.workspace.list_files("escape")


def test_list_files_shows_symlinks_without_following(sandbox: ProcessSandbox, tmp_path: Path):
    os.symlink(tmp_path, sandbox.workspace.work / "docs" / "outside")
    listing = sandbox.workspace.list_files(".")
    assert "docs/outside@" in listing
    assert not any(p.startswith("docs/outside/") for p in listing)


def test_read_reports_truncation_by_returning_one_extra_byte(sandbox: ProcessSandbox):
    sandbox.workspace.write_file("big.txt", b"a" * 50)
    assert len(sandbox.workspace.read_file("big.txt", 10)) == 11


def test_read_missing_and_directory(sandbox: ProcessSandbox):
    with pytest.raises(FileNotFoundError):
        sandbox.workspace.read_file("nope.txt", 10)
    with pytest.raises(WorkspaceError):
        sandbox.workspace.read_file("docs", 10)


def test_file_hash_absent_and_present(sandbox: ProcessSandbox):
    import mergit_receipt

    assert sandbox.workspace.file_hash("missing", 100) is None
    sandbox.workspace.write_file("a.txt", b"hello")
    assert sandbox.workspace.file_hash("a.txt", 100) == mergit_receipt.keccak_hex(b"hello")
    with pytest.raises(WorkspaceError, match="larger"):
        sandbox.workspace.file_hash("a.txt", 2)


def test_diff_includes_new_files(sandbox: ProcessSandbox):
    sandbox.workspace.write_file("payments/refund.py", b"def refund(a, f):\n    return a - f\n")
    sandbox.workspace.write_file("payments/new.py", b"x = 1\n")
    diff = sandbox.workspace.diff_from_head()
    assert "payments/new.py" in diff
    assert "return a - f" in diff


def test_list_files_does_not_crash_on_a_very_deep_directory_tree(sandbox: ProcessSandbox):
    """A directory chain deep enough to overflow Python's call stack must fail cleanly, not crash the
    job with a RecursionError. Built one `mkdir`/`open` at a time, dir_fd-relative, so no single path
    string ever gets long enough to hit a separate, unrelated length limit."""
    depth = 2000
    fd = os.open(sandbox.workspace.work, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for _ in range(depth):
            os.mkdir("d", dir_fd=fd)
            nxt = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = nxt
    finally:
        os.close(fd)
    sandbox.workspace.list_files(".")  # must return, not raise RecursionError


def test_list_files_on_a_wide_tree_does_not_run_out_of_descriptors(sandbox: ProcessSandbox):
    """Descriptors must grow with depth, not with the number of directories: holding one per directory
    made a normal checkout fail under a 1024 soft limit. Run it under a limit far below the count."""
    import resource

    for i in range(300):
        (sandbox.workspace.work / f"d{i:03d}").mkdir()
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    in_use = len(os.listdir("/proc/self/fd"))
    resource.setrlimit(resource.RLIMIT_NOFILE, (in_use + 64, hard))
    try:
        listing = sandbox.workspace.list_files(".")
    finally:
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
    assert "d000/" in listing and "d299/" in listing


def test_list_files_closes_every_descriptor_it_opened(sandbox: ProcessSandbox):
    (sandbox.workspace.work / "a" / "b").mkdir(parents=True)
    (sandbox.workspace.work / "c").mkdir()
    before = len(os.listdir("/proc/self/fd"))
    sandbox.workspace.list_files(".")
    assert len(os.listdir("/proc/self/fd")) == before


def test_opening_a_fifo_does_not_hang(sandbox: ProcessSandbox):
    """An agent-made named pipe must fail the open fast, not block the worker waiting for a reader or
    writer that will never come."""
    os.mkfifo(sandbox.workspace.work / "pipe")
    with pytest.raises(WorkspaceError, match="not a regular file"):
        sandbox.workspace.read_file("pipe", 10)


def test_git_work_tree_commands_run_in_the_checkout_not_the_callers_directory(
    sandbox: ProcessSandbox, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """With --git-dir and --work-tree, git takes the current directory as the work-tree root. A patch applied
    from the wrong directory once wrote files into the caller's cwd."""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    patch = (
        "diff --git a/docs/notes.md b/docs/notes.md\n--- a/docs/notes.md\n+++ b/docs/notes.md\n"
        "@@ -1 +1,2 @@\n notes\n+more\n"
    )
    sandbox.workspace.apply_patch(patch)
    sha = sandbox.workspace.commit_all("m", "n", "n@example.test")
    assert len(sha) == 40
    assert list(elsewhere.iterdir()) == []
    assert (sandbox.workspace.work / "docs" / "notes.md").read_text() == "notes\nmore\n"
