"""The provider each agent and the planner use, configured once in `agents.toml` (or, for the planner, in
`Settings.planner_provider`)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mergit_worker.agents import load_agent_spec, validate_agents_are_priced
from mergit_worker.config import ConfigError
from mergit_worker.meter import PriceTable
from mergit_worker.providers import ProviderSpec, load_providers, provider_key
from tests.support import KEY, KEY_ADDRESS

ROOT = Path(__file__).resolve().parents[1]


def test_provider_key_falls_back_to_anthropics_own_env_vars_when_no_api_key_env_is_named():
    # A provider with no `api_key_env` (the common single-Anthropic-provider deploy) lets the credential
    # come from whichever of ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is set, exactly as the SDK itself would
    # read it; a gateway such as Claude Lend hands out ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL) instead
    # of a real key, and it must still be picked up.
    spec = ProviderSpec(name="anthropic", kind="anthropic", base_url=None, api_key_env=None)
    assert provider_key(spec, {"ANTHROPIC_AUTH_TOKEN": "t"}) == "t"
    assert provider_key(spec, {"ANTHROPIC_API_KEY": "a", "ANTHROPIC_AUTH_TOKEN": "t"}) == "a"
    assert provider_key(spec, {}) is None


def test_provider_key_uses_the_named_env_var_when_one_is_given():
    spec = ProviderSpec(
        name="openrouter",
        kind="openai_chat",
        base_url="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
    )
    assert provider_key(spec, {"OPENROUTER_API_KEY": "k", "ANTHROPIC_API_KEY": "a"}) == "k"
    assert provider_key(spec, {}) is None


def test_the_repo_price_table_prices_the_groq_models_from_groqs_published_prices():
    table = PriceTable.load(ROOT / "prices.toml")
    # $0.15 in + $0.60 out per Mtok, openai/gpt-oss-120b (console.groq.com/docs/models, 2026-10-30)
    assert table.model_call_cost("openai/gpt-oss-120b", 1_000_000, 1_000_000, 5).usd_micros == 750_000
    assert table.model_call_cost("openai/gpt-oss-20b", 1_000_000, 1_000_000, 5).usd_micros == 375_000
    # cached input costs 50% less (console.groq.com/docs/prompt-caching)
    cached = table.model_call_cost("openai/gpt-oss-120b", 0, 0, 5, cache_read_tokens=1_000_000)
    assert cached.usd_micros == 75_000


def test_loads_openai_chat_and_anthropic_providers(tmp_path: Path):
    config = tmp_path / "agents.toml"
    config.write_text(
        "[providers.openrouter]\n"
        'kind = "openai_chat"\n'
        'base_url = "https://openrouter.ai/api/v1"\n'
        'api_key_env = "OPENROUTER_API_KEY"\n'
        "\n"
        "[providers.anthropic]\n"
        'kind = "anthropic"\n'
    )
    assert load_providers(config) == {
        "openrouter": ProviderSpec(
            name="openrouter",
            kind="openai_chat",
            base_url="https://openrouter.ai/api/v1",
            api_key_env="OPENROUTER_API_KEY",
        ),
        "anthropic": ProviderSpec(name="anthropic", kind="anthropic", base_url=None, api_key_env=None),
    }


def test_openai_chat_requires_base_url_and_key_env(tmp_path: Path):
    config = tmp_path / "agents.toml"
    config.write_text('[providers.openrouter]\nkind = "openai_chat"\napi_key_env = "OPENROUTER_API_KEY"\n')
    with pytest.raises(ConfigError, match="openrouter"):
        load_providers(config)
    config.write_text(
        '[providers.openrouter]\nkind = "openai_chat"\nbase_url = "https://openrouter.ai/api/v1"\n'
    )
    with pytest.raises(ConfigError, match="openrouter"):
        load_providers(config)


def test_unknown_kind_is_refused(tmp_path: Path):
    config = tmp_path / "agents.toml"
    config.write_text('[providers.aws]\nkind = "bedrock"\n')
    with pytest.raises(ConfigError, match="bedrock"):
        load_providers(config)


def test_a_malformed_provider_entry_is_a_clear_config_error_not_a_bare_attribute_error(tmp_path: Path):
    """`openrouter = "not-a-table"` under `[providers]` is valid TOML but not a provider table; this must
    raise `ConfigError` naming the malformed provider, not a raw `AttributeError` from calling `.get` on a
    plain string."""
    config = tmp_path / "agents.toml"
    config.write_text('[providers]\nopenrouter = "not-a-table"\n')
    with pytest.raises(ConfigError, match="openrouter"):
        load_providers(config)


def _agent_files(tmp_path: Path) -> tuple[Path, Path]:
    chain = tmp_path / "agents.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": "1",
                        "name": "coder",
                        "operator": "0x" + "1" * 40,
                        "runtime_key": KEY_ADDRESS,
                    }
                ]
            }
        )
    )
    config = tmp_path / "agents.toml"
    config.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.coder]\nprovider = "anthropic"\nmodel = "claude-sonnet-5"\nsystem_prompt = "p"\n'
    )
    return chain, config


def test_model_is_never_swapped(tmp_path: Path):
    chain, config = _agent_files(tmp_path)
    env = {"GROQ_API_KEY": "g", "MERGIT_AGENT_KEY_1": KEY}
    assert load_agent_spec("1", chain, config, env).model == "claude-sonnet-5"


def test_start_up_price_check_uses_the_configured_model(tmp_path: Path):
    chain, config = _agent_files(tmp_path)
    priced = tmp_path / "p.toml"
    priced.write_text('[models."claude-sonnet-5"]\ninput_per_mtok = 1\noutput_per_mtok = 1\n')
    validate_agents_are_priced(chain, config, PriceTable.load(priced))
    with pytest.raises(ConfigError, match="no price"):
        validate_agents_are_priced(chain, config, PriceTable({}))
