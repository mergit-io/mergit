"""`python -m mergit_worker.preflight`: the worker's start-up configuration checks, and nothing else.

deploy/server/update.sh runs this in the freshly built image, with the real env file, before it swaps the
running container. A configuration the new code cannot start from (a deployed agent whose provider has no
key, an unpriced model, a missing setting) then fails the deploy while the old worker keeps running, instead
of leaving a new one that refuses to start. It touches no database and makes no network call.

`build_worker` calls `check_models` too, so the deploy checks exactly what start-up checks.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass

from .agents import deployed_agents, validate_agents_are_priced, validate_agents_have_keys
from .config import ConfigError, WorkerConfig, load_config
from .llm import ModelClients
from .meter import PriceTable
from .providers import check_model_id, load_providers, stale_settings


@dataclass(frozen=True)
class Models:
    prices: PriceTable
    clients: ModelClients
    providers: set[str]
    """The providers a deployed agent uses."""
    stale: list[str]
    """Removed settings still set in the environment, to warn about (`providers.REMOVED_SETTINGS`)."""


def check_models(cfg: WorkerConfig, environ: Mapping[str, str] | None = None) -> Models:
    """Every deployed agent is priced, and its provider is configured and has a key."""
    env = os.environ if environ is None else environ
    prices = PriceTable.load(cfg.prices_file)
    validate_agents_are_priced(cfg.agents_file, cfg.agents_config, prices)
    needed = validate_agents_have_keys(cfg.agents_file, cfg.agents_config)
    providers = load_providers(cfg.agents_config)
    for _entry, agent in deployed_agents(cfg.agents_file, cfg.agents_config):
        spec = providers.get(str(agent.get("provider"))) if agent else None
        if agent and spec is not None:
            check_model_id(spec, str(agent.get("model")))
    stale = stale_settings(providers, needed, env)
    clients = ModelClients.build(providers, needed, cfg.http_timeout_s * 20, env)
    return Models(prices, clients, needed, stale)


def main() -> int:
    try:
        checked = check_models(load_config())
    except (ConfigError, ValueError, OSError) as exc:
        print(f"worker preflight failed: {' '.join(str(exc).split())}", file=sys.stderr)
        return 1
    if checked.stale:
        print(
            f"worker preflight warning: no longer read, remove from the env file: {', '.join(checked.stale)}"
        )
    print(f"worker preflight ok: providers {', '.join(sorted(checked.providers)) or '(none)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
