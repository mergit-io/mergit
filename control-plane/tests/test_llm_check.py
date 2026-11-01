"""`python -m mergit_cp.llm_check` passes only when every provider in use answers a plain question and a
tool call, and never prints the credential."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr

from mergit_cp import llm_check
from mergit_cp.config import Settings
from mergit_cp.llm import LLMResult, LLMUnavailable


class Fake:
    def __init__(self, tool_works: bool = True, down: bool = False) -> None:
        self.tool_works, self.down = tool_works, down

    async def complete(self, messages: Any, tools: Any, model: str, **_: Any) -> LLMResult:
        if self.down:
            raise LLMUnavailable("HTTP 401: invalid token")
        calls = (
            [{"id": "1", "name": "report", "input": {"answer": "ready"}}] if tools and self.tool_works else []
        )
        return LLMResult("ready" if not tools else "", calls, 5, 3, model)


def _agent(name: str, provider: str, model: str) -> dict[str, str]:
    return {"name": name, "provider": provider, "model": model}


def _write_agents(
    tmp_path: Path, providers: dict[str, dict[str, str]], agents: list[dict[str, str]]
) -> tuple[Path, Path]:
    """A minimal `agents.json` + `agents.toml` pair, built directly for the test rather than touching the
    repo's real deploy files."""
    chain = tmp_path / f"agents-{len(agents)}-{len(providers)}.json"
    chain.write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "agent_id": str(i),
                        "name": a["name"],
                        "operator": "0x" + "1" * 40,
                        "runtime_key": "0x" + "2" * 40,
                    }
                    for i, a in enumerate(agents)
                ]
            }
        )
    )
    provider_tables = "\n\n".join(
        f"[providers.{name}]\n" + "\n".join(f'{k} = "{v}"' for k, v in table.items())
        for name, table in providers.items()
    )
    agent_tables = (
        "\n".join(
            f'[agents.{a["name"]}]\nprovider = "{a["provider"]}"\nmodel = "{a["model"]}"\n'
            'system_prompt = "p"\n'
            for a in agents
        )
        or "[agents]\n"  # an explicit empty table, so `models["agents"]` still resolves with no agents
    )
    config = tmp_path / f"agents-{len(agents)}-{len(providers)}.toml"
    config.write_text(f"{provider_tables}\n\n{agent_tables}")
    return chain, config


def _settings(
    agents_files: tuple[Path, Path], planner_provider: str, planner_model: str = "claude-haiku-4-5"
) -> Settings:
    chain, config = agents_files
    return Settings(
        database_url="postgresql://unused/db",  # never connected to: llm_check touches no database
        app_domain="app.mergit.test",
        session_secret=SecretStr("test-secret-at-least-32-bytes-long!!"),
        gateway_url="http://gateway.invalid",
        store_url="http://store.invalid",
        agents_file=str(chain),
        agents_config=str(config),
        planner_model=planner_model,
        planner_provider=planner_provider,
        events_token=SecretStr("test-events-token"),
        chain_events_token=SecretStr("test-chain-events-token"),
        worker_token=SecretStr("test-worker-token"),
    )


def test_it_passes_when_both_calls_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    agents_files = _write_agents(tmp_path, {"anthropic": {"kind": "anthropic"}}, [])
    settings = _settings(agents_files, "anthropic")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "super-secret-token")
    monkeypatch.setattr(llm_check, "build_planner_llm", lambda *a, **k: Fake())

    assert asyncio.run(llm_check.check(settings)) is True
    out = capsys.readouterr().out
    assert "provider=anthropic" in out and "tool call: ok" in out
    assert "super-secret-token" not in out


def test_it_fails_when_the_model_does_not_call_the_tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agents_files = _write_agents(tmp_path, {"anthropic": {"kind": "anthropic"}}, [])
    settings = _settings(agents_files, "anthropic")
    monkeypatch.setattr(llm_check, "build_planner_llm", lambda *a, **k: Fake(tool_works=False))

    assert asyncio.run(llm_check.check(settings)) is False


def test_it_fails_and_says_why_when_the_provider_refuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    agents_files = _write_agents(tmp_path, {"anthropic": {"kind": "anthropic"}}, [])
    settings = _settings(agents_files, "anthropic")
    monkeypatch.setattr(llm_check, "build_planner_llm", lambda *a, **k: Fake(down=True))

    assert asyncio.run(llm_check.check(settings)) is False
    assert "HTTP 401" in capsys.readouterr().out


def test_checks_each_provider_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """Two agents on the same provider produce one check line for it, plus one more for the planner's own
    (different) provider: three agents' worth of configuration, two distinct providers checked."""
    agents_files = _write_agents(
        tmp_path,
        {
            "anthropic": {"kind": "anthropic"},
            "openrouter": {
                "kind": "openai_chat",
                "base_url": "https://openrouter.ai/api/v1",
                "api_key_env": "OPENROUTER_API_KEY",
            },
        },
        [_agent("coder-a", "openrouter", "model-a"), _agent("coder-b", "openrouter", "model-b")],
    )
    settings = _settings(agents_files, "anthropic")

    calls: list[str] = []

    def fake_build(providers: Any, name: str, *a: Any, **k: Any) -> Fake:
        calls.append(name)
        return Fake()

    monkeypatch.setattr(llm_check, "build_planner_llm", fake_build)

    assert asyncio.run(llm_check.check(settings)) is True
    assert sorted(calls) == ["anthropic", "openrouter"]
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("provider=")]
    assert len(lines) == 2
    assert any(line.startswith("provider=anthropic") for line in lines)
    assert any(line.startswith("provider=openrouter") for line in lines)
