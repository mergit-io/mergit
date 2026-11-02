"""The Anthropic adapter (against a stand-in for the SDK client, no network, no key), and the planner's own
provider choice (`build_planner_llm`): it names a provider from `[providers.<name>]`, exactly as an agent
does."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import psycopg
import pytest
import respx
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient
from siwe import SiweMessage

from mergit_cp.app import create_app
from mergit_cp.config import Settings
from mergit_cp.llm import AnthropicLLM, LLMError, LLMUnavailable, build_planner_llm
from mergit_worker.providers import ProviderSpec
from tests.conftest import APP_DOMAIN


class StubMessages:
    def __init__(self, response: Any) -> None:
        self.response = response
        self.kwargs: dict[str, Any] = {}

    async def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return self.response


def response(stop_reason: str = "end_turn", **usage: int) -> SimpleNamespace:
    counts = {
        "input_tokens": 120,
        "output_tokens": 40,
        "cache_read_input_tokens": None,
        "cache_creation_input_tokens": None,
    }
    return SimpleNamespace(
        model="claude-opus-5",
        stop_reason=stop_reason,
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text='{"tasks": []}'),
            SimpleNamespace(type="tool_use", id="tu_1", name="read_file", input={"path": "a.py"}),
        ],
        usage=SimpleNamespace(**(counts | usage)),
    )


def complete(stub: StubMessages, **kwargs: Any):
    llm = AnthropicLLM(SimpleNamespace(messages=stub), max_tokens=16000)  # pyright: ignore[reportArgumentType]
    return asyncio.run(llm.complete([{"role": "user", "content": "plan"}], None, "claude-opus-5", **kwargs))


def test_maps_text_tool_calls_and_usage() -> None:
    out = complete(StubMessages(response(cache_read_input_tokens=7)))
    assert out.text == '{"tasks": []}'
    assert out.tool_calls == [{"id": "tu_1", "name": "read_file", "input": {"path": "a.py"}}]
    assert (out.input_tokens, out.output_tokens, out.cache_read_tokens, out.cache_write_tokens) == (
        120,
        40,
        7,
        0,
    )


def test_sends_schema_as_structured_output_and_no_sampling_params() -> None:
    stub = StubMessages(response())
    complete(stub, system="be brief", output_schema={"type": "object"})
    assert stub.kwargs["output_config"] == {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    assert stub.kwargs["system"] == "be brief"
    assert not {"temperature", "top_p", "top_k"} & stub.kwargs.keys()


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_unusable_stop_raises_but_keeps_usage(stop_reason: str) -> None:
    with pytest.raises(LLMError) as err:
        complete(StubMessages(response(stop_reason)))
    assert err.value.reason == stop_reason
    assert err.value.usage.input_tokens == 120


def test_provider_error_becomes_llm_unavailable() -> None:
    import anthropic
    import httpx2

    class Down:
        async def create(self, **kwargs: Any) -> Any:
            raise anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com"))

    llm = AnthropicLLM(SimpleNamespace(messages=Down()))  # pyright: ignore[reportArgumentType]
    with pytest.raises(LLMUnavailable):
        asyncio.run(llm.complete([{"role": "user", "content": "x"}], None, "claude-opus-5"))


@respx.mock
def test_planner_uses_named_provider() -> None:
    """`build_planner_llm` sends to the provider's own `base_url`, with its own key, not Anthropic's or
    Groq's: an OpenRouter deploy sends to OpenRouter."""
    providers = {
        "openrouter": ProviderSpec(
            name="openrouter",
            kind="openai_chat",
            base_url="https://openrouter.ai/api/v1",
            api_key_env="OPENROUTER_API_KEY",
        )
    }
    route = respx.post("https://openrouter.ai/api/v1/chat/completions").respond(
        200,
        json={
            "model": "anthropic/claude-sonnet-5",
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2},
        },
    )
    llm = build_planner_llm(providers, "openrouter", environ={"OPENROUTER_API_KEY": "k"})
    asyncio.run(llm.complete([{"role": "user", "content": "x"}], None, "anthropic/claude-sonnet-5"))
    request = route.calls.last.request
    assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer k"


_PLAN_BODY = {
    "goal": "Fix the failing refund test",
    "repo_url": "https://github.com/mergit-io/demo-repo",
    "ref": "main",
    "budget_usdc_units": "2000000",
    "category": "test-repair",
}


def _sign_in(client: TestClient) -> None:
    account = Account.create()
    nonce = client.get("/v0/auth/nonce").json()["nonce"]
    message = SiweMessage.model_validate(
        {
            "domain": APP_DOMAIN,
            "address": account.address,
            "uri": f"https://{APP_DOMAIN}",
            "version": "1",
            "chain_id": 84532,
            "issued_at": "2026-10-28T10:00:00.000Z",
            "nonce": nonce,
        }
    ).prepare_message()
    signature = account.sign_message(encode_defunct(text=message)).signature.to_0x_hex()
    assert (
        client.post("/v0/auth/verify", json={"message": message, "signature": signature}).status_code == 200
    )


@pytest.mark.postgres
def test_missing_planner_key_answers_502(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no OPENROUTER_API_KEY in the environment, the API still starts — sign-in, credits and the agent
    list all work — exactly as it always has with no Anthropic key; only a planning request fails, with a
    clear 502, because `build_planner_llm` falls back to an always-unavailable client."""
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    config = tmp_path / "agents.toml"
    config.write_text(
        Path(settings.agents_config).read_text() + '\n[providers.openrouter]\nkind = "openai_chat"\n'
        'base_url = "https://openrouter.ai/api/v1"\napi_key_env = "OPENROUTER_API_KEY"\n'
    )
    missing_key = settings.model_copy(update={"planner_provider": "openrouter", "agents_config": str(config)})
    with TestClient(create_app(missing_key, deliver_events=False), base_url="https://testserver") as c:
        assert c.get("/v0/agents").status_code == 200
        _sign_in(c)
        assert c.post("/v0/plans", json=_PLAN_BODY).status_code == 502
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("TRUNCATE planning_attempts, sessions, auth_nonces")
