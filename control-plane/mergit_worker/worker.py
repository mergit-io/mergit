"""The worker loop: claim one job, run it in a fresh sandbox, report. One job at a time per process."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from .agents import load_agent_spec
from .config import WorkerConfig
from .harness import HarnessConfig, Publisher, run_task
from .jobs import JobStore
from .llm import ModelClients
from .meter import PriceTable
from .models import Job
from .pr_worker import PrHandler
from .progress import NullProgressReporter, ProgressReporter
from .sandbox import SandboxPort
from .workspace import WorkspaceError

log = logging.getLogger(__name__)

SandboxFactory = Callable[[Job], SandboxPort]


@dataclass(frozen=True, slots=True)
class WorkerDeps:
    store: JobStore
    models: ModelClients
    prices: PriceTable
    publisher: Publisher
    make_sandbox: SandboxFactory
    harness: HarnessConfig
    progress: ProgressReporter = field(default_factory=NullProgressReporter)
    pr: PrHandler | None = None  # present only when a GitHub token is configured


class Worker:
    def __init__(self, cfg: WorkerConfig, deps: WorkerDeps) -> None:
        self._cfg = cfg
        self._deps = deps

    def run_once(self) -> bool:
        """Handle at most one job or approved PR request. Returns False when both queues were empty."""
        try:
            job = self._deps.store.claim()
        except Exception:  # a failed claim must not stop the worker either
            log.exception("claiming a job failed")
            job = None
        if job is None:
            if self._deps.pr is None:
                return False
            try:
                return self._deps.pr.run_once()
            except Exception:  # a crash in the PR queue must not stop job processing
                log.exception("the pull-request queue failed")
                return False
        log.info("claimed task %s (agent %s, attempt %d)", job.task_id, job.agent_id, job.attempt)
        try:
            self._run(job)
        except Exception as exc:  # one bad job must not stop the worker
            log.exception("task %s failed", job.task_id)
            self._deps.store.fail(job.task_id, f"{type(exc).__name__}: {exc}")
        return True

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            if not self.run_once():
                stop.wait(self._cfg.poll_interval_s)

    def _run(self, job: Job) -> None:
        agent = load_agent_spec(job.agent_id, self._cfg.agents_file, self._cfg.agents_config)
        sandbox = self._deps.make_sandbox(job)
        try:
            self._apply_dependency_patches(job, sandbox)
            outcome = run_task(
                job,
                agent,
                sandbox,
                self._deps.models.for_provider(agent.provider),
                self._deps.prices,
                self._deps.publisher,
                self._deps.harness,
                self._deps.progress,
            )
        finally:
            sandbox.destroy()
        self._deps.store.report(outcome)
        log.info("task %s done: holds=%s notes=%s", job.task_id, outcome.holds, outcome.notes)

    def _apply_dependency_patches(self, job: Job, sandbox: SandboxPort) -> None:
        """A task that depends on another starts from that dependency's actual passing change, not the
        plan's bare base ref, or the agent may never see code it needs and Φ runs against the wrong
        tree. Applied in index order, the same order the pull-request gate (plan task O9) later combines
        patches in, so a patch that applies here will apply there too. A dependency with no tracked
        change at all (`""`) has nothing to apply and is skipped, not an error."""
        for index, patch in zip(job.depends_on, job.dependency_patches, strict=True):
            if not patch:
                continue
            try:
                sandbox.workspace.apply_patch(patch)
            except WorkspaceError as exc:
                raise WorkspaceError(f"dependency task {index}'s change does not apply here: {exc}") from exc
