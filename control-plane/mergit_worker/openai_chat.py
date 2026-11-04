"""Translation between the Anthropic-shaped messages the harness keeps (and records in receipts) and the
OpenAI chat
shape that Groq speaks. Pure functions, no network: the HTTP adapters in `llm.py` (worker) and
`mergit_cp/llm.py`
(planner) both use it, so the receipt format does not depend on which provider answered.

Facts from Groq's own pages (console.groq.com/docs, 2026-10-30): tool definitions go in `tools` as
`{"type": "function", "function": {name, description, parameters}}`; a tool call comes back with `arguments`
as a JSON
string; its result goes back as a `role: "tool"` message with the matching `tool_call_id`; and
`messages[].name` is
listed as unsupported (400), so it is never sent. Not documented there, so assumed from the OpenAI shape and
worth
checking against a live call: that an assistant message carrying `tool_calls` accepts `content: null`, and the
full
list of `finish_reason` values (an unknown one is passed through unchanged, never hidden).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, cast


class BadReply(ValueError):
    """The provider's answer is not usable: no choice, or tool arguments that are not JSON."""


_STOP_REASONS = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "length": "max_tokens",
    "content_filter": "refusal",
}


def to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t["input_schema"],
            },
        }
        for t in tools
    ]


def _result_text(block: dict[str, Any]) -> str:
    content = block.get("content", "")
    text = (
        "".join(str(b.get("text", "")) for b in _items(block.get("content")))
        if isinstance(content, list)
        else str(content)
    )
    # The OpenAI tool message has no error flag, so a failed tool says so in its text.
    return f"Error: {text}" if block.get("is_error") else text


def to_openai_messages(messages: list[dict[str, Any]], system: str | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
    for message in messages:
        role, content = message["role"], message["content"]
        if isinstance(content, str):
            out.append({"role": role, "content": content})
        elif role == "assistant":
            texts = [str(b["text"]) for b in content if b.get("type") == "text"]
            calls = [
                {
                    "id": b["id"],
                    "type": "function",
                    "function": {"name": b["name"], "arguments": json.dumps(b["input"])},
                }
                for b in content
                if b.get("type") == "tool_use"
            ]
            reply: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(texts) if texts else (None if calls else ""),
            }
            if calls:
                reply["tool_calls"] = calls
            out.append(reply)
        else:
            texts: list[str] = []
            for b in content:
                if b.get("type") == "tool_result":
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": _result_text(b)})
                elif b.get("type") == "text":
                    texts.append(str(b["text"]))
            if texts:
                out.append({"role": "user", "content": "".join(texts)})
    return out


@dataclass(frozen=True, slots=True)
class ParsedReply:
    text: str
    calls: list[tuple[str, str, dict[str, Any]]]  # (id, name, input)
    stop_reason: str | None
    prompt_tokens: int  # includes the cached part
    completion_tokens: int
    cached_tokens: int
    model: str | None


def _obj(value: object) -> dict[str, Any]:
    """`value` as a JSON object, or an empty one: the provider's answer is untrusted input."""
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _items(value: object) -> list[dict[str, Any]]:
    return [_obj(v) for v in cast("list[object]", value)] if isinstance(value, list) else []


def parse_reply(data: dict[str, Any]) -> ParsedReply:
    choices = _items(data.get("choices"))
    if not choices:
        raise BadReply("the provider's answer has no choices")
    message = _obj(choices[0].get("message"))
    calls: list[tuple[str, str, dict[str, Any]]] = []
    for call in _items(message.get("tool_calls")):
        function = _obj(call.get("function"))
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except ValueError as exc:
            raise BadReply(f"tool call {function.get('name')!r} has arguments that are not JSON") from exc
        if not isinstance(arguments, dict):
            raise BadReply(f"tool call {function.get('name')!r} arguments are not an object")
        calls.append((str(call.get("id")), str(function.get("name")), cast("dict[str, Any]", arguments)))
    usage = _obj(data.get("usage"))
    raw_finish = choices[0].get("finish_reason")
    finish = raw_finish if isinstance(raw_finish, str) else None
    details = _obj(usage.get("prompt_tokens_details"))
    return ParsedReply(
        text=str(message.get("content") or ""),
        calls=calls,
        stop_reason=_STOP_REASONS.get(finish, finish) if finish else None,
        prompt_tokens=int(usage.get("prompt_tokens") or 0),
        completion_tokens=int(usage.get("completion_tokens") or 0),
        cached_tokens=int(details.get("cached_tokens") or 0),
        model=data.get("model"),
    )


# What a provider's own status codes mean here: worth another attempt, or not.
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


@dataclass(frozen=True)
class BodyError:
    message: str
    retryable: bool


def body_error(data: object) -> BodyError | None:
    """Why an HTTP 200 body is not an answer, or None when it is one. The body is untrusted input.

    Some providers, OpenRouter among them, report a failure with HTTP 200 and an `error` object carrying the
    status they would have sent (`{"error": {"code": 429, "message": ...}}`), so a rate limit or an upstream
    outage there is retried like the same status on its own. Both planner and worker clients use this."""
    if not isinstance(data, dict):
        return BodyError("the answer is not a JSON object", retryable=False)
    error = cast("dict[str, Any]", data).get("error")
    if not error:
        return None
    if not isinstance(error, dict):
        return BodyError(str(error), retryable=False)
    fields = cast("dict[str, Any]", error)
    message, code = fields.get("message"), fields.get("code")
    try:
        status = int(code) if code is not None and not isinstance(code, bool) else None
    except (TypeError, ValueError):
        status = None
    if isinstance(message, str) and message.strip():
        text = message.strip()
    elif code is not None:
        text = f"error code {code}"
    else:
        text = "an error with no message"
    return BodyError(text, retryable=status in RETRY_STATUSES)


def scrub(text: str, secret: str) -> str:
    """`text` with `secret` cut out. Error text from a provider goes into logs and `llm_check`'s output, and
    some providers echo the key they rejected back in the body of a 401."""
    return text.replace(secret, "[redacted]") if secret else text
