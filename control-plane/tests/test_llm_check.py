"""`python -m mergit_cp.llm_check` passes only when a plain answer and a tool call both work, and never prints
the credential."""

from typing import Any

import pytest

from mergit_cp import llm_check
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


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ANTHROPIC_API_KEY", "GROQ_API_KEY", "LLM_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "super-secret-token")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://lend.example/v1")


def test_it_passes_when_both_calls_work(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    monkeypatch.setattr(llm_check, "build_llm", lambda: Fake())
    assert llm_check.main(["claude-haiku-4-5"]) == 0
    out = capsys.readouterr().out
    assert "lend.example" in out and "tool call: ok" in out
    assert "super-secret-token" not in out


def test_it_fails_when_the_model_does_not_call_the_tool(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(llm_check, "build_llm", lambda: Fake(tool_works=False))
    assert llm_check.main(["m"]) == 1


def test_it_fails_and_says_why_when_the_provider_refuses(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    monkeypatch.setattr(llm_check, "build_llm", lambda: Fake(down=True))
    assert llm_check.main(["m"]) == 1
    out = capsys.readouterr().out
    assert "HTTP 401" in out and "super-secret-token" not in out
