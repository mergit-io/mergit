"""Model gateway client used by the harness. The worker only needs `complete`; the planner (O2) defines
the same protocol in `mergit_cp.llm`, and any object with this method satisfies both."""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, cast

import anthropic
import httpx

from .config import ConfigError
from .openai_chat import BadReply, parse_reply, to_openai_messages, to_openai_tools
from .providers import ProviderSpec, provider_key


class LLMError(Exception):
    """The provider call failed after the SDK's own retries."""


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass(frozen=True, slots=True)
class LLMResult:
    text: str
    tool_calls: list[ToolCall]
    input_tokens: int
    output_tokens: int
    model: str
    stop_reason: str | None = None
    # The assistant turn as the provider returned it, so the next request can replay it unchanged.
    assistant_content: list[dict[str, Any]] = field(default_factory=lambda: [])


class LLM(Protocol):
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> LLMResult: ...


class AnthropicLLM:
    """Anthropic Messages API through the official SDK. The key is read from `ANTHROPIC_API_KEY` by the
    SDK, in the worker's environment only."""

    def __init__(self, client: anthropic.Anthropic | None = None, timeout_s: float = 600.0) -> None:
        self._client = client or anthropic.Anthropic(timeout=timeout_s)

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> LLMResult:
        kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = {"type": "auto"}
        try:
            response = cast("anthropic.types.Message", self._client.messages.create(**kwargs))
        except anthropic.APIError as exc:
            raise LLMError(f"model call failed: {exc}") from exc
        blocks = [b.model_dump(exclude_none=True) for b in response.content]
        text = "".join(b.text for b in response.content if b.type == "text")
        calls = [
            ToolCall(b.id, b.name, dict(b.input))  # pyright: ignore[reportArgumentType]
            for b in response.content
            if b.type == "tool_use"
        ]
        return LLMResult(
            text=text,
            tool_calls=calls,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            model=response.model,
            stop_reason=response.stop_reason,
            assistant_content=blocks,
        )


GROQ_BASE_URL = "https://api.groq.com/openai/v1"
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_ATTEMPTS = 3


def retry_wait(response: httpx.Response, attempt: int) -> float:
    """Seconds to wait before the next try: the provider's own `retry-after` when it sends one, capped at
    20."""
    try:
        return min(float(response.headers["retry-after"]), 20.0)
    except (KeyError, ValueError):
        return float(attempt)


class OpenAIChatLLM:
    """Any OpenAI-compatible chat API (Groq, OpenRouter, ...). It takes and returns the same
    Anthropic-shaped data as `AnthropicLLM`, so the harness and the receipts do not know which one answered.
    The key is only ever sent in the `Authorization` header: errors never include it.

    Cached prompt tokens are counted as ordinary input here, because the worker's meter has no cached-token
    field:
    a receipt can overstate cost by at most the cache discount, never understate it."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        client: httpx.Client | None = None,
        timeout_s: float = 600.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._http = client or httpx.Client(timeout=timeout_s)
        self._sleep = sleep

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(1, _ATTEMPTS + 1):
            try:
                response = self._http.post(self._url, json=payload, headers=self._headers)
            except httpx.TransportError as exc:
                if attempt == _ATTEMPTS:
                    raise LLMError(f"model call failed: {type(exc).__name__}") from exc
                self._sleep(float(attempt))
                continue
            if response.status_code == 200:
                try:
                    data = cast("dict[str, Any]", response.json())
                except ValueError as exc:
                    raise LLMError("model call failed: the answer is not JSON") from exc
                error = data.get("error")
                if isinstance(error, dict):
                    raise LLMError(f"model call failed: {cast('dict[str, Any]', error).get('message')}")
                if error:
                    raise LLMError(f"model call failed: {error}")
                return data
            if response.status_code not in _RETRY_STATUSES or attempt == _ATTEMPTS:
                raise LLMError(f"model call failed: HTTP {response.status_code}: {response.text[:200]}")
            self._sleep(retry_wait(response, attempt))
        raise AssertionError("unreachable")  # pragma: no cover

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> LLMResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(messages, system),
            "max_completion_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = to_openai_tools(tools)
            payload["tool_choice"] = "auto"
        try:
            reply = parse_reply(self._post(payload))
        except BadReply as exc:
            raise LLMError(f"model call failed: {exc}") from exc
        blocks: list[dict[str, Any]] = [{"type": "text", "text": reply.text}] if reply.text else []
        blocks += [{"type": "tool_use", "id": i, "name": n, "input": a} for i, n, a in reply.calls]
        return LLMResult(
            text=reply.text,
            tool_calls=[ToolCall(i, n, a) for i, n, a in reply.calls],
            input_tokens=reply.prompt_tokens,
            output_tokens=reply.completion_tokens,
            model=reply.model or model,
            stop_reason=reply.stop_reason,
            assistant_content=blocks or [{"type": "text", "text": ""}],
        )


@dataclass(frozen=True, slots=True)
class ModelClients:
    """One model client per provider actually used by a deployed agent, built once at start-up so a missing
    key is a start-up error, never a surprise on a job's first model call."""

    _clients: dict[str, LLM]

    @classmethod
    def build(
        cls,
        providers: dict[str, ProviderSpec],
        needed: set[str],
        timeout_s: float,
        environ: Mapping[str, str] | None = None,
    ) -> ModelClients:
        env = os.environ if environ is None else environ
        clients: dict[str, LLM] = {}
        for name in needed:
            spec = providers.get(name)
            if spec is None:
                raise ConfigError(
                    f"provider {name!r} is used by an agent but has no [providers.{name}] table"
                )
            key = provider_key(spec, env)
            if not key:
                env_var = spec.api_key_env or "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
                raise ConfigError(f"{name} needs {env_var}")
            if spec.kind == "anthropic":
                clients[name] = AnthropicLLM(timeout_s=timeout_s)
            else:
                if not spec.base_url:
                    raise ConfigError(f"provider {name!r} is openai_chat but has no base_url")
                clients[name] = OpenAIChatLLM(key, base_url=spec.base_url, timeout_s=timeout_s)
        return cls(clients)

    def for_provider(self, name: str) -> LLM:
        """The client built for `name`. Raising here (rather than returning `None`) means a mismatch
        between `validate_agents_have_keys` and `build` fails loudly instead of as a `None` call later."""
        try:
            return self._clients[name]
        except KeyError:
            raise ConfigError(f"no model client was built for provider {name!r}") from None
