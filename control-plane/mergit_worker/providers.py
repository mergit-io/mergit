"""Which model provider runs, decided once at start-up from the environment.

Anthropic is the provider whenever `ANTHROPIC_API_KEY` is set. Groq is the fallback when only `GROQ_API_KEY`
is set.
`LLM_PROVIDER=anthropic|groq` forces one. The choice is made once and logged, never per call: a receipt names
the model
that produced it, so a run must not change model halfway.

On Groq every agent and the planner run `GROQ_MODEL` (default `openai/gpt-oss-120b`) in place of the Claude
ids in
`agents.toml` / `PLANNER_MODEL`. The swap happens when the agent is loaded, before anything is priced, so the
receipt
carries the Groq model's name and the Groq price for what actually ran.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from .config import ConfigError

DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
_CHOICES = ("auto", "anthropic", "groq")


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


def effective_model(configured: str, environ: Mapping[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    if llm_provider(env) != "groq":
        return configured
    return env.get("GROQ_MODEL") or DEFAULT_GROQ_MODEL
