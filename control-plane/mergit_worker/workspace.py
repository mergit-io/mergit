"""The repository checkout on the host, and the only code that touches it.

The container mounts `work/` and can write anything there, including symlinks and a `.git` of its own
making. So the host never trusts what it finds inside `work/`:

- the git directory lives outside `work/`, and every host git call names it with `--git-dir` and
  `--work-tree`, so a planted top-level `.git` file, hook or config is never read;
- a `.git` *anywhere inside* `work/` is refused outright before any git command runs over the tree
  (`changed_paths`, `diff_from_head`): git recurses into a gitlink or nested repository on its own,
  using *that* repository's own config, not ours, and `core.fsmonitor` there runs a command on the
  host. Scanning first and refusing is simpler and safer than trying to pass the right flags to every
  git invocation that might ever walk the tree;
- `changed_paths` also reports paths a `.gitignore` would otherwise hide, since an agent could
  otherwise satisfy `allowed_paths` by writing outside it and ignoring the result;
- file reads and writes walk the path one component at a time with `O_NOFOLLOW`, so a symlink the
  agent created cannot point a host read or write outside the checkout, and the open is non-blocking,
  so a named pipe the agent created cannot hang the worker.
"""

from __future__ import annotations

import base64
import contextlib
import errno
import logging
import os
import re
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

import mergit_receipt

log = logging.getLogger(__name__)

_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$")
_MAX_LIST_ENTRIES = 2000
# The nested-.git scan visits every entry of the checkout, so an agent-made tree could make every Φ evaluation
# arbitrarily slow. Unlike a listing, it cannot just stop and report what it has: a `.git` planted past the
# cutoff would then go unseen and git would run over it, so reaching the limit refuses (fails closed) instead.
_MAX_SCAN_ENTRIES = 500_000


class WorkspaceError(Exception):
    """A path, URL or ref was refused, or git failed. Safe to show to the model."""


@dataclass(frozen=True, slots=True)
class GitLimits:
    allowed_schemes: Sequence[str]
    timeout_s: float


def validate_repo_url(url: str, allowed_schemes: Sequence[str]) -> None:
    if not url or url.startswith("-") or any(c.isspace() or ord(c) < 32 for c in url):
        raise WorkspaceError("repository URL is malformed")
    scheme = urlsplit(url).scheme
    if scheme not in allowed_schemes:
        raise WorkspaceError(f"repository URL scheme {scheme!r} is not allowed")


def validate_ref(ref: str) -> None:
    if not _REF.match(ref) or ".." in ref:
        raise WorkspaceError("git ref is malformed")


def relative_parts(rel: str) -> tuple[str, ...]:
    """Split a model-supplied path into components, refusing anything that could leave the checkout."""
    if "\x00" in rel:
        raise WorkspaceError("path contains a NUL byte")
    path = PurePosixPath(rel)
    if path.is_absolute():
        raise WorkspaceError("path must be relative to the repository root")
    if ".." in path.parts:
        raise WorkspaceError("path must not contain '..'")
    return path.parts


class Workspace:
    def __init__(self, base: Path, work: Path, gitdir: Path, head: str, git_timeout_s: float) -> None:
        self._base = base
        self.work = work
        self._gitdir = gitdir
        self.head = head
        self._git_timeout_s = git_timeout_s

    # -- creation and teardown -------------------------------------------------------------

    @classmethod
    def clone(cls, repo_url: str, ref: str, root: Path, limits: GitLimits) -> Workspace:
        validate_repo_url(repo_url, limits.allowed_schemes)
        validate_ref(ref)
        root.mkdir(parents=True, exist_ok=True)
        base = Path(tempfile.mkdtemp(prefix="ws-", dir=root))
        work, gitdir = base / "work", base / "git"
        work.mkdir()
        try:
            env = _git_env(limits.allowed_schemes)
            _git(["--git-dir", str(gitdir), "init", "-q"], env, limits.timeout_s)
            _git(
                [
                    "--git-dir",
                    str(gitdir),
                    "-c",
                    "core.hooksPath=/dev/null",
                    "fetch",
                    "-q",
                    "--depth",
                    "1",
                    "--no-recurse-submodules",
                    "--",
                    repo_url,
                    ref,
                ],
                env,
                limits.timeout_s,
            )
            _git(
                [
                    "--git-dir",
                    str(gitdir),
                    "--work-tree",
                    str(work),
                    "-c",
                    "core.hooksPath=/dev/null",
                    "checkout",
                    "-q",
                    "--detach",
                    "FETCH_HEAD",
                ],
                env,
                limits.timeout_s,
            )
            head = _git(["--git-dir", str(gitdir), "rev-parse", "HEAD"], env, limits.timeout_s).strip()
        except BaseException:
            shutil.rmtree(base, ignore_errors=True)
            raise
        return cls(base, work, gitdir, head, limits.timeout_s)

    def destroy(self) -> None:
        self._widen_permissions(self._base)
        shutil.rmtree(self._base, onexc=self._log_remove_failure)

    def _widen_permissions(self, base: Path) -> None:
        """The container runs as our own uid, so a directory it left with an unhelpful mode (for
        example a deliberate `chmod 000`) is still ours to fix. Done as a pass before `rmtree`, rather
        than from its `onexc`, because the function `onexc` would hand back for a safe-fd removal is a
        low-level primitive such as `os.open`, not something a bare `func(path)` retry can drive.
        Iterative and best-effort: a leftover permission problem must never stop `destroy`, which runs
        in a `finally`, from letting the worker move on to its next job."""
        stack = [base]
        while stack:
            path = stack.pop()
            try:
                if path.is_symlink() or not path.is_dir():
                    continue
                os.chmod(path, 0o700)
                stack.extend(path.iterdir())
            except OSError:
                continue

    def _log_remove_failure(self, _func: Any, path: str, exc: BaseException) -> None:
        log.warning("could not remove %s while destroying workspace %s", path, self._base, exc_info=exc)

    # -- git ---------------------------------------------------------------------------------

    def changed_paths(self) -> list[str]:
        """Every path that differs from the starting commit, sorted. A rename is reported as the
        deletion of the old path plus the addition of the new one, so both must be allowed.

        Includes paths a `.gitignore` would otherwise hide (`--ignored=matching`): if it did not, an
        agent could write outside `allowed_paths` and hide the result from the Φ check with a stray
        ignore rule. `--ignore-submodules=all` and the nested-`.git` scan below are both here so git
        never recurses into, or lets the index point at, anything but the plain files the agent wrote.
        """
        self._refuse_nested_git()
        out = _git(
            [
                "--git-dir",
                str(self._gitdir),
                "--work-tree",
                str(self.work),
                "status",
                "--porcelain=v1",
                "-z",
                "--no-renames",
                "--untracked-files=all",
                "--ignored=matching",
                "--ignore-submodules=all",
            ],
            _git_env(()),
            self._git_timeout_s,
            cwd=self.work,
        )
        paths = {entry[3:] for entry in out.split("\x00") if len(entry) > 3}
        return sorted(paths)

    def diff_from_head(self) -> str:
        """Unified diff of tracked and untracked changes, for the PR gate to show the requester.

        `--force` on the intent-to-add, or a new file a `.gitignore` covers would silently drop out of
        this diff, even though `changed_paths` (and so the Φ check) already counts it as changed: the
        same thing a `.gitignore` must not be able to hide from `allowed_paths` must not then go missing
        from the patch that gets committed and dispatched to a dependent task.
        """
        self._refuse_nested_git()
        env = _git_env(())
        base = ["--git-dir", str(self._gitdir), "--work-tree", str(self.work)]
        _git([*base, "add", "-N", "--force", "--", "."], env, self._git_timeout_s, cwd=self.work)
        raw = _git_raw(
            [*base, "diff", "--no-ext-diff", "--binary", "--ignore-submodules=all", "HEAD"],
            env,
            self._git_timeout_s,
            cwd=self.work,
        )
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WorkspaceError("the change is not valid UTF-8 and cannot be stored as a patch") from exc

    def _refuse_nested_git(self) -> None:
        """A `.git` anywhere inside the checkout, planted by the agent, is refused rather than made
        safe to look at: git recurses into a gitlink (a nested `.git`, whether or not it is a real
        submodule) using *that* repository's own config, and a `core.fsmonitor` entry there runs a
        command on the host the moment `git status`, `add` or `diff` walks over it. The real gitdir
        for this checkout lives outside `work/`, so a `.git` inside it is never legitimate."""
        fd = os.open(self.work, os.O_RDONLY | os.O_DIRECTORY)
        try:
            found = _find_name(fd, ".git")
        finally:
            os.close(fd)
        if found is not None:
            raise WorkspaceError(f"refusing to run git over the checkout: found {found!r} inside it")

    # -- building and publishing a branch (PR gate) ---------------------------------------------

    def apply_patch(self, patch: str) -> None:
        """Apply a stored task patch onto the checkout and stage it. `git apply` refuses paths inside
        `.git`, so a patch cannot plant hooks or config."""
        _git(
            [*self._base_args(), "apply", "--index", "--whitespace=nowarn", "-"],
            _git_env(()),
            self._git_timeout_s,
            patch.encode(),
            cwd=self.work,
        )

    def commit_all(self, message: str, author_name: str, author_email: str) -> str:
        """Commit everything staged or changed and return the commit SHA."""
        base, env = self._base_args(), _git_env(())
        _git([*base, "add", "-A"], env, self._git_timeout_s, cwd=self.work)
        staged = subprocess.run(  # noqa: S603  # argv list, no shell
            ["git", *base, "diff", "--cached", "--quiet"],  # noqa: S607
            env=env,
            cwd=self.work,
            capture_output=True,
            timeout=self._git_timeout_s,
            check=False,
        )
        if staged.returncode == 0:
            raise WorkspaceError("there is nothing to commit")
        _git(
            [
                *base,
                "-c",
                f"user.name={author_name}",
                "-c",
                f"user.email={author_email}",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-q",
                "-m",
                message,
            ],
            env,
            self._git_timeout_s,
            cwd=self.work,
        )
        return _git([*base, "rev-parse", "HEAD"], env, self._git_timeout_s).strip()

    def push(self, remote_url: str, branch: str, token: str | None, limits: GitLimits) -> None:
        """Force-push HEAD to a branch Mergit owns (`mergit/<plan>`). The token travels only in the
        environment of this one git process, as an HTTP header: never in argv, a URL or a config file."""
        validate_repo_url(remote_url, limits.allowed_schemes)
        validate_ref(branch)
        env = _git_env(limits.allowed_schemes)
        if token:
            basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            env |= {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "http.extraheader",
                "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
            }
        try:
            _git(
                [
                    *self._base_args(),
                    "-c",
                    "core.hooksPath=/dev/null",
                    "push",
                    "--force",
                    "-q",
                    "--",
                    remote_url,
                    f"HEAD:refs/heads/{branch}",
                ],
                env,
                limits.timeout_s,
                cwd=self.work,
            )
        except WorkspaceError as exc:
            msg = str(exc)
            for secret in filter(None, (token, env.get("GIT_CONFIG_VALUE_0"))):
                msg = msg.replace(secret, "***")
            raise WorkspaceError(msg) from None

    def _base_args(self) -> list[str]:
        return ["--git-dir", str(self._gitdir), "--work-tree", str(self.work)]

    # -- files -------------------------------------------------------------------------------

    def read_file(self, rel: str, max_bytes: int) -> bytes:
        """Up to `max_bytes + 1` bytes, so a caller can tell the file was longer."""
        parts = relative_parts(rel)
        if not parts:
            raise WorkspaceError("path names the repository root")
        fd = self._open(parts, os.O_RDONLY, create_parents=False)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise WorkspaceError("not a regular file")
            with os.fdopen(os.dup(fd), "rb") as f:
                return f.read(max_bytes + 1)
        finally:
            os.close(fd)

    def write_file(self, rel: str, content: bytes) -> None:
        parts = relative_parts(rel)
        if not parts:
            raise WorkspaceError("path names the repository root")
        fd = self._open(parts, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, create_parents=True)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise WorkspaceError("not a regular file")
            with os.fdopen(os.dup(fd), "wb") as f:
                f.write(content)
        finally:
            os.close(fd)

    def file_hash(self, rel: str, max_bytes: int) -> str | None:
        """keccak-256 of a file's contents from the Rust binding, or None if the file is absent."""
        try:
            data = self.read_file(rel, max_bytes)
        except FileNotFoundError:
            return None
        if len(data) > max_bytes:
            raise WorkspaceError(f"{rel} is larger than {max_bytes} bytes")
        return mergit_receipt.keccak_hex(data)

    def list_files(self, rel: str = ".") -> list[str]:
        """Relative paths below `rel` (files and directories, directories end in '/'), sorted, capped."""
        parts = relative_parts(rel)
        fd = self._open_dir(parts)
        found: list[str] = []
        try:
            self._walk(fd, PurePosixPath(*parts) if parts else PurePosixPath(), found)
        finally:
            os.close(fd)
        return sorted(found)

    # -- internals ---------------------------------------------------------------------------

    def _open_dir(self, parts: tuple[str, ...]) -> int:
        fd = os.open(self.work, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in parts:
                nxt = _openat(part, os.O_RDONLY | os.O_DIRECTORY, fd)
                os.close(fd)
                fd = nxt
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _open(self, parts: tuple[str, ...], flags: int, *, create_parents: bool) -> int:
        dirfd = os.open(self.work, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in parts[:-1]:
                if create_parents:
                    with contextlib.suppress(FileExistsError):
                        os.mkdir(part, 0o755, dir_fd=dirfd)
                nxt = _openat(part, os.O_RDONLY | os.O_DIRECTORY, dirfd)
                os.close(dirfd)
                dirfd = nxt
            return _openat(parts[-1], flags, dirfd, 0o644)
        finally:
            os.close(dirfd)

    def _walk(self, fd: int, prefix: PurePosixPath, found: list[str]) -> None:
        """Iterative (not recursive): an agent can make a directory chain deep enough to blow the
        Python call stack, and `list_files` must fail cleanly, not crash the job, over that. The final
        result is sorted by the caller regardless of the order entries are appended here."""
        stack = [(fd, prefix)]
        opened = [fd]
        try:
            while stack:
                cur_fd, cur_prefix = stack.pop()
                if len(found) >= _MAX_LIST_ENTRIES:
                    return
                with os.scandir(cur_fd) as it:
                    entries = sorted(it, key=lambda e: e.name)
                for entry in entries:
                    if len(found) >= _MAX_LIST_ENTRIES:
                        return
                    rel = cur_prefix / entry.name
                    if entry.is_symlink():
                        found.append(f"{rel}@")  # listed, never followed
                    elif entry.is_dir(follow_symlinks=False):
                        found.append(f"{rel}/")
                        child = _openat(entry.name, os.O_RDONLY | os.O_DIRECTORY, cur_fd)
                        opened.append(child)
                        stack.append((child, rel))
                    else:
                        found.append(str(rel))
        finally:
            for f in opened[1:]:  # the caller owns and closes the fd it passed in (opened[0])
                os.close(f)


def _find_name(fd: int, name: str, limit: int | None = None) -> str | None:
    """The relative path of the first entry called `name` anywhere under `fd`, or None. Iterative, for
    the same reason `_walk` is: an attacker-made directory chain must not be able to overflow the
    stack. Never follows a symlink, so a symlink cannot be used to point this scan outside the tree.

    Raises `WorkspaceError` rather than answering None when the tree has more than `limit` entries (default
    `_MAX_SCAN_ENTRIES`) or cannot be scanned in full: "not found" is only true if all of it was looked at."""
    cap = _MAX_SCAN_ENTRIES if limit is None else limit
    seen = 0
    stack = [(fd, PurePosixPath())]
    opened: list[int] = []
    try:
        while stack:
            cur_fd, cur_prefix = stack.pop()
            with os.scandir(cur_fd) as it:
                for entry in it:
                    seen += 1
                    if seen > cap:
                        raise WorkspaceError(
                            f"the checkout has more than {cap} entries: refusing to run git over a tree "
                            f"too large to check for a nested {name}"
                        )
                    if entry.name == name:
                        return str(cur_prefix / entry.name)
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        child = _openat(entry.name, os.O_RDONLY | os.O_DIRECTORY, cur_fd)
                        opened.append(child)
                        stack.append((child, cur_prefix / entry.name))
        return None
    except OSError as exc:  # for example out of file descriptors on a very wide tree
        raise WorkspaceError(f"cannot scan the checkout for a nested {name}: {exc}") from exc
    finally:
        for f in opened:
            os.close(f)


def _openat(name: str, flags: int, dir_fd: int, mode: int = 0o644) -> int:
    try:
        # O_NONBLOCK: a FIFO the agent created would otherwise block the open indefinitely, waiting
        # for a reader or writer that never comes; it has no effect on a regular file or a directory.
        return os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, mode, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise WorkspaceError(f"{name}: symlinks and non-directories in a path are not followed") from exc
        raise


def _git_env(allowed_schemes: Sequence[str]) -> dict[str, str]:
    """A scrubbed environment: no user or system git config, no prompts, only the allowed transports."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": "/nonexistent",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "LC_ALL": "C",
    }
    env["GIT_ALLOW_PROTOCOL"] = ":".join(allowed_schemes) if allowed_schemes else "file"
    return env


def _git(
    args: list[str],
    env: dict[str, str],
    timeout_s: float,
    stdin: bytes | None = None,
    cwd: Path | None = None,
) -> str:
    return _git_raw(args, env, timeout_s, stdin, cwd).decode("utf-8", "replace")


def _git_raw(
    args: list[str],
    env: dict[str, str],
    timeout_s: float,
    stdin: bytes | None = None,
    cwd: Path | None = None,
) -> bytes:
    """Run git. With an explicit --git-dir and --work-tree, git treats the current directory as the root
    of the work tree, so every command that touches the work tree must pass `cwd` = the checkout."""
    argv = ["git", *args]
    try:
        proc = subprocess.run(  # noqa: S603  # argv list, no shell; git is resolved from PATH
            argv, env=env, input=stdin, cwd=cwd, capture_output=True, timeout=timeout_s, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise WorkspaceError("git timed out") from exc
    if proc.returncode != 0:
        last = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1:]
        raise WorkspaceError(f"git failed: {last[0] if last else 'no output'}")
    return proc.stdout
