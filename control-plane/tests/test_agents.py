from pathlib import Path

import pytest

from mergit_cp.agents import Agent, load_agents
from mergit_worker.agents import load_agent_spec
from mergit_worker.config import ConfigError
from tests.support import KEY


def test_load_agents_joins_chain_ids_with_model_config(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    assert load_agents(str(chain), str(config)) == [
        Agent(
            agent_id="1",
            name="coder-a",
            operator="0x1111111111111111111111111111111111111111",
            runtime_key="0x2222222222222222222222222222222222222222",
            provider="anthropic",
            model="claude-sonnet-5",
            system_prompt="You fix failing tests.",
        )
    ]


def test_agent_without_model_config_fails_loudly(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    config.write_text('[agents.someone-else]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n')
    with pytest.raises(ValueError, match="coder-a"):
        load_agents(str(chain), str(config))


def test_agent_naming_missing_provider_is_refused(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.coder-a]\nprovider = "nope"\nmodel = "claude-sonnet-5"\nsystem_prompt = "p"\n'
    )
    with pytest.raises(ValueError, match="coder-a") as exc:
        load_agents(str(chain), str(config))
    assert "nope" in str(exc.value)

    env = {"MERGIT_AGENT_KEY_1": KEY}
    with pytest.raises(ConfigError, match="coder-a") as cexc:
        load_agent_spec("1", chain, config, env)
    assert "nope" in str(cexc.value)


def test_rejects_non_decimal_agent_id(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    chain.write_text(chain.read_text().replace('"agent_id": "1"', '"agent_id": "0x1"'))
    with pytest.raises(ValueError):
        load_agents(str(chain), str(config))


def test_rejects_duplicate_agent_id(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    one = chain.read_text()
    entry = one[one.index("[") + 1 : one.rindex("]")]
    chain.write_text('{"agents": [' + entry + "," + entry + "]}")
    with pytest.raises(ValueError, match="duplicate"):
        load_agents(str(chain), str(config))


def test_shipped_config_covers_the_deploy_example_agents() -> None:
    root = Path(__file__).resolve().parents[1]
    agents = load_agents(str(root.parent / "deploy" / "agents.example.json"), str(root / "agents.toml"))
    assert [a.agent_id for a in agents] == ["1", "2"]
    assert all(a.model and a.system_prompt for a in agents)


def test_flat_tables_are_rejected(agents_files: tuple[Path, Path]) -> None:
    chain, config = agents_files
    config.write_text('[coder-a]\nmodel = "m"\nsystem_prompt = "p"\n')
    with pytest.raises(ValueError, match="agents"):
        load_agents(str(chain), str(config))


def test_the_testnet_agent_is_named_in_agents_toml():
    """`SeedAgents` in mergit-contracts registers the testnet agent as `mergit-coder-0`; the API and the
    worker both refuse to start for a deployed agent that `agents.toml` does not name."""
    import tomllib
    from pathlib import Path

    from mergit_worker.meter import PriceTable

    root = Path(__file__).resolve().parents[1]
    entry = tomllib.loads((root / "agents.toml").read_text())["agents"]["mergit-coder-0"]
    assert entry["system_prompt"].strip()
    PriceTable.load(root / "prices.toml").price(entry["model"])  # priced, or the worker refuses to start
