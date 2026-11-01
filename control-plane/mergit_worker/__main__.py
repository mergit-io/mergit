"""`python -m mergit_worker`: build every dependency from configuration and run the worker loop."""

from __future__ import annotations

import logging
import signal
import socket
import threading
from dataclasses import dataclass

from mergit_cp.pr_store import PgPrStore

from .agents import validate_agents_are_priced, validate_agents_have_keys
from .config import ConfigError, WorkerConfig, load_config
from .github import GitHubConfig, GitHubPrOpener
from .harness import HarnessConfig
from .jobs import PgJobStore
from .llm import ModelClients
from .meter import PriceTable
from .models import Job
from .pr_worker import PrHandler
from .progress import HttpProgressReporter, NullProgressReporter, ProgressReporter
from .providers import load_providers
from .publish import ReceiptPublisher
from .sandbox import Sandbox, SandboxConfig, reap_stale
from .tools import ToolLimits
from .worker import Worker, WorkerDeps
from .workspace import GitLimits


def build_progress_reporter(cfg: WorkerConfig) -> ProgressReporter:
    """Live step reporting needs both settings; with only one set, that is a misconfiguration worth
    logging, not a silent partial feature."""
    if cfg.control_plane_url and cfg.worker_token:
        return HttpProgressReporter(cfg.control_plane_url, cfg.worker_token.get_secret_value())
    if cfg.control_plane_url or cfg.worker_token:
        logging.getLogger("mergit_worker").warning(
            "CONTROL_PLANE_URL and WORKER_TOKEN must both be set for live step reporting; only one is, "
            "so it stays off"
        )
    return NullProgressReporter()


@dataclass
class Built:
    worker: Worker
    jobs: PgJobStore
    prs: PgPrStore | None
    providers: set[str]

    def close(self) -> None:
        self.jobs.close()
        if self.prs is not None:
            self.prs.close()


def build_pr_handler(cfg: WorkerConfig, worker_id: str) -> tuple[PrHandler, PgPrStore] | None:
    """The PR gate runs only where a GitHub token is configured, and only in this process."""
    if cfg.github_token is None:
        return None
    store = PgPrStore.connect(cfg.database_url.get_secret_value(), worker_id)
    opener = GitHubPrOpener(
        GitHubConfig(
            token=cfg.github_token.get_secret_value(),
            api_url=cfg.github_api_url,
            git_base_url=cfg.github_git_base_url,
            hosts=cfg.github_hosts,
            app_base_url=cfg.app_base_url,
            author_name=cfg.pr_author_name,
            author_email=cfg.pr_author_email,
            workspace_root=cfg.sandbox_workspace_root,
            git=GitLimits(cfg.sandbox_allowed_url_schemes, cfg.git_timeout_s),
            http_timeout_s=cfg.http_timeout_s,
        )
    )
    return PrHandler(store, opener), store


def build_worker(cfg: WorkerConfig, worker_id: str) -> Built:
    sandbox_cfg = SandboxConfig(
        image=cfg.sandbox_image,
        memory=cfg.sandbox_memory,
        nano_cpus=cfg.sandbox_nano_cpus,
        pids_limit=cfg.sandbox_pids_limit,
        runtime=cfg.sandbox_runtime,
        max_output_bytes=cfg.max_output_bytes,
        workspace_root=cfg.sandbox_workspace_root,
        git=GitLimits(cfg.sandbox_allowed_url_schemes, cfg.git_timeout_s),
        owner=worker_id,
    )

    def make_sandbox(job: Job) -> Sandbox:
        return Sandbox.create(job.repo_url, job.ref, sandbox_cfg)

    prices = PriceTable.load(cfg.prices_file)
    validate_agents_are_priced(cfg.agents_file, cfg.agents_config, prices)
    needed = validate_agents_have_keys(cfg.agents_file, cfg.agents_config)
    models = ModelClients.build(load_providers(cfg.agents_config), needed, cfg.http_timeout_s * 20)
    store = PgJobStore.connect(cfg.database_url.get_secret_value(), worker_id)
    pr = build_pr_handler(cfg, worker_id)
    deps = WorkerDeps(
        store=store,
        models=models,
        prices=prices,
        publisher=ReceiptPublisher(
            store_url=cfg.store_url,
            gateway_url=cfg.gateway_url,
            store_token=cfg.store_write_token.get_secret_value(),
            events_token=cfg.events_token.get_secret_value(),
            timeout_s=cfg.http_timeout_s,
            retry_window_s=cfg.publish_retry_window_s,
        ),
        make_sandbox=make_sandbox,
        progress=build_progress_reporter(cfg),
        pr=pr[0] if pr else None,
        harness=HarnessConfig(
            chain_id=cfg.chain_id,
            registry=cfg.receipt_registry,
            runtime_image=cfg.runtime_image,
            max_steps=cfg.max_steps,
            job_deadline_s=cfg.job_deadline_s,
            model_max_tokens=cfg.model_max_tokens,
            max_output_bytes=cfg.max_output_bytes,
            max_hash_bytes=cfg.max_hash_bytes,
            max_patch_bytes=cfg.max_patch_bytes,
            tool_limits=ToolLimits(
                command_timeout_s=cfg.command_timeout_s,
                max_output_bytes=cfg.max_output_bytes,
                max_write_bytes=cfg.max_write_bytes,
                model_output_bytes=cfg.model_output_bytes,
            ),
        ),
    )
    return Built(Worker(cfg, deps), store, pr[1] if pr else None, needed)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    log = logging.getLogger("mergit_worker")
    try:
        cfg = load_config()
    except ConfigError as exc:
        log.error("configuration error: %s", exc)
        return 2

    worker_id = cfg.worker_id or socket.gethostname()
    built = build_worker(cfg, worker_id)
    log.info("model providers: %s", ", ".join(sorted(built.providers)) or "(no deployed agent needs one)")
    log.info("failed %d jobs this worker left running before a restart", built.jobs.fail_own_running())
    log.info(
        "reclaimed %d jobs left running past their lease by any worker",
        built.jobs.reclaim_stale(cfg.job_lease_s),
    )
    if built.prs is not None:
        log.info(
            "requeued %d PR requests this worker left running before a restart",
            built.prs.requeue_own_running(),
        )
        log.info(
            "reclaimed %d PR requests left running past their lease by any worker",
            built.prs.reclaim_stale(cfg.job_lease_s),
        )
    else:
        log.info("no GITHUB_TOKEN: pull-request requests will not be handled by this worker")
    log.info("removed %d stale sandbox containers", reap_stale(worker_id))

    stop = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()  # finish the current job, then exit

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, request_stop)
    try:
        built.worker.run_forever(stop)
    finally:
        built.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
