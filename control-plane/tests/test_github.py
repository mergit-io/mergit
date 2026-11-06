from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from mergit_worker import workspace
from mergit_worker.github import (
    GitHubConfig,
    GitHubError,
    GitHubPrOpener,
    PrSpec,
    PrTask,
    clean_line,
    parse_github_repo,
    pr_body,
    receipt_url,
)
from mergit_worker.sandbox import SANDBOX_ENV
from tests.support import LOCAL_GIT, PLAN_UUID, git, make_repo

TOKEN = "ghp_SUPERSECRETTOKEN"
API = "https://api.github.test"
APP = "https://app.mergit.site"
FIX_PATCH = (
    "diff --git a/payments/refund.py b/payments/refund.py\n"
    "--- a/payments/refund.py\n+++ b/payments/refund.py\n"
    "@@ -1,2 +1,2 @@\n def refund(amount, fee):\n-    return amount\n+    return amount - fee\n"
)
DOCS_PATCH = (
    "diff --git a/docs/notes.md b/docs/notes.md\n"
    "--- a/docs/notes.md\n+++ b/docs/notes.md\n@@ -1 +1,2 @@\n notes\n+more notes\n"
)


@pytest.fixture
def remotes(tmp_path: Path) -> Path:
    """`<root>/acme/widgets.git` as a bare repository with the fixture history, standing in for GitHub."""
    origin = make_repo(tmp_path).removeprefix("file://")
    bare = tmp_path / "remotes" / "acme" / "widgets.git"
    bare.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", "--bare", origin, str(bare))
    return tmp_path / "remotes"


def opener(remotes: Path, tmp_path: Path, **over: Any) -> GitHubPrOpener:
    cfg = GitHubConfig(
        token=TOKEN,
        api_url=API,
        git_base_url=f"file://{remotes}",
        hosts=("github.com",),
        app_base_url=APP,
        author_name="mergit",
        author_email="mergit@example.test",
        workspace_root=tmp_path / "ws",
        git=LOCAL_GIT,
        http_timeout_s=5,
    )
    sleeps: list[float] = []
    return GitHubPrOpener(replace_cfg(cfg, over), sleep=sleeps.append)


def replace_cfg(cfg: GitHubConfig, over: dict[str, Any]) -> GitHubConfig:
    from dataclasses import replace

    return replace(cfg, **over)


def spec(**over: Any) -> PrSpec:
    fields: dict[str, Any] = {
        "plan_uuid": PLAN_UUID,
        "goal": "fix refunds",
        "repo_url": "https://github.com/acme/widgets.git",
        "base_ref": "main",
        "tasks": [
            PrTask(0, "0x" + "a" * 64, "fix refund", FIX_PATCH),
            PrTask(1, "0x" + "b" * 64, "docs", DOCS_PATCH),
        ],
    }
    fields.update(over)
    return PrSpec(**fields)


def created(number: int = 12) -> httpx.Response:
    return httpx.Response(
        201, json={"number": number, "html_url": f"https://github.com/acme/widgets/pull/{number}"}
    )


@respx.mock
def test_opens_a_pr_from_the_combined_changes(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    result = opener(remotes, tmp_path).open(spec())

    assert (result.pr_number, result.branch) == (12, f"mergit/{PLAN_UUID}")
    bare = remotes / "acme" / "widgets.git"
    assert git(bare, "rev-parse", f"refs/heads/mergit/{PLAN_UUID}").strip() == result.commit_sha  # recorded
    files = git(bare, "show", f"{result.commit_sha}:payments/refund.py")
    assert "return amount - fee" in files
    assert "more notes" in git(bare, "show", f"{result.commit_sha}:docs/notes.md")  # both tasks are in
    assert git(bare, "rev-parse", "refs/heads/main").strip() != result.commit_sha  # main is untouched

    sent = json.loads(route.calls[0].request.content)
    assert (sent["head"], sent["base"]) == (f"mergit/{PLAN_UUID}", "main")


@respx.mock
def test_a_task_with_an_empty_patch_is_skipped_not_fatal(remotes: Path, tmp_path: Path):
    """A task can pass Φ without changing any tracked file; `git apply` itself refuses an empty patch,
    so that task must be skipped rather than breaking the whole combined change."""
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    result = opener(remotes, tmp_path).open(
        spec(
            tasks=[
                PrTask(0, "0x" + "a" * 64, "fix refund", FIX_PATCH),
                PrTask(1, "0x" + "b" * 64, "noop", ""),
            ]
        )
    )
    bare = remotes / "acme" / "widgets.git"
    assert "return amount - fee" in git(bare, "show", f"{result.commit_sha}:payments/refund.py")


@respx.mock
def test_pr_body_links_every_receipt(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    s = spec()
    opener(remotes, tmp_path).open(s)
    body: str = json.loads(route.calls[0].request.content)["body"]
    for task in s.tasks:
        assert f"({APP}/app/proofs/{task.task_id})" in body
    assert "unattested" in body  # a development-key receipt is never presented as attested


def test_receipt_url_and_body_shape():
    assert receipt_url("https://app.mergit.site/", "0xab") == "https://app.mergit.site/app/proofs/0xab"
    body = pr_body(spec(), APP)
    assert body.index("Task 0") < body.index("Task 1")


def test_hostile_titles_cannot_inject_markup():
    out = clean_line("x](http://evil)\n<script>alert(1)</script> `code` | #1")
    assert "\n" not in out
    assert "](" not in out.replace("\\]", "").replace("\\[", "")
    assert "<script>" not in out


def test_mentions_and_links_are_defanged():
    out = clean_line("ping @someone and @acme/security-team, see http://evil.example/login")
    assert "@someone" not in out  # a zero-width space breaks the mention, text still reads the same
    assert "@​someone" in out
    assert "@​acme/security-team" in out
    assert "http://evil.example/login" not in out
    assert "http:/​/evil.example/login" in out


def test_long_title_is_capped():
    assert len(clean_line("a" * 500)) == 120


@respx.mock
def test_request_headers(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    opener(remotes, tmp_path).open(spec())
    h = route.calls[0].request.headers
    assert h["authorization"] == f"Bearer {TOKEN}"
    assert h["accept"] == "application/vnd.github+json"
    assert h["x-github-api-version"] == "2022-11-28"


@respx.mock
def test_token_is_never_in_argv_urls_or_files_and_only_the_push_gets_it(
    remotes: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    calls: list[tuple[list[str], dict[str, str]]] = []
    real = subprocess.run

    def spy(argv: list[str], **kw: Any) -> Any:
        calls.append((list(argv), dict(kw.get("env") or {})))
        return real(argv, **kw)

    monkeypatch.setattr(workspace.subprocess, "run", spy)
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    opener(remotes, tmp_path).open(spec())

    assert calls
    for argv, env in calls:
        assert not any(TOKEN in a for a in argv), argv
        assert TOKEN not in "".join(env.values())  # not even in the environment, only its base64 header
        assert "GITHUB_TOKEN" not in env
    carrying = [argv for argv, env in calls if "GIT_CONFIG_VALUE_0" in env]
    assert len(carrying) == 1 and "push" in carrying[0]


def test_token_is_not_reachable_from_the_sandbox():
    assert not any("TOKEN" in k or "KEY" in k or "GITHUB" in k for k in SANDBOX_ENV)


@respx.mock
def test_github_rejection_messages_do_not_contain_the_token(remotes: Path, tmp_path: Path):
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(
        return_value=httpx.Response(401, json={"message": "Bad"})
    )
    with pytest.raises(GitHubError) as err:
        opener(remotes, tmp_path).open(spec())
    assert TOKEN not in str(err.value)
    assert "token" in str(err.value)


@respx.mock
def test_missing_repo_is_a_clear_error(remotes: Path, tmp_path: Path):
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=httpx.Response(404))
    with pytest.raises(GitHubError, match="cannot find the repository"):
        opener(remotes, tmp_path).open(spec())


@respx.mock
def test_retry_after_the_pr_exists_returns_the_existing_one(remotes: Path, tmp_path: Path):
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(
        return_value=httpx.Response(422, json={"message": "Validation Failed: A pull request already exists"})
    )
    respx.get(f"{API}/repos/acme/widgets/pulls").mock(
        return_value=httpx.Response(
            200, json=[{"number": 5, "html_url": "https://github.com/acme/widgets/pull/5"}]
        )
    )
    result = opener(remotes, tmp_path).open(spec())
    assert result.pr_number == 5


@respx.mock
def test_server_errors_are_retried_then_reported(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=httpx.Response(503))
    with pytest.raises(GitHubError, match="unavailable"):
        opener(remotes, tmp_path).open(spec())
    assert len(route.calls) == 3


@respx.mock
def test_a_patch_that_does_not_apply_names_the_task_and_pushes_nothing(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    bad = PrTask(1, "0x" + "b" * 64, "docs", DOCS_PATCH.replace(" notes\n+more", " NOT-IN-FILE\n+more"))
    with pytest.raises(GitHubError, match="task 1 does not apply"):
        opener(remotes, tmp_path).open(spec(tasks=[PrTask(0, "0x" + "a" * 64, "fix", FIX_PATCH), bad]))
    assert not route.called
    out = git(remotes / "acme" / "widgets.git", "branch", "--list", "mergit/*")
    assert out.strip() == ""


def _patch_after(tmp_path: Path, name: str, files: dict[str, str]) -> str:
    """What the worker stores for a task: `git diff --binary HEAD` of a checkout of the fixture repository
    after `files` were written, the way `Workspace.diff_from_head` takes it."""
    work = tmp_path / name
    git(tmp_path, "clone", "-q", make_repo(tmp_path / f"{name}-origin"), str(work))
    for path, text in files.items():
        (work / path).write_text(text)
    git(work, "add", "-N", "--", ".")
    return git(work, "diff", "--binary", "HEAD")


FIXED = "def refund(amount, fee):\n    return amount - fee\n"


@respx.mock
def test_a_dependent_tasks_patch_that_repeats_its_dependencys_change_still_combines(
    remotes: Path, tmp_path: Path
):
    """A dependent task runs on top of its dependency's change, and its stored patch, taken against the base
    commit, carries that change again. Applying both in order must not fail on the repeat."""
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    fix = _patch_after(tmp_path, "t0", {"payments/refund.py": FIXED})
    both = {"payments/refund.py": FIXED, "docs/notes.md": "notes\nmore\n"}
    fix_and_docs = _patch_after(tmp_path, "t1", both)
    result = opener(remotes, tmp_path).open(
        spec(tasks=[PrTask(0, "0x" + "a" * 64, "fix", fix), PrTask(1, "0x" + "b" * 64, "docs", fix_and_docs)])
    )
    bare = remotes / "acme" / "widgets.git"
    assert git(bare, "show", f"{result.commit_sha}:payments/refund.py") == FIXED
    assert git(bare, "show", f"{result.commit_sha}:docs/notes.md") == "notes\nmore\n"


@respx.mock
def test_two_tasks_that_change_the_same_line_differently_still_refuse(remotes: Path, tmp_path: Path):
    route = respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    one = _patch_after(tmp_path, "t0", {"payments/refund.py": FIXED})
    other = _patch_after(tmp_path, "t1", {"payments/refund.py": "def refund(amount, fee):\n    return 0\n"})
    with pytest.raises(GitHubError, match="task 1 does not apply"):
        opener(remotes, tmp_path).open(
            spec(tasks=[PrTask(0, "0x" + "a" * 64, "fix", one), PrTask(1, "0x" + "b" * 64, "zero", other)])
        )
    assert not route.called


@respx.mock
def test_patch_cannot_write_into_dot_git(remotes: Path, tmp_path: Path):
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=created())
    evil = (
        "diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\n"
        "new file mode 100755\n--- /dev/null\n+++ b/.git/hooks/pre-commit\n"
        "@@ -0,0 +1 @@\n+touch /tmp/pwned\n"
    )
    with pytest.raises(GitHubError):
        opener(remotes, tmp_path).open(spec(tasks=[PrTask(0, "0x" + "a" * 64, "evil", evil)]))


def test_no_tasks_is_refused():
    with pytest.raises(GitHubError, match="no passing"):
        GitHubPrOpener.__new__(GitHubPrOpener).open(spec(tasks=[]))


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/a/b",
        "https://evil.com/a/b",
        "https://github.com/a",
        "https://github.com/a/b?x=1",
        "git@github.com:a/b.git",
        "https://github.com/a/b/c",
    ],
)
def test_only_github_https_repo_urls_are_accepted(url: str):
    with pytest.raises(GitHubError):
        parse_github_repo(url, ("github.com",))


@pytest.mark.parametrize(
    "url", ["https://github.com/a/b", "https://github.com/a/b.git", "https://github.com/a/b/"]
)
def test_repo_url_forms(url: str):
    assert parse_github_repo(url, ("github.com",)) == ("a", "b")


@respx.mock
def test_workspace_is_cleaned_up_even_on_failure(remotes: Path, tmp_path: Path):
    respx.post(f"{API}/repos/acme/widgets/pulls").mock(return_value=httpx.Response(404))
    with pytest.raises(GitHubError):
        opener(remotes, tmp_path).open(spec())
    assert list((tmp_path / "ws").iterdir()) == []
