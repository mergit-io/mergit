"""Agent configuration for the worker: chain identity from `agents.json` joined with model and prompt
from `agents.toml` by agent `name`, and the signing key from the environment."""

from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .config import ConfigError, agent_signing_key
from .harness import AgentSpec
from .meter import PriceTable
from .providers import load_providers

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def load_agent_spec(
    agent_id: str, agents_file: Path, agents_config: Path, environ: Mapping[str, str] | None = None
) -> AgentSpec:
    try:
        registry: list[dict[str, Any]] = json.loads(agents_file.read_text())["agents"]
        models: dict[str, Any] = tomllib.loads(agents_config.read_text())["agents"]
    except (OSError, KeyError, ValueError) as exc:
        raise ConfigError(f"cannot read agent configuration: {exc}") from exc

    entry = next((a for a in registry if str(a.get("agent_id")) == agent_id), None)
    if entry is None:
        raise ConfigError(f"agent {agent_id!r} is not in {agents_file}")
    runtime_key = str(entry.get("runtime_key", ""))
    if not _ADDRESS.match(runtime_key):
        raise ConfigError(f"agent {agent_id!r} has no valid runtime_key address")
    name = str(entry.get("name"))
    cfg: dict[str, Any] | None = models.get(name)
    if not cfg or not cfg.get("model") or not cfg.get("system_prompt") or not cfg.get("provider"):
        raise ConfigError(f"agent {name!r} needs a provider, model and system_prompt in {agents_config}")
    provider = str(cfg["provider"])
    if provider not in load_providers(agents_config):
        raise ConfigError(
            f"agent {name!r} names provider {provider!r}, which has no [providers.{provider}] "
            f"table in {agents_config}"
        )

    return AgentSpec(
        agent_id=agent_id,
        provider=provider,
        model=str(cfg["model"]),
        system_prompt=str(cfg["system_prompt"]),
        runtime_key_address=runtime_key,
        signing_key=agent_signing_key(agent_id, environ).get_secret_value(),
    )


def validate_agents_have_keys(
    agents_file: Path, agents_config: Path, environ: Mapping[str, str] | None = None
) -> set[str]:
    """Every provider named by a deployed agent, read exactly as `validate_agents_are_priced` reads the
    deploy. This does not itself check that a key is present for each one: `ModelClients.build` does that,
    against the set this returns, so the two stay in lockstep by construction."""
    try:
        registry: list[dict[str, Any]] = json.loads(agents_file.read_text())["agents"]
        models: dict[str, Any] = tomllib.loads(agents_config.read_text())["agents"]
    except (OSError, KeyError, ValueError) as exc:
        raise ConfigError(f"cannot read agent configuration: {exc}") from exc
    needed: set[str] = set()
    for entry in registry:
        cfg: dict[str, Any] | None = models.get(str(entry.get("name")))
        provider = cfg.get("provider") if cfg else None
        if provider:  # a missing provider here is load_agent_spec's own clear error to raise
            needed.add(str(provider))
    return needed


def validate_agents_are_priced(agents_file: Path, agents_config: Path, prices: PriceTable) -> None:
    """Every agent with a model in `agents_config` must have that model in the price table, checked once
    at start-up. Otherwise a bad deploy is discovered only after a job has already paid the provider for
    a call whose receipt could never carry a real cost (`PriceTable.price` would raise mid-run)."""
    try:
        registry: list[dict[str, Any]] = json.loads(agents_file.read_text())["agents"]
        models: dict[str, Any] = tomllib.loads(agents_config.read_text())["agents"]
    except (OSError, KeyError, ValueError) as exc:
        raise ConfigError(f"cannot read agent configuration: {exc}") from exc
    for entry in registry:
        cfg: dict[str, Any] | None = models.get(str(entry.get("name")))
        model = cfg.get("model") if cfg else None
        if model:  # a missing model/system_prompt here is load_agent_spec's own clear error to raise
            prices.price(str(model))
