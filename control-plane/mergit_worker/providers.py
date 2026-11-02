"""The provider each agent and the planner use, each named once in `agents.toml` (or, for the planner, in
the control-plane's own `Settings.planner_provider`).

`[providers.<name>]` tables in `agents.toml` name a provider's implementation (`kind`) and, for an
OpenAI-compatible one, its `base_url` and the environment variable holding its key. `load_providers` reads
every one of them once at start-up; each agent in `[agents.<name>]` names one by `provider`, and the planner
names one by `planner_provider`. A run never changes model or provider halfway: the choice is made once, at
start-up, and a receipt names the model that produced it.
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlsplit

from .config import ConfigError

_KINDS = ("anthropic", "openai_chat")

# The provider key is sent to `base_url` as a Bearer token, and `agents.toml` ships with every push to main,
# so an edit to that file alone must not be able to send a key, or any other secret in the worker's or the
# API's environment, somewhere new. A provider endpoint is therefore one of these hosts over https on the
# default port, or keyrelay (deploy/server/README.md), which is plain http on the compose network and
# publishes no port. A new provider host is a change to this list, reviewed as code.
_PROVIDER_HOSTS = frozenset({"api.groq.com", "openrouter.ai"})
_KEYRELAY = ("http", "keyrelay", 8787)
# Every model provider's key is named `<SOMETHING>_API_KEY`, and none of Mergit's own secrets is: they are
# `*_TOKEN`, `*_SECRET`, `*_KEY`, `DATABASE_URL` or `MERGIT_AGENT_KEY_<id>`. `MERGIT_` is refused outright
# so a future Mergit secret cannot match by accident.
_API_KEY_ENV = re.compile(r"[A-Z][A-Z0-9_]*_API_KEY")


def _check_base_url(name: str, base_url: str) -> None:
    try:
        url = urlsplit(base_url)
        port = url.port
    except ValueError as exc:
        raise ConfigError(f"provider {name!r} has an unreadable base_url {base_url!r}: {exc}") from exc
    if url.username is not None or url.password is not None:
        raise ConfigError(f"provider {name!r} base_url must not carry credentials")
    host = (url.hostname or "").lower()
    if (url.scheme, host, port) == _KEYRELAY:
        return
    if url.scheme != "https" or host not in _PROVIDER_HOSTS or port not in (None, 443):
        raise ConfigError(
            f"provider {name!r} base_url {base_url!r} is not an allowed provider endpoint: it must be https "
            f"on one of {', '.join(sorted(_PROVIDER_HOSTS))}, or http://keyrelay:8787. A new provider host "
            "is added to _PROVIDER_HOSTS in mergit_worker/providers.py"
        )


def _check_api_key_env(name: str, api_key_env: str) -> None:
    if not _API_KEY_ENV.fullmatch(api_key_env) or api_key_env.startswith("MERGIT_"):
        raise ConfigError(
            f"provider {name!r} api_key_env {api_key_env!r} must name a model provider's key, "
            "<PROVIDER>_API_KEY in capitals, and never one of Mergit's own secrets"
        )


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    kind: Literal["anthropic", "openai_chat"]
    base_url: str | None
    api_key_env: str | None


def load_providers(agents_config: Path) -> dict[str, ProviderSpec]:
    """Every `[providers.<name>]` table in `agents_config`. An `openai_chat` provider must give `base_url`
    and `api_key_env`; `anthropic` needs neither (`provider_key` falls back to the SDK's own environment
    variables) and may not give a `base_url`, which its client would ignore. Both fields are checked
    against the rules above, so the file cannot point a key at a new host or name a Mergit secret."""
    tables: dict[str, Any] = tomllib.loads(agents_config.read_text()).get("providers", {})
    providers: dict[str, ProviderSpec] = {}
    for name, table in tables.items():
        if not isinstance(table, dict):
            raise ConfigError(f"provider {name!r} must be a [providers.{name}] table, got {table!r}")
        table = cast("dict[str, Any]", table)
        kind = table.get("kind")
        if kind not in _KINDS:
            raise ConfigError(f"provider {name!r} has kind {kind!r}, must be one of {', '.join(_KINDS)}")
        base_url = table.get("base_url")
        api_key_env = table.get("api_key_env")
        for field, value in (("base_url", base_url), ("api_key_env", api_key_env)):
            if value is not None and not isinstance(value, str):
                raise ConfigError(f"provider {name!r} {field} must be a string, got {value!r}")
        if kind == "openai_chat" and (not base_url or not api_key_env):
            raise ConfigError(f"provider {name!r} needs base_url and api_key_env for kind openai_chat")
        if kind == "anthropic" and base_url is not None:
            raise ConfigError(f"provider {name!r} of kind anthropic does not use base_url; remove it")
        if base_url is not None:
            _check_base_url(str(name), base_url)
        if api_key_env is not None:
            _check_api_key_env(str(name), api_key_env)
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


# Read by earlier versions, ignored now: a provider's endpoint and model are in `agents.toml`, and each agent
# and the planner name their provider there (or in `PLANNER_PROVIDER`). Still set, they mislead whoever
# reads the env file, so start-up names them.
REMOVED_SETTINGS = ("GROQ_BASE_URL", "GROQ_MODEL", "LLM_PROVIDER")


def stale_settings(
    providers: Mapping[str, ProviderSpec], in_use: set[str], environ: Mapping[str, str]
) -> list[str]:
    """The removed settings still set in `environ`, for start-up to warn about.

    One of them is refused instead: `GROQ_BASE_URL` naming another endpoint than the one `agents.toml` gives
    a provider in use that reads `GROQ_API_KEY`. That env file was written for keyrelay, so `GROQ_API_KEY`
    holds keyrelay's proxy token, and with `GROQ_BASE_URL` ignored the token would now go to the endpoint in
    `agents.toml` instead."""
    stale = [name for name in REMOVED_SETTINGS if environ.get(name)]
    old_url = (environ.get("GROQ_BASE_URL") or "").rstrip("/")
    for name in sorted(in_use):
        spec = providers.get(name)
        if spec is None or spec.api_key_env != "GROQ_API_KEY" or not old_url or not spec.base_url:
            continue
        if old_url != spec.base_url.rstrip("/"):
            raise ConfigError(
                f"GROQ_BASE_URL is set but no longer read, and provider {name!r} now sends GROQ_API_KEY to "
                f"{spec.base_url} (agents.toml) instead. Set that provider's base_url in agents.toml to the "
                "endpoint you meant (http://keyrelay:8787/v1 for keyrelay), then remove GROQ_BASE_URL"
            )
    return stale
