"""Typed worker configuration. Every limit, URL and secret comes from here, none from code."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_AGENT_KEY = re.compile(r"^0x[0-9a-fA-F]{64}$")


class ConfigError(Exception):
    """Configuration is missing or malformed. The worker refuses to start."""


class WorkerConfig(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    database_url: SecretStr
    gateway_url: str
    store_url: str
    events_token: SecretStr
    store_write_token: SecretStr
    receipt_registry: str
    chain_id: int = 84532

    agents_file: Path
    agents_config: Path = Path("agents.toml")
    prices_file: Path = Path("prices.toml")

    sandbox_image: str = "mergit-sandbox:dev"
    sandbox_runtime: str | None = None  # "runsc" for gVisor; None uses the daemon default
    sandbox_memory: str = "2g"
    sandbox_nano_cpus: int = 2_000_000_000
    sandbox_pids_limit: int = 512
    sandbox_allowed_url_schemes: tuple[str, ...] = ("https",)
    sandbox_workspace_root: Path = Path("/var/lib/mergit/workspaces")
    runtime_image: str = "mergit-runtime:dev"

    # Pull-request gate (O9). The token exists only in the worker's environment. Without it the worker
    # still runs tasks and simply never picks up PR requests.
    github_token: SecretStr | None = None
    github_api_url: str = "https://api.github.com"
    github_git_base_url: str = "https://github.com"
    github_hosts: tuple[str, ...] = ("github.com",)
    app_base_url: str = "https://app.mergit.site"
    pr_author_name: str = "mergit"
    pr_author_email: str = "mergit@users.noreply.github.com"

    max_steps: int = Field(default=60, ge=1)
    max_output_bytes: int = Field(default=1_048_576, ge=1)
    max_write_bytes: int = Field(default=1_048_576, ge=1)
    max_hash_bytes: int = Field(default=64 * 1024 * 1024, ge=1)
    max_patch_bytes: int = Field(default=5 * 1024 * 1024, ge=1)
    model_output_bytes: int = Field(default=32_768, ge=1024)
    command_timeout_s: int = Field(default=300, ge=1, le=3600)
    git_timeout_s: float = Field(default=300.0, gt=0)
    # Under the 1800 s dispatch deadline, leaving time to run Φ, seal and publish.
    job_deadline_s: float = Field(default=1500.0, gt=0)
    worker_id: str | None = None  # defaults to the hostname; one process per id
    # Refuse to start unless every agent in the agents file has a MERGIT_AGENT_KEY_<id>. Off by default: a
    # worker may deliberately serve only some of the agents (startup.agents_without_key logs the rest).
    require_all_agent_keys: bool = False
    # Opus 5.5's thinking tokens count against this; 8192 made a truncated turn too likely.
    model_max_tokens: int = Field(default=16_000, ge=256)
    poll_interval_s: float = Field(default=2.0, gt=0)
    http_timeout_s: float = Field(default=30.0, gt=0)
    publish_retry_window_s: float = Field(default=600.0, gt=0)
    # A `running` job claimed longer ago than this, by any worker id, is presumed abandoned (a crashed
    # or killed container) and reclaimed at start-up. Comfortably above one job's own worst case:
    # job_deadline_s, plus a full Φ timeout, plus publish_retry_window_s.
    job_lease_s: float = Field(default=3600.0, gt=0)

    # Live step reporting to the control plane's run API (plan task O7), purely for a viewer watching the
    # run. Both optional and both required together: without them the worker still does everything else,
    # it just reports no steps live.
    control_plane_url: str | None = None
    worker_token: SecretStr | None = None

    @field_validator("receipt_registry")
    @classmethod
    def _registry_is_address(cls, v: str) -> str:
        if not _ADDRESS.match(v):
            raise ValueError("receipt_registry must be 0x plus 40 hex characters")
        return v

    @field_validator("gateway_url", "store_url")
    @classmethod
    def _url_without_trailing_slash(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("must be an http(s) URL")
        return v.rstrip("/")


def load_config() -> WorkerConfig:
    try:
        return WorkerConfig()  # type: ignore[call-arg]  # fields come from the environment
    except ValueError as exc:
        raise ConfigError(str(exc)) from exc


def agent_signing_key(agent_id: str, environ: Mapping[str, str] | None = None) -> SecretStr:
    """The agent's runtime key from `MERGIT_AGENT_KEY_<agent_id>`. Never read from a file or argument."""
    env = os.environ if environ is None else environ
    name = f"MERGIT_AGENT_KEY_{agent_id}"
    value = env.get(name, "")
    if not _AGENT_KEY.match(value):
        raise ConfigError(f"{name} is unset or not a 0x-prefixed 32-byte hex key")
    return SecretStr(value)
