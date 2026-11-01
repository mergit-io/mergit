"""Which model provider runs, decided once at start-up from the environment, and the provider each agent
uses, configured once in `agents.toml`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mergit_worker.agents import load_agent_spec, validate_agents_are_priced
from mergit_worker.config import ConfigError
from mergit_worker.meter import PriceTable
from mergit_worker.providers import ProviderSpec, llm_provider, load_providers, require_provider
from tests.support import KEY, KEY_ADDRESS

ROOT = Path(__file__).resolve().parents[1]


def test_anthropic_is_the_provider_whenever_its_key_is_set():
    assert llm_provider({"ANTHROPIC_API_KEY": "a", "GROQ_API_KEY": "g"}) == "anthropic"


def test_an_anthropic_auth_token_counts_as_the_anthropic_credential():
    # A gateway such as Claude Lend takes ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL) instead of a real key.
    # It must win over a Groq key left in the same file, or the deploy would silently keep using Groq.
    assert llm_provider({"ANTHROPIC_AUTH_TOKEN": "t", "GROQ_API_KEY": "g"}) == "anthropic"
    assert require_provider({"ANTHROPIC_AUTH_TOKEN": "t"}) == "anthropic"
    assert require_provider({"ANTHROPIC_AUTH_TOKEN": "t", "GROQ_API_KEY": "g"}) == "anthropic"
    # A blank value is not a credential.
    assert llm_provider({"ANTHROPIC_AUTH_TOKEN": "", "GROQ_API_KEY": "g"}) == "groq"
    with pytest.raises(ConfigError, match="ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"):
        require_provider({"LLM_PROVIDER": "anthropic", "ANTHROPIC_AUTH_TOKEN": ""})


def test_groq_is_the_fallback_when_only_its_key_is_set():
    assert llm_provider({"GROQ_API_KEY": "g"}) == "groq"


def test_with_no_keys_the_default_is_anthropic_so_nothing_changes_for_tests_or_a_keyed_deploy():
    assert llm_provider({}) == "anthropic"


def test_an_explicit_choice_wins_over_the_keys_present():
    assert llm_provider({"LLM_PROVIDER": "groq", "ANTHROPIC_API_KEY": "a", "GROQ_API_KEY": "g"}) == "groq"
    assert llm_provider({"LLM_PROVIDER": "anthropic", "GROQ_API_KEY": "g"}) == "anthropic"


def test_an_unknown_provider_name_is_an_error():
    with pytest.raises(ConfigError, match="LLM_PROVIDER"):
        llm_provider({"LLM_PROVIDER": "openia"})


def test_require_provider_refuses_to_start_without_the_key_it_needs():
    with pytest.raises(ConfigError, match="ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or GROQ_API_KEY"):
        require_provider({})
    with pytest.raises(ConfigError, match="GROQ_API_KEY"):
        require_provider({"LLM_PROVIDER": "groq", "ANTHROPIC_API_KEY": "a"})
    assert require_provider({"GROQ_API_KEY": "g"}) == "groq"


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
