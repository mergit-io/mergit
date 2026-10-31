"""Which model provider runs, decided once at start-up, and the model swapped in before anything is priced."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mergit_worker.agents import load_agent_spec, validate_agents_are_priced
from mergit_worker.config import ConfigError
from mergit_worker.meter import PriceTable
from mergit_worker.providers import DEFAULT_GROQ_MODEL, effective_model, llm_provider, require_provider
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


def test_the_configured_model_is_kept_on_anthropic():
    assert effective_model("claude-sonnet-5", {"ANTHROPIC_API_KEY": "a"}) == "claude-sonnet-5"


def test_on_groq_every_model_becomes_the_groq_model_and_it_can_be_chosen():
    assert effective_model("claude-sonnet-5", {"GROQ_API_KEY": "g"}) == DEFAULT_GROQ_MODEL
    assert effective_model("claude-opus-5", {"GROQ_API_KEY": "g", "GROQ_MODEL": "openai/gpt-oss-20b"}) == (
        "openai/gpt-oss-20b"
    )


def test_the_repo_price_table_prices_the_groq_models_from_groqs_published_prices():
    table = PriceTable.load(ROOT / "prices.toml")
    # $0.15 in + $0.60 out per Mtok, openai/gpt-oss-120b (console.groq.com/docs/models, 2026-10-30)
    assert table.model_call_cost("openai/gpt-oss-120b", 1_000_000, 1_000_000, 5).usd_micros == 750_000
    assert table.model_call_cost("openai/gpt-oss-20b", 1_000_000, 1_000_000, 5).usd_micros == 375_000
    # cached input costs 50% less (console.groq.com/docs/prompt-caching)
    cached = table.model_call_cost("openai/gpt-oss-120b", 0, 0, 5, cache_read_tokens=1_000_000)
    assert cached.usd_micros == 75_000


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
    config.write_text('[agents.coder]\nmodel = "claude-sonnet-5"\nsystem_prompt = "p"\n')
    return chain, config


def test_the_agent_is_loaded_with_the_groq_model_so_the_receipt_prices_and_names_what_really_ran(
    tmp_path: Path,
):
    chain, config = _agent_files(tmp_path)
    env = {"GROQ_API_KEY": "g", "MERGIT_AGENT_KEY_1": KEY}
    assert load_agent_spec("1", chain, config, env).model == DEFAULT_GROQ_MODEL
    env_a = {"ANTHROPIC_API_KEY": "a", "MERGIT_AGENT_KEY_1": KEY}
    assert load_agent_spec("1", chain, config, env_a).model == "claude-sonnet-5"


def test_start_up_price_check_uses_the_model_that_will_run(tmp_path: Path):
    chain, config = _agent_files(tmp_path)
    only_groq = tmp_path / "p.toml"
    only_groq.write_text(f'[models."{DEFAULT_GROQ_MODEL}"]\ninput_per_mtok = 0.15\noutput_per_mtok = 0.6\n')
    table = PriceTable.load(only_groq)
    validate_agents_are_priced(chain, config, table, {"GROQ_API_KEY": "g"})
    with pytest.raises(ConfigError, match="no price"):
        validate_agents_are_priced(chain, config, table, {"ANTHROPIC_API_KEY": "a"})


def _only(monkeypatch: pytest.MonkeyPatch, **keys: str) -> None:
    for name in ("ANTHROPIC_API_KEY", "GROQ_API_KEY", "LLM_PROVIDER", "GROQ_MODEL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in keys.items():
        monkeypatch.setenv(name, value)


def test_the_api_lists_the_model_that_will_really_run(
    agents_files: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
):
    from mergit_cp.agents import load_agents

    chain, config = agents_files
    _only(monkeypatch, GROQ_API_KEY="g")
    assert load_agents(str(chain), str(config))[0].model == DEFAULT_GROQ_MODEL
    _only(monkeypatch, ANTHROPIC_API_KEY="a")
    assert load_agents(str(chain), str(config))[0].model == "claude-sonnet-5"


def test_the_planner_model_follows_the_provider(
    agents_files: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
):
    from pydantic import SecretStr

    from mergit_cp.config import Settings

    chain, config = agents_files

    def settings() -> Settings:
        return Settings(
            database_url="postgresql://x",
            app_domain="app.mergit.test",
            session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
            gateway_url="http://gateway.invalid",
            store_url="http://store.invalid",
            agents_file=str(chain),
            agents_config=str(config),
            planner_model="claude-opus-5",
            events_token=SecretStr("e"),
            chain_events_token=SecretStr("c"),
            worker_token=SecretStr("w"),
        )

    _only(monkeypatch, ANTHROPIC_API_KEY="a")
    assert settings().planner_model == "claude-opus-5"
    _only(monkeypatch, GROQ_API_KEY="g", GROQ_MODEL="openai/gpt-oss-20b")
    assert settings().planner_model == "openai/gpt-oss-20b"
