"""The agents v0 offers: chain identity from the deployment, model and prompt from local config."""

import json
import tomllib
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from mergit_worker.providers import load_providers

_ADDRESS = r"^0x[0-9a-fA-F]{40}$"


@dataclass(frozen=True)
class Agent:
    agent_id: str
    name: str
    operator: str
    runtime_key: str
    provider: str
    model: str
    system_prompt: str


class _ChainAgent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    agent_id: str = Field(pattern=r"^(0|[1-9][0-9]*)$")
    name: str = Field(min_length=1)
    operator: str = Field(pattern=_ADDRESS)
    runtime_key: str = Field(pattern=_ADDRESS)


class _Deployment(BaseModel):
    agents: list[_ChainAgent]


class _ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    system_prompt: str = Field(min_length=1)


def load_agents(path: str, config_path: str = "agents.toml") -> list[Agent]:
    """Join the deployed agents (``agents.json``) with their model config (``[agents.<name>]`` in
    ``agents.toml``, the same file the worker reads).

    Raises ValueError when an agent has no config, names a provider ``agents.toml`` does not define, or
    an id appears twice, so a bad deploy fails at start.
    """
    deployed = _Deployment.model_validate(json.loads(Path(path).read_text())).agents
    tables = tomllib.loads(Path(config_path).read_text()).get("agents")
    if not isinstance(tables, dict):
        raise ValueError(f"{config_path} has no [agents.<name>] tables")
    configs = {
        str(name): _ModelConfig.model_validate(table)  # pyright: ignore[reportUnknownArgumentType]
        for name, table in tables.items()  # pyright: ignore[reportUnknownVariableType]
    }
    providers = load_providers(Path(config_path))
    seen: set[str] = set()
    agents: list[Agent] = []
    for chain_agent in deployed:
        if chain_agent.agent_id in seen:
            raise ValueError(f"duplicate agent_id {chain_agent.agent_id} in {path}")
        seen.add(chain_agent.agent_id)
        config = configs.get(chain_agent.name)
        if config is None:
            raise ValueError(f"agent {chain_agent.name!r} has no entry in {config_path}")
        if config.provider not in providers:
            raise ValueError(
                f"agent {chain_agent.name!r} names provider {config.provider!r}, which has no "
                f"[providers.{config.provider}] table in {config_path}"
            )
        agents.append(
            Agent(
                agent_id=chain_agent.agent_id,
                name=chain_agent.name,
                operator=chain_agent.operator.lower(),
                runtime_key=chain_agent.runtime_key.lower(),
                provider=config.provider,
                model=config.model,
                system_prompt=config.system_prompt,
            )
        )
    return agents
