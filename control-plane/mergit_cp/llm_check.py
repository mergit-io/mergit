"""Checks the model credential the way the planner and the agents use it, before a real run depends on it.

    python -m mergit_cp.llm_check [model]        (run inside the api container, or with the same env)

Makes two tiny calls with the configured provider (``ANTHROPIC_API_KEY``, or ``ANTHROPIC_AUTH_TOKEN`` with
``ANTHROPIC_BASE_URL`` for a gateway such as Claude Lend, or Groq): a plain answer, then one that must call a
tool, because the agents work by tool calls. Prints the provider, the model, whether each call worked and its
token counts; never a key or a token. Exit status 0 only if both worked.
"""

import asyncio
import os
import sys
from typing import Any
from urllib.parse import urlsplit

from mergit_worker.providers import effective_model, llm_provider

from .llm import LLMError, LLMUnavailable, build_llm

_TOOL = {
    "name": "report",
    "description": "Report the result.",
    "input_schema": {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
    },
}


def _endpoint() -> str:
    if llm_provider() == "groq":
        return urlsplit(os.environ.get("GROQ_BASE_URL") or "https://api.groq.com").hostname or "groq"
    return urlsplit(os.environ.get("ANTHROPIC_BASE_URL", "")).hostname or "api.anthropic.com"


async def check(model: str) -> bool:
    llm = build_llm()
    print(f"provider={llm_provider()}  endpoint={_endpoint()}  model={model}")
    ok = True
    steps: list[tuple[str, list[dict[str, Any]], list[dict[str, Any]] | None]] = [
        ("plain answer", [{"role": "user", "content": "Reply with the single word: ready"}], None),
        (
            "tool call",
            [
                {
                    "role": "user",
                    "content": "Call the report tool with answer set to ready. Do not write text.",
                }
            ],
            [_TOOL],
        ),
    ]
    for name, messages, tools in steps:
        try:
            result = await llm.complete(messages, tools, model)
        except (LLMUnavailable, LLMError) as problem:
            print(f"  {name}: FAILED  {str(problem)[:300]}")
            ok = False
            continue
        worked = bool(result.tool_calls) if tools else bool(result.text.strip())
        ok = ok and worked
        print(
            f"  {name}: {'ok' if worked else 'FAILED (the reply did not do what was asked)'}"
            f"  in={result.input_tokens} out={result.output_tokens} served_by={result.model}"
        )
    return ok


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    model = effective_model(args[0] if args else os.environ.get("PLANNER_MODEL", "claude-haiku-4-5"))
    return 0 if asyncio.run(check(model)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
