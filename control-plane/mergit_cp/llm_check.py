"""Checks the model credential the way the planner and the agents use it, before a real run depends on it:
every provider actually in use, the planner's own (``Settings.planner_provider``) plus every provider named
by a deployed agent in ``agents.toml``.

    python -m mergit_cp.llm_check        (run inside the api container, or with the same env)

For each distinct (provider, model) pair actually in use, makes two tiny calls (a plain answer, then one
that must call a tool, because the agents work by tool calls): the planner's own provider and model, plus
every deployed agent's provider and model. Two agents sharing a provider but naming different models (the
shipped `claude-worker` and `second-worker`, both `openrouter` but one `anthropic/claude-sonnet-5` and the
other `deepseek/deepseek-v4-flash`) each get their own check; two agents naming the identical pair are
checked once, not twice. Prints the provider, the endpoint, the model, whether each call worked and its
token counts; never a key or a token. Exit status 0 only if every check worked.
"""

import asyncio
import json
import os
import tomllib
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from mergit_worker.config import ConfigError
from mergit_worker.providers import ProviderSpec, load_providers

from .config import Settings
from .llm import LLMError, LLMUnavailable, build_planner_llm

_TOOL = {
    "name": "report",
    "description": "Report the result.",
    "input_schema": {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
    },
}


def _endpoint(spec: ProviderSpec) -> str:
    if spec.kind == "openai_chat":
        return urlsplit(spec.base_url or "").hostname or spec.base_url or spec.name
    return urlsplit(os.environ.get("ANTHROPIC_BASE_URL", "")).hostname or "api.anthropic.com"


def _agent_pairs_in_use(agents_file: Path, agents_config: Path) -> set[tuple[str, str]]:
    """Every distinct (provider, model) pair actually used by a deployed agent, read the same way
    `mergit_worker.agents.validate_agents_have_keys` reads the deploy."""
    try:
        registry: list[dict[str, Any]] = json.loads(agents_file.read_text())["agents"]
        models: dict[str, Any] = tomllib.loads(agents_config.read_text())["agents"]
    except (OSError, KeyError, ValueError) as exc:
        raise ConfigError(f"cannot read agent configuration: {exc}") from exc
    pairs: set[tuple[str, str]] = set()
    for entry in registry:
        cfg: dict[str, Any] | None = models.get(str(entry.get("name")))
        provider = cfg.get("provider") if cfg else None
        model = cfg.get("model") if cfg else None
        if provider and model:  # a missing provider/model here is load_agent_spec's own clear error to raise
            pairs.add((str(provider), str(model)))
    return pairs


def _providers_in_use(settings: Settings) -> set[tuple[str, str]]:
    """Every distinct (provider, model) pair actually in use: the planner's own, plus every deployed
    agent's. Two agents sharing a provider but naming different models each keep their own pair; two naming
    the identical pair collapse to one (it's a `set`)."""
    pairs = {(settings.planner_provider, settings.planner_model)}
    pairs |= _agent_pairs_in_use(Path(settings.agents_file), Path(settings.agents_config))
    return pairs


async def _check_one(providers: dict[str, ProviderSpec], name: str, model: str) -> bool:
    spec = providers.get(name)
    if spec is None:
        print(f"provider={name}  model={model}  FAILED  no [providers.{name}] table in agents.toml")
        return False
    llm = build_planner_llm(providers, name)
    print(f"provider={name}  endpoint={_endpoint(spec)}  model={model}")
    ok = True
    steps: list[tuple[str, list[dict[str, Any]], list[dict[str, Any]] | None]] = [
        ("plain answer", [{"role": "user", "content": "Reply with the single word: ready"}], None),
        (
            "tool call",
            [
                {
                    "role": "user",
                    "content": "Call the report tool with answer set to ready. Do not write text.",
                }
            ],
            [_TOOL],
        ),
    ]
    for step_name, messages, tools in steps:
        try:
            result = await llm.complete(messages, tools, model)
        except (LLMUnavailable, LLMError) as problem:
            print(f"  {step_name}: FAILED  {str(problem)[:300]}")
            ok = False
            continue
        worked = bool(result.tool_calls) if tools else bool(result.text.strip())
        ok = ok and worked
        print(
            f"  {step_name}: {'ok' if worked else 'FAILED (the reply did not do what was asked)'}"
            f"  in={result.input_tokens} out={result.output_tokens} served_by={result.model}"
        )
    return ok


async def check(settings: Settings) -> bool:
    providers = load_providers(Path(settings.agents_config))
    ok = True
    for name, model in sorted(_providers_in_use(settings)):
        ok = await _check_one(providers, name, model) and ok
    return ok


def main() -> int:
    settings = Settings()  # type: ignore[call-arg]  # read from the environment, as the API does
    return 0 if asyncio.run(check(settings)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
