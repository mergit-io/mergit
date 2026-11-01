"""Which model provider runs, decided once at start-up from the environment, and the provider each agent
uses, named once in `agents.toml`.

Anthropic is the provider whenever `ANTHROPIC_API_KEY` is set. Groq is the fallback when only `GROQ_API_KEY`
is set. `LLM_PROVIDER=anthropic|groq` forces one. The choice is made once and logged, never per call: a
receipt names the model that produced it, so a run must not change model halfway.

`[providers.<name>]` tables in `agents.toml` name a provider's implementation (`kind`) and, for an
OpenAI-compatible one, its `base_url` and the environment variable holding its key. `load_providers` reads
every one of them once at start-up; each agent in `[agents.<name>]` then names one by `provider`.
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import ConfigError

_KINDS = ("anthropic", "openai_chat")
_CHOICES = ("auto", "anthropic", "groq")


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


def has_anthropic_credential(env: Mapping[str, str]) -> bool:
    """A real key, or the token a gateway such as Claude Lend hands out (used with ANTHROPIC_BASE_URL; the SDK
    reads both from the environment)."""
    return bool(env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN"))


def llm_provider(environ: Mapping[str, str] | None = None) -> str:
    """`anthropic` or `groq`. With no key at all it answers `anthropic`: nothing changes for a deploy that has
    a key or
    for tests, and `require_provider` is where a missing key becomes an error."""
    env = os.environ if environ is None else environ
    choice = env.get("LLM_PROVIDER", "auto").strip().lower() or "auto"
    if choice not in _CHOICES:
        raise ConfigError(f"LLM_PROVIDER must be one of {', '.join(_CHOICES)}, not {choice!r}")
    if choice != "auto":
        return choice
    if has_anthropic_credential(env):
        return "anthropic"
    return "groq" if env.get("GROQ_API_KEY") else "anthropic"


def require_provider(environ: Mapping[str, str] | None = None) -> str:
    """The provider, or a clear error when the key it needs is missing."""
    env = os.environ if environ is None else environ
    provider = llm_provider(env)
    if provider == "groq":
        key, present = "GROQ_API_KEY", bool(env.get("GROQ_API_KEY"))
    else:
        key, present = "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", has_anthropic_credential(env)
    if present:
        return provider
    if env.get("LLM_PROVIDER", "auto").strip().lower() in ("", "auto"):
        raise ConfigError(
            "set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or GROQ_API_KEY: "
            "the planner and the agents need a model"
        )
    raise ConfigError(f"LLM_PROVIDER={provider} needs {key}")
