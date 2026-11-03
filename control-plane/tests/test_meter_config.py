from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

from mergit_worker.agents import load_agent_spec
from mergit_worker.config import ConfigError, agent_signing_key
from mergit_worker.meter import Cost, PriceTable
from mergit_worker.models import OUTPUT_CAP_BYTES, TRUNCATION_MARKER, cap_output
from tests.support import KEY, KEY_ADDRESS

ROOT = Path(__file__).resolve().parents[1]


def test_repo_price_table_loads_and_prices_a_call():
    table = PriceTable.load(ROOT / "prices.toml")
    cost = table.model_call_cost("claude-sonnet-5", 1_000_000, 1_000_000, 5)
    assert cost.usd_micros == 12_000_000  # $2 in + $10 out per Mtok


def test_cost_rounds_half_up_to_micro_usd(tmp_path: Path):
    p = tmp_path / "p.toml"
    p.write_text('[models."m"]\ninput_per_mtok = 0.5\noutput_per_mtok = 0.5\n')
    assert PriceTable.load(p).model_call_cost("m", 1, 0, 0).usd_micros == 1  # 0.5 rounds up
    assert PriceTable.load(p).model_call_cost("m", 0, 0, 0).usd_micros == 0


def test_unpriced_model_is_an_error_not_a_guess():
    with pytest.raises(ConfigError, match="no price"):
        PriceTable({}).model_call_cost("mystery", 1, 1, 1)


def test_bad_price_file(tmp_path: Path):
    with pytest.raises(ConfigError):
        PriceTable.load(tmp_path / "missing.toml")


def test_cost_json_has_the_spec_fields():
    assert set(json.loads(Cost().to_json())) == {
        "model",
        "input_tokens",
        "output_tokens",
        "tool_calls",
        "wall_ms",
        "usd_micros",
    }


def test_cap_output_boundaries():
    assert cap_output(b"a" * OUTPUT_CAP_BYTES) == b"a" * OUTPUT_CAP_BYTES  # exactly at the cap: untouched
    over = cap_output(b"a" * (OUTPUT_CAP_BYTES + 1))
    assert over == b"a" * OUTPUT_CAP_BYTES + TRUNCATION_MARKER
    assert TRUNCATION_MARKER == b"\n[mergit: output truncated at 1048576 bytes]\n"


def test_agent_key_comes_from_the_environment_only():
    assert agent_signing_key("1", {"MERGIT_AGENT_KEY_1": KEY}).get_secret_value() == KEY


@pytest.mark.parametrize("value", ["", "0x1234", "ac09" * 16, "0x" + "g" * 64])
def test_agent_key_rejected_when_unset_or_malformed(value: str):
    with pytest.raises(ConfigError, match="MERGIT_AGENT_KEY_1"):
        agent_signing_key("1", {"MERGIT_AGENT_KEY_1": value})


def test_secret_never_appears_in_repr():
    assert KEY not in repr(agent_signing_key("1", {"MERGIT_AGENT_KEY_1": KEY}))


def test_load_agent_spec_joins_chain_identity_with_model_config(tmp_path: Path):
    agents = tmp_path / "agents.json"
    agents.write_text(json.dumps({"agents": [{"agent_id": "1", "name": "w", "runtime_key": KEY_ADDRESS}]}))
    cfg = tmp_path / "agents.toml"
    cfg.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.w]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n'
    )
    spec = load_agent_spec("1", agents, cfg, {"MERGIT_AGENT_KEY_1": KEY})
    assert (spec.model, spec.system_prompt, spec.runtime_key_address) == ("m", "p", KEY_ADDRESS)


def test_load_agent_spec_errors(tmp_path: Path):
    agents = tmp_path / "agents.json"
    agents.write_text(json.dumps({"agents": [{"agent_id": "1", "name": "w", "runtime_key": "bad"}]}))
    cfg = tmp_path / "agents.toml"
    cfg.write_text(
        '[providers.anthropic]\nkind = "anthropic"\n\n'
        '[agents.w]\nprovider = "anthropic"\nmodel = "m"\nsystem_prompt = "p"\n'
    )
    env = {"MERGIT_AGENT_KEY_1": KEY, "MERGIT_AGENT_KEY_2": KEY}
    with pytest.raises(ConfigError, match="runtime_key"):
        load_agent_spec("1", agents, cfg, env)
    with pytest.raises(ConfigError, match="not in"):
        load_agent_spec("9", agents, cfg, env)
    agents.write_text(json.dumps({"agents": [{"agent_id": "1", "name": "x", "runtime_key": KEY_ADDRESS}]}))
    with pytest.raises(ConfigError, match="model and system_prompt"):
        load_agent_spec("1", agents, cfg, env)
    agents.write_text(json.dumps({"agents": [{"agent_id": "1", "name": "w", "runtime_key": KEY_ADDRESS}]}))
    with pytest.raises(ConfigError, match="MERGIT_AGENT_KEY_1"):
        load_agent_spec("1", agents, cfg, {})


def test_shipped_agents_toml_covers_the_example_agents():
    registry = json.loads((ROOT.parent / "deploy" / "agents.example.json").read_text())["agents"]
    toml = (ROOT / "agents.toml").read_text()
    assert all(f"[agents.{a['name']}]" in toml for a in registry)


def test_shipped_agents_are_priced():
    """Every model named in the repo's own `agents.toml` must be in the repo's own `prices.toml`, or the
    worker refuses to start (`validate_agents_are_priced`)."""
    prices = PriceTable.load(ROOT / "prices.toml")
    agents = tomllib.loads((ROOT / "agents.toml").read_text())["agents"]
    for cfg in agents.values():
        prices.price(cfg["model"])


BASE_ENV = {
    "DATABASE_URL": "postgres://u:p@h/db",
    "GATEWAY_URL": "http://gateway:8082/",
    "STORE_URL": "http://store:8081",
    "EVENTS_TOKEN": "e",
    "STORE_WRITE_TOKEN": "s",
    "RECEIPT_REGISTRY": "0x0000000000000000000000000000000000000001",
    "AGENTS_FILE": "agents.json",
}


def test_config_loads_from_env_with_spec_defaults(monkeypatch: pytest.MonkeyPatch):
    from mergit_worker.config import load_config

    for k, v in BASE_ENV.items():
        monkeypatch.setenv(k, v)
    cfg = load_config()
    assert cfg.gateway_url == "http://gateway:8082"  # trailing slash stripped
    assert (cfg.chain_id, cfg.max_steps, cfg.max_output_bytes) == (84532, 60, 1_048_576)
    assert cfg.sandbox_memory == "2g" and cfg.sandbox_nano_cpus == 2_000_000_000
    assert "p@h" not in repr(cfg)  # secrets are masked


@pytest.mark.parametrize(
    ("name", "value"),
    [("RECEIPT_REGISTRY", "0x12"), ("GATEWAY_URL", "ftp://x"), ("MAX_STEPS", "0"), ("DATABASE_URL", None)],
)
def test_config_rejects_bad_values(monkeypatch: pytest.MonkeyPatch, name: str, value: str | None):
    from mergit_worker.config import load_config

    for k, v in BASE_ENV.items():
        monkeypatch.setenv(k, v)
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError):
        load_config()


def test_cached_tokens_are_priced_at_cache_rates():
    table = PriceTable.load(ROOT / "prices.toml")
    cost = table.model_call_cost(
        "claude-opus-5", 0, 0, 0, cache_read_tokens=1_000_000, cache_write_tokens=1_000_000
    )
    assert cost.usd_micros == 6_750_000  # $0.50 read + $6.25 write per Mtok


def test_cached_tokens_without_a_cache_price_are_an_error(tmp_path: Path):
    p = tmp_path / "p.toml"
    p.write_text('[models."m"]\ninput_per_mtok = 1\noutput_per_mtok = 1\n')
    with pytest.raises(ConfigError, match="cache_read_per_mtok"):
        PriceTable.load(p).model_call_cost("m", 1, 1, 0, cache_read_tokens=5)
    assert PriceTable.load(p).model_call_cost("m", 1, 1, 0).usd_micros == 2  # $1/Mtok = 1 micro-USD/token


def test_every_priced_model_has_cache_prices():
    for line in (ROOT / "prices.toml").read_text().split("[models.")[1:]:
        assert "cache_read_per_mtok" in line and "cache_write_per_mtok" in line, line.splitlines()[0]
