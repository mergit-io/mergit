"""`python -m mergit_cp.preflight`: the API's start-up configuration checks, and nothing else.

deploy/server/update.sh runs this in the freshly built image, with the real env file, before it swaps the
running container. A configuration the new code cannot start from (a missing setting such as
`PLANNER_PROVIDER`, an unknown planner provider, an unpriced planner model) then fails the deploy while the
old API keeps running, instead of leaving a new one restart-looping. It touches no database and makes no
network call.

`create_app`'s start-up calls `check_config` too, so the deploy checks exactly what start-up checks. The
preflight is stricter in one way: a planner with no model key fails it. The API itself still starts without
one (sign-in, credits and the agent list work and planning answers 502), but a deploy should not ship that
by accident.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from mergit_worker.config import ConfigError, describe_invalid_settings
from mergit_worker.meter import PriceTable
from mergit_worker.providers import check_model_id, load_providers, stale_settings

from .agents import Agent, load_agents
from .config import Settings
from .llm import LLM, build_planner_llm, planner_unavailable
from .spec import require_schemas


@dataclass(frozen=True)
class Checked:
    agents: list[Agent]
    prices: PriceTable
    stale: list[str]
    """Removed settings still set in the environment, to warn about (`providers.REMOVED_SETTINGS`)."""


def check_config(settings: Settings, environ: Mapping[str, str] | None = None) -> Checked:
    """The agents load, the schemas are present, every planner model a user may choose is priced, and no
    removed setting still steers the planner's key somewhere it should not go."""
    env = os.environ if environ is None else environ
    agents = load_agents(settings.agents_file, settings.agents_config)
    require_schemas()  # the plan checks and events are validated against spec/schemas
    prices = PriceTable.load(Path(settings.prices_file))
    for model in settings.model_choices:  # every planner model a user may choose must have a price
        prices.model_call_cost(model, 0, 0, 0)
    providers = load_providers(Path(settings.agents_config))
    planner = providers.get(settings.planner_provider)
    if planner is not None:  # an undefined provider is build_planner_llm's own clear error
        for model in settings.model_choices:
            check_model_id(planner, model)
    stale = stale_settings(providers, {settings.planner_provider}, env)
    return Checked(agents, prices, stale)


def planner_llm(settings: Settings, environ: Mapping[str, str] | None = None) -> LLM:
    """The planner's client. Raises `ConfigError` for a provider that `agents.toml` does not define."""
    return build_planner_llm(
        load_providers(Path(settings.agents_config)), settings.planner_provider, environ=environ
    )


def main() -> int:
    try:
        try:
            settings = Settings()  # pyright: ignore[reportCallIssue]  # fields come from the environment
        except ValidationError as exc:
            raise ConfigError(describe_invalid_settings(exc)) from None
        checked = check_config(settings)
        if planner_unavailable(planner_llm(settings)):
            raise ConfigError(f"the planner's provider {settings.planner_provider!r} has no model key")
    except (ConfigError, ValueError, OSError) as exc:
        print(f"api preflight failed: {' '.join(str(exc).split())}", file=sys.stderr)
        return 1
    if checked.stale:
        print(f"api preflight warning: no longer read, remove from the env file: {', '.join(checked.stale)}")
    print(f"api preflight ok: planner {settings.planner_provider} / {settings.planner_model}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
