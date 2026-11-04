"""The provider each agent and the planner use, configured once in `agents.toml` (or, for the planner, in
`Settings.planner_provider`)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mergit_worker.agents import (
    load_agent_spec,
    validate_agents_are_priced,
    validate_agents_have_keys,
)
from mergit_worker.config import ConfigError
from mergit_worker.meter import PriceTable
from mergit_worker.providers import ProviderSpec, check_model_id, load_providers, provider_key, stale_settings
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


def _openai_chat(tmp_path: Path, base_url: object, api_key_env: object = "OPENROUTER_API_KEY") -> Path:
    def toml(v: object) -> str:
        return f'"{v}"' if isinstance(v, str) else str(v).lower()

    config = tmp_path / "agents.toml"
    config.write_text(
        '[providers.p]\nkind = "openai_chat"\n'
        f"base_url = {toml(base_url)}\napi_key_env = {toml(api_key_env)}\n"
    )
    return config


def test_the_repo_agents_toml_passes_its_own_checks():
    assert set(load_providers(ROOT / "agents.toml")) >= {"anthropic", "groq", "openrouter"}


@pytest.mark.parametrize(
    "base_url",
    ["https://openrouter.ai/api/v1", "https://api.groq.com/openai/v1", "http://keyrelay:8787/v1"],
)
def test_a_known_provider_endpoint_is_accepted(tmp_path: Path, base_url: str):
    assert load_providers(_openai_chat(tmp_path, base_url))["p"].base_url == base_url


@pytest.mark.parametrize(
    "base_url",
    [
        "https://attacker.example/v1",  # any host: the key goes out as a Bearer token
        "https://openrouter.ai.attacker.example/v1",  # a suffix is not the host
        "https://attacker.example@openrouter.ai/v1",  # credentials in the URL
        "http://openrouter.ai/api/v1",  # cleartext to a real provider
        "https://openrouter.ai:8443/api/v1",  # a non-default port
        "http://keyrelay:9999/v1",  # keyrelay on another port
        "https://keyrelay:8787/v1",  # keyrelay is http inside compose, not https
        "file:///etc/passwd",
        "openrouter.ai/api/v1",  # no scheme
    ],
)
def test_a_base_url_outside_the_allowlist_is_refused(tmp_path: Path, base_url: str):
    """`OpenAIChatLLM` sends the provider key to `base_url` as a Bearer token, and `agents.toml` ships with
    every push to main, so an edit to it must not be able to point a key at an arbitrary host."""
    with pytest.raises(ConfigError, match="base_url"):
        load_providers(_openai_chat(tmp_path, base_url))


@pytest.mark.parametrize(
    "api_key_env",
    [
        "STORE_WRITE_TOKEN",
        "GITHUB_TOKEN",
        "WORKER_TOKEN",
        "SESSION_SECRET",
        "DATABASE_URL",
        "TREASURY_KEY",
        "MERGIT_AGENT_KEY_1",
        "MERGIT_EXTRA_API_KEY",  # the MERGIT_ namespace is never a model provider's key
        "openrouter_api_key",
        "API_KEY",
        "",
    ],
)
def test_api_key_env_must_name_a_model_provider_key_not_a_mergit_secret(tmp_path: Path, api_key_env: str):
    """Whatever `api_key_env` names is read from the worker's or the API's environment and sent to the
    provider, so it must not be able to name one of Mergit's own secrets."""
    with pytest.raises(ConfigError, match="api_key_env"):
        load_providers(_openai_chat(tmp_path, "https://openrouter.ai/api/v1", api_key_env))


def test_an_anthropic_provider_may_not_set_a_base_url_it_would_ignore(tmp_path: Path):
    config = tmp_path / "agents.toml"
    config.write_text('[providers.a]\nkind = "anthropic"\nbase_url = "https://attacker.example"\n')
    with pytest.raises(ConfigError, match="base_url"):
        load_providers(config)


def test_an_anthropic_provider_key_env_follows_the_same_rule(tmp_path: Path):
    config = tmp_path / "agents.toml"
    config.write_text('[providers.a]\nkind = "anthropic"\napi_key_env = "GITHUB_TOKEN"\n')
    with pytest.raises(ConfigError, match="api_key_env"):
        load_providers(config)
    config.write_text('[providers.a]\nkind = "anthropic"\napi_key_env = "SECOND_ANTHROPIC_API_KEY"\n')
    assert load_providers(config)["a"].api_key_env == "SECOND_ANTHROPIC_API_KEY"


@pytest.mark.parametrize("field", ["base_url", "api_key_env"])
def test_a_non_string_field_is_a_config_error_not_an_attribute_error(tmp_path: Path, field: str):
    values: dict[str, object] = {
        "base_url": "https://openrouter.ai/api/v1",
        "api_key_env": "OPENROUTER_API_KEY",
    }
    values[field] = 42
    with pytest.raises(ConfigError, match=field):
        load_providers(_openai_chat(tmp_path, values["base_url"], values["api_key_env"]))


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


GROQ = ProviderSpec("groq", "openai_chat", "https://api.groq.com/openai/v1", "GROQ_API_KEY")


def test_removed_settings_still_set_are_named_for_a_warning():
    env = {"GROQ_MODEL": "x", "LLM_PROVIDER": "groq", "GROQ_API_KEY": "k"}
    assert stale_settings({"groq": GROQ}, {"groq"}, env) == ["GROQ_MODEL", "LLM_PROVIDER"]
    assert stale_settings({"groq": GROQ}, {"groq"}, {}) == []


def test_a_keyrelay_env_file_cannot_send_its_proxy_token_to_groq_itself():
    """An env file written for keyrelay holds its proxy token in GROQ_API_KEY and keyrelay's address in
    GROQ_BASE_URL. That variable is ignored now, so a provider in use would send the token to agents.toml's
    endpoint instead: refused, not warned about."""
    env = {"GROQ_BASE_URL": "http://keyrelay:8787/v1", "GROQ_API_KEY": "proxy-token"}
    with pytest.raises(ConfigError, match="GROQ_BASE_URL"):
        stale_settings({"groq": GROQ}, {"groq"}, env)


def test_a_stale_groq_base_url_only_warns_when_no_provider_in_use_reads_groq_api_key():
    env = {"GROQ_BASE_URL": "http://keyrelay:8787/v1"}
    assert stale_settings({"groq": GROQ}, {"anthropic"}, env) == ["GROQ_BASE_URL"]


def test_a_stale_groq_base_url_that_agrees_with_agents_toml_only_warns():
    relay = ProviderSpec("groq", "openai_chat", "http://keyrelay:8787/v1", "GROQ_API_KEY")
    env = {"GROQ_BASE_URL": "http://keyrelay:8787/v1/"}
    assert stale_settings({"groq": relay}, {"groq"}, env) == ["GROQ_BASE_URL"]


def _deploy(tmp_path: Path, registry: object, toml: str) -> tuple[Path, Path]:
    chain = tmp_path / "agents.json"
    chain.write_text(json.dumps({"agents": registry}))
    config = tmp_path / "agents.toml"
    config.write_text(toml)
    return chain, config


_GOOD_ENTRY = {"agent_id": "1", "name": "coder", "operator": "0x" + "1" * 40, "runtime_key": KEY_ADDRESS}


def _every_reader(chain: Path, config: Path) -> list[object]:
    from mergit_cp.llm_check import _agent_pairs_in_use  # pyright: ignore[reportPrivateUsage]

    return [
        lambda: validate_agents_have_keys(chain, config),
        lambda: validate_agents_are_priced(chain, config, PriceTable.load(ROOT / "prices.toml")),
        lambda: load_agent_spec("1", chain, config, {"MERGIT_AGENT_KEY_1": KEY}),
        lambda: _agent_pairs_in_use(chain, config),
    ]


@pytest.mark.parametrize("index", range(4))
def test_an_agent_entry_that_is_not_a_table_is_a_config_error_for_every_reader(tmp_path: Path, index: int):
    """`coder = "claude"` under [agents] is valid TOML. Every reader of the deploy used to call `.get` on
    it and crash with AttributeError; they now share one reader that names the bad entry."""
    chain, config = _deploy(tmp_path, [_GOOD_ENTRY], '[agents]\ncoder = "claude"\n')
    with pytest.raises(ConfigError, match="coder"):
        _every_reader(chain, config)[index]()  # type: ignore[operator]


@pytest.mark.parametrize("index", range(4))
def test_a_registry_entry_that_is_not_an_object_is_a_config_error_for_every_reader(
    tmp_path: Path, index: int
):
    chain, config = _deploy(tmp_path, ["coder"], '[agents.coder]\nprovider = "anthropic"\n')
    with pytest.raises(ConfigError, match="object"):
        _every_reader(chain, config)[index]()  # type: ignore[operator]


OPENROUTER = ProviderSpec("openrouter", "openai_chat", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY")
ANTHROPIC = ProviderSpec("anthropic", "anthropic", None, None)


@pytest.mark.parametrize(
    ("spec", "model"),
    [
        (OPENROUTER, "anthropic/claude-haiku-4.5"),
        (OPENROUTER, "deepseek/deepseek-v4-flash"),
        (ANTHROPIC, "claude-haiku-4-5"),
        (GROQ, "openai/gpt-oss-120b"),  # Groq ids may or may not have a slash: no rule
        (GROQ, "llama-3.3-70b-versatile"),
    ],
)
def test_a_model_id_the_provider_serves_passes(spec: ProviderSpec, model: str):
    check_model_id(spec, model)


@pytest.mark.parametrize(
    ("spec", "model"),
    [
        (OPENROUTER, "claude-haiku-4-5"),  # a native id left over after switching the planner to OpenRouter
        (ANTHROPIC, "anthropic/claude-haiku-4.5"),  # the other way round
    ],
)
def test_a_model_id_from_the_other_provider_is_refused(spec: ProviderSpec, model: str):
    """Both ids are priced and a key would be present, so nothing else at start-up catches this: every plan or
    job would fail at the provider instead."""
    with pytest.raises(ConfigError, match=model.replace(".", r"\.")):
        check_model_id(spec, model)
