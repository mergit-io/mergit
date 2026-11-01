"""The provider each agent and the planner use, each named once in `agents.toml` (or, for the planner, in
the control-plane's own `Settings.planner_provider`).

`[providers.<name>]` tables in `agents.toml` name a provider's implementation (`kind`) and, for an
OpenAI-compatible one, its `base_url` and the environment variable holding its key. `load_providers` reads
every one of them once at start-up; each agent in `[agents.<name>]` names one by `provider`, and the planner
names one by `planner_provider`. A run never changes model or provider halfway: the choice is made once, at
start-up, and a receipt names the model that produced it.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import ConfigError

_KINDS = ("anthropic", "openai_chat")


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    kind: Literal["anthropic", "openai_chat"]
    base_url: str | None
    api_key_env: str | None


def load_providers(agents_config: Path) -> dict[str, ProviderSpec]:
    """Every `[providers.<name>]` table in `agents_config`. An `openai_chat` provider must give `base_url`
    and `api_key_env`; `anthropic` needs neither (`provider_key` falls back to the SDK's own environment
    variables)."""
    tables: dict[str, Any] = tomllib.loads(agents_config.read_text()).get("providers", {})
    providers: dict[str, ProviderSpec] = {}
    for name, table in tables.items():
        kind = table.get("kind")
        if kind not in _KINDS:
            raise ConfigError(f"provider {name!r} has kind {kind!r}, must be one of {', '.join(_KINDS)}")
        base_url = table.get("base_url")
        api_key_env = table.get("api_key_env")
        if kind == "openai_chat" and (not base_url or not api_key_env):
            raise ConfigError(f"provider {name!r} needs base_url and api_key_env for kind openai_chat")
        providers[str(name)] = ProviderSpec(
            name=str(name), kind=kind, base_url=base_url, api_key_env=api_key_env
        )
    return providers


def provider_key(spec: ProviderSpec, environ: Mapping[str, str]) -> str | None:
    """The credential this provider's client should send. `anthropic` with no `api_key_env` falls back to
    `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, which the SDK also reads itself."""
    if spec.api_key_env:
        return environ.get(spec.api_key_env)
    if spec.kind == "anthropic":
        return environ.get("ANTHROPIC_API_KEY") or environ.get("ANTHROPIC_AUTH_TOKEN")
    return None
