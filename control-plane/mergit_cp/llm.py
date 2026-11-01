"""Model gateway: one small interface the planner calls, with an Anthropic adapter and an OpenAI-compatible
one.

Nothing outside this module imports a provider SDK, so adding a provider is one more class here. The planner
names its provider in `Settings.planner_provider`, exactly as an agent names its own in `agents.toml`
(`mergit_worker/providers.py`); `build_planner_llm` resolves that name to a client once at start-up.
Credentials come from the environment and never pass through a prompt.
"""

import asyncio
import inspect
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, cast

import httpx
from anthropic import APIError, AsyncAnthropic, omit
from anthropic.types import Message, MessageParam, ToolParam

from mergit_worker.llm import retry_wait
from mergit_worker.openai_chat import BadReply, parse_reply, to_openai_messages, to_openai_tools
from mergit_worker.providers import ProviderSpec, provider_key


@dataclass(frozen=True)
class LLMResult:
    text: str
    tool_calls: list[dict[str, Any]]
    input_tokens: int
    output_tokens: int
    model: str
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class LLMError(Exception):
    """The model answered but the answer is unusable. ``usage`` is still billed and must be recorded."""

    reason: str
    usage: LLMResult = field(repr=False)

    def __str__(self) -> str:
        return f"model stopped with {self.reason}"


class LLMUnavailable(Exception):
    """The provider could not be reached or answered with an error after the SDK's own retries."""


class LLM(Protocol):
    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> LLMResult: ...


_UNUSABLE = {"refusal", "max_tokens"}


class AnthropicLLM:
    def __init__(self, client: AsyncAnthropic | None = None, *, max_tokens: int = 16000) -> None:
        self._client = client or AsyncAnthropic()
        self._max_tokens = max_tokens

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> LLMResult:
        try:
            response = await self._create(messages, tools, model, system, output_schema)
        except APIError as exc:
            raise LLMUnavailable(f"{type(exc).__name__}: {exc}") from exc
        usage = response.usage
        result = LLMResult(
            text="".join(block.text for block in response.content if block.type == "text"),
            tool_calls=[
                {"id": block.id, "name": block.name, "input": block.input}
                for block in response.content
                if block.type == "tool_use"
            ],
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_input_tokens or 0,
            cache_write_tokens=usage.cache_creation_input_tokens or 0,
            model=response.model,
        )
        if response.stop_reason in _UNUSABLE:
            raise LLMError(str(response.stop_reason), result)
        return result

    async def _create(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        system: str | None,
        output_schema: dict[str, Any] | None,
    ) -> Message:
        return await self._client.messages.create(
            model=model,
            max_tokens=self._max_tokens,
            # Callers build plain dicts in the API's own shape; the SDK sends them unchanged.
            messages=cast(list[MessageParam], messages),
            system=system if system is not None else omit,
            tools=cast(list[ToolParam], tools) if tools else omit,
            output_config=(
                {"format": {"type": "json_schema", "schema": output_schema}}
                if output_schema is not None
                else omit
            ),
        )


log = logging.getLogger(__name__)
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_ATTEMPTS = 3


class OpenAIChatLLM:
    """Any OpenAI-compatible chat API (Groq, OpenRouter, ...), async for the planner (the worker's sync twin
    is `mergit_worker.llm.OpenAIChatLLM`). A structured answer is requested as best-effort JSON-schema output
    (`strict: false`, which every such provider accepts) because the planner validates every answer itself
    in `check_tasks`, exactly as it does for Anthropic. The key is only ever sent in the `Authorization`
    header: errors never include it."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 120.0,
        sleep: Callable[[float], Any] = asyncio.sleep,
        max_tokens: int = 16000,
    ) -> None:
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._http = client or httpx.AsyncClient(timeout=timeout_s)
        self._sleep = sleep
        self._max_tokens = max_tokens

    async def _wait(self, seconds: float) -> None:
        pending = self._sleep(seconds)
        if inspect.isawaitable(pending):
            await pending

    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(1, _ATTEMPTS + 1):
            try:
                response = await self._http.post(self._url, json=payload, headers=self._headers)
            except httpx.TransportError as exc:
                if attempt == _ATTEMPTS:
                    raise LLMUnavailable(f"{type(exc).__name__}") from exc
                await self._wait(float(attempt))
                continue
            if response.status_code == 200:
                try:
                    return cast("dict[str, Any]", response.json())
                except ValueError as exc:
                    raise LLMUnavailable("the answer is not JSON") from exc
            if response.status_code not in _RETRY_STATUSES or attempt == _ATTEMPTS:
                raise LLMUnavailable(f"HTTP {response.status_code}: {response.text[:200]}")
            await self._wait(retry_wait(response, attempt))
        raise AssertionError("unreachable")  # pragma: no cover

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> LLMResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(messages, system),
            "max_completion_tokens": self._max_tokens,
        }
        if tools:
            payload["tools"] = to_openai_tools(tools)
            payload["tool_choice"] = "auto"
        if output_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "answer", "strict": False, "schema": output_schema},
            }
        try:
            reply = parse_reply(await self._post(payload))
        except BadReply as exc:
            raise LLMUnavailable(str(exc)) from exc
        result = LLMResult(
            text=reply.text,
            tool_calls=[{"id": i, "name": n, "input": a} for i, n, a in reply.calls],
            # Groq's prompt_tokens includes the cached part, which is priced separately at its own rate.
            input_tokens=reply.prompt_tokens - reply.cached_tokens,
            output_tokens=reply.completion_tokens,
            cache_read_tokens=reply.cached_tokens,
            cache_write_tokens=0,
            model=reply.model or model,
        )
        if reply.stop_reason in _UNUSABLE:
            raise LLMError(str(reply.stop_reason), result)
        return result


class _UnavailableLLM:
    """Stands in for a provider with no key configured, so start-up never fails for it: a planning request
    then fails clearly with `LLMUnavailable`, which the API turns into a 502."""

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> LLMResult:
        raise LLMUnavailable("no model key is configured for the planner's provider")


def build_planner_llm(
    providers: dict[str, ProviderSpec],
    name: str,
    timeout_s: float = 120.0,
    environ: Mapping[str, str] | None = None,
) -> LLM:
    """The planner's model client for its configured provider, named in `Settings.planner_provider` exactly
    as an agent names its own in `agents.toml`.

    With no key for it, the API still starts, as it always has, so wallet sign-in, credits and the agent list
    work; a planning request then fails with 502. (The worker, which can do nothing without a model, refuses
    to start.)"""
    env = os.environ if environ is None else environ
    spec = providers[name]
    key = provider_key(spec, env)
    if not key:
        env_var = spec.api_key_env or "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
        log.warning(
            "no model key set for provider %r (%s): planning requests will fail until one is", name, env_var
        )
        return _UnavailableLLM()
    if spec.kind == "anthropic":
        # With its own `api_key_env`, this provider's key may not be the SDK's own env-var default (another
        # `[providers.*]` table could be anthropic too, with a different key); pass it explicitly so the
        # right one is actually used, not just checked for presence above.
        return AnthropicLLM(client=AsyncAnthropic(api_key=key)) if spec.api_key_env else AnthropicLLM()
    assert spec.base_url is not None  # load_providers requires base_url for kind == "openai_chat"
    return OpenAIChatLLM(key, base_url=spec.base_url, timeout_s=timeout_s)
