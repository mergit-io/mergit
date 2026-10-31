"""Model gateway: one small interface the planner and the agents call, with an Anthropic adapter and a Groq
one.

Nothing outside this module imports a provider SDK, so adding a provider is one more class here. The provider
is
chosen once at start-up by `build_llm` (mergit_worker/providers.py): Anthropic when its key is set, Groq when
only
Groq's is. Credentials come from the environment and never pass through a prompt.
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

from mergit_worker.llm import GROQ_BASE_URL, retry_wait
from mergit_worker.openai_chat import BadReply, parse_reply, to_openai_messages, to_openai_tools
from mergit_worker.providers import llm_provider


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
        client = self._client
        # Production always passes a real AsyncAnthropic; tests pass a bare stub without these
        # attributes, which this isinstance check (unnecessary by the type hint alone) guards against.
        is_real = isinstance(client, AsyncAnthropic)  # pyright: ignore[reportUnnecessaryIsInstance]
        if is_real and not client.api_key and not client.auth_token:
            raise LLMUnavailable("ANTHROPIC_API_KEY is not set")
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
            # Anthropic resolves the alias to a dated snapshot id in the response; prices.toml and
            # agents.toml are keyed by the alias, so the alias is what must be priced and recorded.
            model=model,
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


class GroqLLM:
    """Groq's OpenAI-compatible chat API, the fallback when there is no Anthropic key (same translation as the
    worker's
    `GroqLLM`, in `mergit_worker/openai_chat.py`). A structured answer is requested as best-effort JSON-schema
    output
    (`strict: false`, which every Groq model supports) because the planner validates every answer itself in
    `check_tasks`, exactly as it does for Anthropic."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 120.0,
        base_url: str = GROQ_BASE_URL,
        sleep: Callable[[float], Any] = asyncio.sleep,
        max_tokens: int = 16000,
    ) -> None:
        key = api_key or os.environ.get("GROQ_API_KEY")
        if not key:
            raise LLMUnavailable("GROQ_API_KEY is not set")
        self._headers = {"Authorization": f"Bearer {key}"}
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
            # prices.toml and agents.toml are keyed by the requested model id, not whatever the
            # provider echoes back (see the matching fix in AnthropicLLM.complete).
            model=model,
        )
        if reply.stop_reason in _UNUSABLE:
            raise LLMError(str(reply.stop_reason), result)
        return result


def build_llm(environ: Mapping[str, str] | None = None) -> LLM:
    """The planner's model client: Anthropic when its key is set, Groq when only Groq's is.

    With no key at all the API still starts, as it always has, so wallet sign-in, credits and the agent list
    work; a planning request then fails with 502. (The worker, which can do nothing without a model, refuses
    to start.)"""
    env = os.environ if environ is None else environ
    provider = llm_provider(env)
    if provider == "groq" and env.get("GROQ_API_KEY"):
        return GroqLLM(env["GROQ_API_KEY"])
    if not env.get("ANTHROPIC_API_KEY") and not env.get("ANTHROPIC_AUTH_TOKEN"):
        log.warning(
            "no model key set (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or GROQ_API_KEY): "
            "planning requests will fail until one is"
        )
    return AnthropicLLM()
