"""The worker's `OpenAIChatLLM` and the planner's async twin (any OpenAI-compatible chat API: Groq,
OpenRouter, ...), against the documented HTTP shape, faked with respx."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx

from mergit_cp import llm as cp_llm
from mergit_worker import llm as worker_llm
from mergit_worker.providers import ProviderSpec

BASE_URL = "https://api.groq.com/openai/v1"
URL = f"{BASE_URL}/chat/completions"
TOOLS = [{"name": "finish", "description": "done", "input_schema": {"type": "object", "properties": {}}}]


def reply(
    message: dict[str, Any], finish: str = "stop", usage: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "model": "openai/gpt-oss-120b",
        "choices": [{"message": {"role": "assistant", **message}, "finish_reason": finish}],
        "usage": usage or {"prompt_tokens": 12, "completion_tokens": 3},
    }


# -- worker (sync) ----------------------------------------------------------------------------


@respx.mock
def test_worker_sends_the_documented_request_and_returns_anthropic_shaped_blocks():
    route = respx.post(URL).respond(
        200,
        json=reply(
            {
                "content": "ok",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "finish", "arguments": "{}"}}
                ],
            },
            finish="tool_calls",
        ),
    )
    llm = worker_llm.OpenAIChatLLM("test-key", base_url=BASE_URL, sleep=lambda _s: None)
    result = llm.complete(
        [{"role": "user", "content": "go"}], TOOLS, "openai/gpt-oss-120b", system="sys", max_tokens=99
    )

    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer test-key"
    body = json.loads(request.content)
    assert body["model"] == "openai/gpt-oss-120b"
    assert body["max_completion_tokens"] == 99 and "max_tokens" not in body
    assert body["messages"][0] == {"role": "system", "content": "sys"}
    assert body["tools"][0]["function"]["name"] == "finish" and body["tool_choice"] == "auto"

    assert result.text == "ok" and result.stop_reason == "tool_use"
    assert [(c.id, c.name, c.input) for c in result.tool_calls] == [("c1", "finish", {})]
    assert result.assistant_content == [
        {"type": "text", "text": "ok"},
        {"type": "tool_use", "id": "c1", "name": "finish", "input": {}},
    ]
    assert (result.input_tokens, result.output_tokens, result.model) == (12, 3, "openai/gpt-oss-120b")


@respx.mock
def test_worker_counts_cached_prompt_tokens_in_full_so_a_receipt_never_understates_cost():
    respx.post(URL).respond(
        200,
        json=reply(
            {"content": "x"},
            usage={
                "prompt_tokens": 100,
                "completion_tokens": 1,
                "prompt_tokens_details": {"cached_tokens": 60},
            },
        ),
    )
    result = worker_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
        [{"role": "user", "content": "x"}], None, "m"
    )
    assert result.input_tokens == 100


@respx.mock
def test_worker_retries_rate_limits_then_succeeds():
    route = respx.post(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "1"}, json={}),
            httpx.Response(200, json=reply({"content": "hi"})),
        ]
    )
    waits: list[float] = []
    result = worker_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=waits.append).complete(
        [{"role": "user", "content": "x"}], None, "m"
    )
    assert result.text == "hi" and route.call_count == 2 and waits == [1.0]


@respx.mock
def test_worker_gives_up_after_three_attempts():
    route = respx.post(URL).respond(503, json={})
    with pytest.raises(worker_llm.LLMError, match="503"):
        worker_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
            [{"role": "user", "content": "x"}], None, "m"
        )
    assert route.call_count == 3


@respx.mock
def test_worker_does_not_retry_a_rejected_request_and_never_echoes_the_key():
    route = respx.post(URL).respond(400, json={"error": {"message": "bad field"}})
    with pytest.raises(worker_llm.LLMError) as caught:
        worker_llm.OpenAIChatLLM("secret-key-123", base_url=BASE_URL, sleep=lambda _s: None).complete(
            [{"role": "user", "content": "x"}], None, "m"
        )
    assert route.call_count == 1 and "secret-key-123" not in str(caught.value) and "400" in str(caught.value)


@respx.mock
def test_worker_turns_a_connection_failure_into_an_llm_error():
    respx.post(URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(worker_llm.LLMError):
        worker_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
            [{"role": "user", "content": "x"}], None, "m"
        )


@respx.mock
def test_error_object_in_200_is_llm_error():
    """Some OpenAI-compatible providers (OpenRouter among them) answer a routing failure with HTTP 200 and
    an `error` object in the body instead of a non-200 status; that must still surface as `LLMError`, with
    the provider's own message and never the key."""
    respx.post(URL).respond(200, json={"error": {"message": "No endpoints found", "code": 404}})
    with pytest.raises(worker_llm.LLMError) as caught:
        worker_llm.OpenAIChatLLM("secret-key-123", base_url=BASE_URL, sleep=lambda _s: None).complete(
            [{"role": "user", "content": "x"}], None, "m"
        )
    assert "No endpoints found" in str(caught.value)
    assert "secret-key-123" not in str(caught.value)


@respx.mock
def test_posts_to_configured_base_url():
    """`base_url` is a required constructor argument: this class is provider-agnostic, so a deploy pointed
    at OpenRouter (or any other OpenAI-compatible endpoint) sends its request there, not to Groq."""
    openrouter_url = "https://openrouter.ai/api/v1/chat/completions"
    route = respx.post(openrouter_url).respond(200, json=reply({"content": "ok"}))
    worker_llm.OpenAIChatLLM("k", base_url="https://openrouter.ai/api/v1", sleep=lambda _s: None).complete(
        [{"role": "user", "content": "x"}], None, "m"
    )
    request = route.calls.last.request
    assert str(request.url) == openrouter_url
    assert request.headers["authorization"] == "Bearer k"


# -- planner (async) ---------------------------------------------------------------------------


def run(coro: Any) -> Any:
    return asyncio.run(coro)


@respx.mock
def test_planner_asks_for_a_json_schema_answer_best_effort_and_splits_cached_tokens():
    route = respx.post(URL).respond(
        200,
        json=reply(
            {"content": '{"tasks": []}'},
            usage={
                "prompt_tokens": 100,
                "completion_tokens": 8,
                "prompt_tokens_details": {"cached_tokens": 40},
            },
        ),
    )
    schema = {"type": "object", "properties": {"tasks": {"type": "array"}}}
    result = run(
        cp_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
            [{"role": "user", "content": "plan"}],
            None,
            "openai/gpt-oss-120b",
            system="s",
            output_schema=schema,
        )
    )
    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "answer", "strict": False, "schema": schema},
    }
    assert result.text == '{"tasks": []}'
    # input is the uncached part and the cached part is priced separately at its own rate
    assert (
        result.input_tokens,
        result.cache_read_tokens,
        result.cache_write_tokens,
        result.output_tokens,
    ) == (
        60,
        40,
        0,
        8,
    )


@respx.mock
def test_planner_reports_an_outage_as_unavailable_so_the_api_answers_502():
    respx.post(URL).respond(500, json={})
    with pytest.raises(cp_llm.LLMUnavailable):
        run(
            cp_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
                [{"role": "user", "content": "x"}], None, "m"
            )
        )


@respx.mock
def test_planner_error_object_in_200_is_llm_unavailable():
    """Mirrors the worker's `test_error_object_in_200_is_llm_error`: some OpenAI-compatible providers
    (OpenRouter among them) answer a routing failure with HTTP 200 and an `error` object in the body instead
    of a non-200 status; that must still surface as `LLMUnavailable`, with the provider's own message and
    never the key."""
    respx.post(URL).respond(200, json={"error": {"message": "No endpoints found", "code": 404}})
    with pytest.raises(cp_llm.LLMUnavailable) as caught:
        run(
            cp_llm.OpenAIChatLLM("secret-key-123", base_url=BASE_URL, sleep=lambda _s: None).complete(
                [{"role": "user", "content": "x"}], None, "m"
            )
        )
    assert "No endpoints found" in str(caught.value)
    assert "secret-key-123" not in str(caught.value)


@respx.mock
def test_planner_reports_a_truncated_answer_as_an_error_that_still_carries_its_usage():
    respx.post(URL).respond(
        200,
        json=reply({"content": '{"ta'}, finish="length", usage={"prompt_tokens": 5, "completion_tokens": 9}),
    )
    with pytest.raises(cp_llm.LLMError) as caught:
        run(
            cp_llm.OpenAIChatLLM("k", base_url=BASE_URL, sleep=lambda _s: None).complete(
                [{"role": "user", "content": "x"}], None, "m"
            )
        )
    assert caught.value.reason == "max_tokens" and caught.value.usage.output_tokens == 9


_ANTHROPIC = {"anthropic": ProviderSpec(name="anthropic", kind="anthropic", base_url=None, api_key_env=None)}
_OPENROUTER = {
    "openrouter": ProviderSpec(
        name="openrouter", kind="openai_chat", base_url=BASE_URL, api_key_env="OPENROUTER_API_KEY"
    )
}


def test_the_planner_factory_picks_the_clients_kind_from_the_named_provider():
    assert isinstance(
        cp_llm.build_planner_llm(_OPENROUTER, "openrouter", environ={"OPENROUTER_API_KEY": "k"}),
        cp_llm.OpenAIChatLLM,
    )
    assert isinstance(
        cp_llm.build_planner_llm(_ANTHROPIC, "anthropic", environ={"ANTHROPIC_API_KEY": "a"}),
        cp_llm.AnthropicLLM,
    )


def test_the_api_still_starts_with_no_model_key_so_sign_in_and_credits_work():
    # The API still starts and `build_planner_llm` still returns a client; a planning request then fails
    # clearly with `LLMUnavailable`, which the API turns into a 502 (see tests/test_llm.py).
    llm = cp_llm.build_planner_llm(_ANTHROPIC, "anthropic", environ={})
    with pytest.raises(cp_llm.LLMUnavailable):
        run(llm.complete([{"role": "user", "content": "x"}], None, "m"))


def test_the_planner_accepts_a_gateway_token_without_warning(caplog: pytest.LogCaptureFixture):
    env = {"ANTHROPIC_AUTH_TOKEN": "lend-token", "ANTHROPIC_BASE_URL": "https://lend.example"}
    with caplog.at_level("WARNING", logger="mergit_cp.llm"):
        assert isinstance(cp_llm.build_planner_llm(_ANTHROPIC, "anthropic", environ=env), cp_llm.AnthropicLLM)
    assert "no model key" not in caplog.text


def test_an_unknown_planner_provider_is_a_clear_config_error_not_a_bare_key_error():
    """A misspelled `PLANNER_PROVIDER` on a real deployment must fail start-up with a message naming the
    bad value and the valid choices, not a bare `KeyError`."""
    from mergit_worker.config import ConfigError

    with pytest.raises(ConfigError) as caught:
        cp_llm.build_planner_llm(_ANTHROPIC, "antropic", environ={"ANTHROPIC_API_KEY": "a"})
    assert "antropic" in str(caught.value)
    assert "anthropic" in str(caught.value)
