from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from mergit_worker.config import ConfigError, WorkerConfig
from mergit_worker.llm import ModelClients
from mergit_worker.models import Job, RunOutcome
from mergit_worker.providers import ProviderSpec
from mergit_worker.worker import Worker, WorkerDeps
from tests.support import (
    FIX,
    KEY,
    KEY_ADDRESS,
    REGISTRY,
    ProcessSandbox,
    RecordingPublisher,
    ScriptedLLM,
    make_harness_config,
    make_job,
    make_prices,
    turn,
)


class FakeStore:
    def __init__(self, jobs: list[Job]) -> None:
        self.queue = list(jobs)
        self.reports: list[RunOutcome] = []
        self.failures: list[tuple[str, str]] = []

    def claim(self) -> Job | None:
        return self.queue.pop(0) if self.queue else None

    def report(self, outcome: RunOutcome) -> None:
        self.reports.append(outcome)

    def fail(self, task_id: str, message: str) -> None:
        self.failures.append((task_id, message))


@pytest.fixture(autouse=True)
def agent_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MERGIT_AGENT_KEY_1", KEY)


@pytest.fixture
def cfg(tmp_path: Path) -> WorkerConfig:
    agents = tmp_path / "agents.json"
    agents.write_text(json.dumps({"agents": [{"agent_id": "1", "name": "w", "runtime_key": KEY_ADDRESS}]}))
    toml = tmp_path / "agents.toml"
    toml.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.w]\nprovider = "anthropic"\nmodel = "test-model"\nsystem_prompt = "p"\n'
    )
    return WorkerConfig(
        database_url="postgres://x",
        gateway_url="http://g",
        store_url="http://s",  # type: ignore[arg-type]
        events_token="e",
        store_write_token="s",
        receipt_registry=REGISTRY,  # type: ignore[arg-type]
        agents_file=agents,
        agents_config=toml,
        poll_interval_s=0.01,
    )


@dataclass
class _SingleModel:
    """A `WorkerDeps.models` stand-in that answers every provider with the same fake `LLM`, for tests that
    don't care which provider name was asked for."""

    llm: Any

    def for_provider(self, _name: str) -> Any:
        return self.llm


@dataclass
class _RecordingModels:
    """A `WorkerDeps.models` stand-in backed by one fake `LLM` per provider name, so a test can see which
    one a job actually used."""

    clients: dict[str, Any]

    def for_provider(self, name: str) -> Any:
        return self.clients[name]


def make_worker(cfg: WorkerConfig, store: FakeStore, llm: Any, tmp_path: Path, made: list[ProcessSandbox]):
    def factory(job: Job) -> ProcessSandbox:
        sbx = ProcessSandbox.create(job.repo_url, job.ref, tmp_path / "ws")
        made.append(sbx)
        return sbx

    deps = WorkerDeps(
        store=store,
        models=_SingleModel(llm),
        prices=make_prices(),
        publisher=RecordingPublisher(sealed=[]),
        make_sandbox=factory,
        harness=make_harness_config(),
    )
    return Worker(cfg, deps)


def test_empty_queue_returns_false(cfg: WorkerConfig, tmp_path: Path):
    assert make_worker(cfg, FakeStore([]), ScriptedLLM([]), tmp_path, []).run_once() is False


def _unused_sandbox(_job: Job) -> ProcessSandbox:
    raise AssertionError("no job should have been claimed")


class _RaisingStore:
    def claim(self) -> Job | None:
        raise RuntimeError("the database is unreachable")

    def report(self, outcome: RunOutcome) -> None:  # pragma: no cover - never reached
        raise AssertionError

    def fail(self, task_id: str, message: str) -> None:  # pragma: no cover - never reached
        raise AssertionError


class _RaisingPr:
    def run_once(self) -> bool:
        raise RuntimeError("GitHub is unreachable")


def test_a_failed_claim_does_not_crash_the_worker(cfg: WorkerConfig):
    """A dropped database connection a job store could not recover from must not take the whole worker
    process down with it; the poll loop backs off and tries again."""
    deps = WorkerDeps(
        store=_RaisingStore(),
        models=_SingleModel(ScriptedLLM([])),
        prices=make_prices(),
        publisher=RecordingPublisher(sealed=[]),
        make_sandbox=_unused_sandbox,
        harness=make_harness_config(),
    )
    assert Worker(cfg, deps).run_once() is False


def test_a_crashing_pr_queue_does_not_stop_job_processing(cfg: WorkerConfig):
    """A crash opening a pull request must not stop this process from still claiming ordinary jobs on
    its next turn."""
    deps = WorkerDeps(
        store=FakeStore([]),
        models=_SingleModel(ScriptedLLM([])),
        prices=make_prices(),
        publisher=RecordingPublisher(sealed=[]),
        make_sandbox=_unused_sandbox,
        harness=make_harness_config(),
        pr=_RaisingPr(),
    )
    assert Worker(cfg, deps).run_once() is False


class _ObservingLLM(ScriptedLLM):
    """A `ScriptedLLM` that also remembers every `messages` list it was called with."""

    def __init__(self, turns: list[Any]) -> None:
        super().__init__(turns)
        self.seen_messages: list[list[dict[str, Any]]] = []

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> Any:
        self.seen_messages.append(list(messages))  # a snapshot: `messages` itself grows in place
        return super().complete(messages, tools, model, system=system, max_tokens=max_tokens)


def test_dependency_patches_are_applied_before_the_agent_runs(
    cfg: WorkerConfig, repo_url: str, tmp_path: Path
):
    """A task that depends on another must see that dependency's actual change, not the plan's bare
    base ref, before its own agent loop starts."""
    patch = (
        "diff --git a/payments/dep.py b/payments/dep.py\n"
        "new file mode 100644\n"
        "index 0000000..9daeafb\n"
        "--- /dev/null\n"
        "+++ b/payments/dep.py\n"
        "@@ -0,0 +1 @@\n"
        "+DEP = 1\n"
    )
    job = make_job(repo_url, depends_on=(0,), dependency_patches=(patch,))
    store, made = FakeStore([job]), []
    llm = _ObservingLLM([turn(("read_file", {"path": "payments/dep.py"})), turn(("finish", {}))])
    worker = make_worker(cfg, store, llm, tmp_path, made)
    assert worker.run_once() is True
    assert store.failures == []
    # The second call's messages carry the first call's tool result; it only contains the dependency's
    # file if the patch was applied to the checkout before the agent's first turn ran.
    tool_result = llm.seen_messages[1][-1]["content"][0]
    assert tool_result["is_error"] is False
    assert tool_result["content"] == "DEP = 1\n"


def test_a_dependency_patch_that_does_not_apply_fails_the_job(
    cfg: WorkerConfig, repo_url: str, tmp_path: Path
):
    job = make_job(repo_url, depends_on=(0,), dependency_patches=("not a valid patch at all\n",))
    store, made = FakeStore([job]), []
    worker = make_worker(cfg, store, ScriptedLLM([]), tmp_path, made)
    assert worker.run_once() is True
    assert [t for t, _ in store.failures] == [job.task_id]
    assert "dependency task 0" in store.failures[0][1]
    assert store.reports == []


def test_job_is_run_reported_and_sandbox_destroyed(cfg: WorkerConfig, repo_url: str, tmp_path: Path):
    store, made = FakeStore([make_job(repo_url)]), []
    worker = make_worker(cfg, store, ScriptedLLM([turn(FIX), turn(("finish", {}))]), tmp_path, made)
    assert worker.run_once() is True
    assert [(o.holds, o.task_id) for o in store.reports] == [(True, store.reports[0].task_id)]
    assert store.failures == []
    assert not made[0].workspace.work.exists()


def test_a_crashing_job_is_failed_and_the_worker_goes_on(cfg: WorkerConfig, repo_url: str, tmp_path: Path):
    bad = make_job(repo_url, attempt=2)  # task_id no longer matches: the harness refuses it
    good = make_job(repo_url)
    store, made = FakeStore([bad, good]), []
    worker = make_worker(cfg, store, ScriptedLLM([turn(("finish", {}))]), tmp_path, made)
    worker.run_once()
    worker.run_once()
    assert [t for t, _ in store.failures] == [bad.task_id]
    assert "task_id" in store.failures[0][1]
    assert [o.task_id for o in store.reports] == [good.task_id]
    assert all(not s.workspace.work.exists() for s in made)  # both sandboxes cleaned up


def test_unknown_agent_fails_the_job_without_a_sandbox(cfg: WorkerConfig, repo_url: str, tmp_path: Path):
    store, made = FakeStore([make_job(repo_url, agent_id="9")]), []
    make_worker(cfg, store, ScriptedLLM([]), tmp_path, made).run_once()
    assert made == []
    assert "agent '9'" in store.failures[0][1]


def test_failure_message_never_contains_the_signing_key(cfg: WorkerConfig, repo_url: str, tmp_path: Path):
    store = FakeStore([make_job(repo_url, attempt=2)])
    make_worker(cfg, store, ScriptedLLM([]), tmp_path, []).run_once()
    assert KEY not in store.failures[0][1]


def test_run_forever_stops_when_asked(cfg: WorkerConfig, tmp_path: Path):
    stop = threading.Event()
    worker = make_worker(cfg, FakeStore([]), ScriptedLLM([]), tmp_path, [])
    t = threading.Thread(target=worker.run_forever, args=(stop,))
    t.start()
    stop.set()
    t.join(timeout=5)
    assert not t.is_alive()


def test_each_job_uses_its_agents_provider(tmp_path: Path, repo_url: str, monkeypatch: pytest.MonkeyPatch):
    """Two agents naming different providers must each reach their own model client: a job for agent 1
    never calls provider 2's client, and vice versa."""
    monkeypatch.setenv("MERGIT_AGENT_KEY_1", KEY)
    monkeypatch.setenv("MERGIT_AGENT_KEY_2", KEY)
    agents = tmp_path / "agents.json"
    agents.write_text(
        json.dumps(
            {
                "agents": [
                    {"agent_id": "1", "name": "a1", "runtime_key": KEY_ADDRESS},
                    {"agent_id": "2", "name": "a2", "runtime_key": KEY_ADDRESS},
                ]
            }
        )
    )
    toml = tmp_path / "agents.toml"
    toml.write_text(
        '[providers.p1]\nkind = "anthropic"\n\n'
        '[providers.p2]\nkind = "anthropic"\n\n'
        '[agents.a1]\nprovider = "p1"\nmodel = "test-model"\nsystem_prompt = "p"\n'
        '[agents.a2]\nprovider = "p2"\nmodel = "test-model"\nsystem_prompt = "p"\n'
    )
    cfg = WorkerConfig(
        database_url="postgres://x",
        gateway_url="http://g",
        store_url="http://s",  # type: ignore[arg-type]
        events_token="e",
        store_write_token="s",
        receipt_registry=REGISTRY,  # type: ignore[arg-type]
        agents_file=agents,
        agents_config=toml,
        poll_interval_s=0.01,
    )

    llm1, llm2 = ScriptedLLM([turn(("finish", {}))]), ScriptedLLM([turn(("finish", {}))])
    models = _RecordingModels({"p1": llm1, "p2": llm2})
    made: list[ProcessSandbox] = []

    def factory(job: Job) -> ProcessSandbox:
        sbx = ProcessSandbox.create(job.repo_url, job.ref, tmp_path / f"ws-{job.agent_id}")
        made.append(sbx)
        return sbx

    store = FakeStore([make_job(repo_url, agent_id="1"), make_job(repo_url, agent_id="2")])
    deps = WorkerDeps(
        store=store,
        models=models,
        prices=make_prices(),
        publisher=RecordingPublisher(sealed=[]),
        make_sandbox=factory,
        harness=make_harness_config(),
    )
    worker = Worker(cfg, deps)

    assert worker.run_once() is True
    assert (llm1.calls, llm2.calls) == (1, 0)
    assert worker.run_once() is True
    assert (llm1.calls, llm2.calls) == (1, 1)
    assert store.failures == []


def test_missing_key_for_deployed_agent_refuses_start():
    """A provider every deployed agent needs, with no key for it, is caught once at start-up: the error
    names the provider and the environment variable it needs, never leaving that discovery for a job's
    first model call."""
    providers = {
        "openrouter": ProviderSpec(
            name="openrouter",
            kind="openai_chat",
            base_url="https://openrouter.ai/api/v1",
            api_key_env="OPENROUTER_API_KEY",
        )
    }
    with pytest.raises(ConfigError, match="OPENROUTER_API_KEY"):
        ModelClients.build(providers, {"openrouter"}, timeout_s=1.0, environ={})
    ModelClients.build(providers, set(), timeout_s=1.0, environ={})  # no agent needs it: does not raise


def test_two_anthropic_providers_each_use_their_own_key():
    """Two `[providers.*]` tables can both be `kind = "anthropic"` with different `api_key_env` values.
    Start-up checks that each one's own key is present (`provider_key`); the client built for each must then
    actually send that provider's key, not whichever of `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` the SDK
    would pick for itself if neither were passed explicitly."""
    providers = {
        "claude-a": ProviderSpec(
            name="claude-a", kind="anthropic", base_url=None, api_key_env="CLAUDE_A_KEY"
        ),
        "claude-b": ProviderSpec(
            name="claude-b", kind="anthropic", base_url=None, api_key_env="CLAUDE_B_KEY"
        ),
    }
    env = {"CLAUDE_A_KEY": "key-a", "CLAUDE_B_KEY": "key-b"}
    models = ModelClients.build(providers, {"claude-a", "claude-b"}, timeout_s=1.0, environ=env)
    assert models.for_provider("claude-a")._client.api_key == "key-a"  # type: ignore[attr-defined]
    assert models.for_provider("claude-b")._client.api_key == "key-b"  # type: ignore[attr-defined]


def test_the_default_anthropic_provider_still_lets_the_sdk_read_its_own_env_vars(
    monkeypatch: pytest.MonkeyPatch,
):
    """A provider with no `api_key_env` (the common single-Anthropic-provider deploy) keeps today's
    behavior: the SDK reads `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` itself, so a gateway token works
    exactly as it always has."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sdk-default-key")
    providers = {
        "anthropic": ProviderSpec(name="anthropic", kind="anthropic", base_url=None, api_key_env=None)
    }
    models = ModelClients.build(providers, {"anthropic"}, timeout_s=1.0, environ={"ANTHROPIC_API_KEY": "x"})
    assert models.for_provider("anthropic")._client.api_key == "sdk-default-key"  # type: ignore[attr-defined]
