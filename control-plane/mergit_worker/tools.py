"""The tools offered to the model, and the single place where each call becomes one receipt step.

The tool layer only sees a `record(step_type, input, output, exit_status, cost)` callback. It has no
reference to the receipt builder, so it has no path to the `phi_eval` step, and no tool takes a
credential or reads the worker's environment.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from .llm import ToolCall
from .meter import Cost, tool_cost
from .models import cap_output
from .sandbox import SandboxError, SandboxPort
from .workspace import WorkspaceError

Recorder = Callable[[str, bytes, bytes, int | None, Cost], int]

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "list_files",
        "description": "List files and directories under a path of the repository (directories end in '/').",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Relative path, default '.'"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_file",
        "description": "Create or replace a file with the given full contents.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_command",
        "description": (
            "Run a command in the sandbox (no network, no shell unless you pass one in argv). "
            "Returns the exit code and output."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "workdir": {"type": "string", "description": "Relative to the repository root"},
                "timeout_s": {"type": "integer", "minimum": 1},
            },
            "required": ["argv"],
            "additionalProperties": False,
        },
    },
    {
        "name": "finish",
        "description": (
            "Say you are done. This ends your turn; whether the task passed is decided by a separate check."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "additionalProperties": False,
        },
    },
]


@dataclass(frozen=True, slots=True)
class ToolLimits:
    command_timeout_s: int
    max_output_bytes: int
    max_write_bytes: int
    model_output_bytes: int


@dataclass(frozen=True, slots=True)
class ToolOutcome:
    content: str
    is_error: bool = False
    finished: bool = False


class ToolBox:
    def __init__(self, sandbox: SandboxPort, record: Recorder, limits: ToolLimits) -> None:
        self._sandbox = sandbox
        self._record = record
        self._limits = limits

    def execute(self, call: ToolCall) -> ToolOutcome:
        """Run one model tool call and record it as exactly one step, whatever happens."""
        started = time.monotonic()
        handler = _HANDLERS.get(call.name)
        step_type = "tool_call"
        exit_status: int | None = None
        try:
            if handler is None:
                raise _BadCall(f"unknown tool {call.name!r}")
            step_type, output, exit_status, outcome = handler(self, call.input)
            is_error, finished = outcome.is_error, outcome.finished
            shown = outcome.content
        except (_BadCall, WorkspaceError, SandboxError, OSError) as exc:
            output = str(exc).encode()
            is_error, finished, shown = True, False, str(exc)
        wall_ms = int((time.monotonic() - started) * 1000)
        self._record(
            step_type,
            json.dumps({"tool": call.name, "input": call.input}, sort_keys=True).encode(),
            cap_output(output, self._limits.max_output_bytes),
            exit_status,
            tool_cost(wall_ms),
        )
        return ToolOutcome(self._for_model(shown), is_error, finished)

    # -- handlers (return step type, recorded output, exit status, what the model sees) --------------

    def handle_list_files(self, args: dict[str, Any]) -> _Result:
        path = _opt_str(args, "path", ".")
        listing = "\n".join(self._sandbox.workspace.list_files(path))
        return "tool_call", listing.encode(), None, ToolOutcome(listing or "(empty)")

    def handle_read_file(self, args: dict[str, Any]) -> _Result:
        path = _req_str(args, "path")
        data = self._sandbox.workspace.read_file(path, self._limits.max_output_bytes)
        return "tool_call", data, None, ToolOutcome(data.decode("utf-8", "replace"))

    def handle_write_file(self, args: dict[str, Any]) -> _Result:
        path, content = _req_str(args, "path"), _req_str(args, "content")
        raw = content.encode()
        if len(raw) > self._limits.max_write_bytes:
            raise _BadCall(f"content is larger than {self._limits.max_write_bytes} bytes")
        self._sandbox.workspace.write_file(path, raw)
        return "artifact_write", raw, None, ToolOutcome(f"wrote {len(raw)} bytes to {path}")

    def handle_run_command(self, args: dict[str, Any]) -> _Result:
        argv = _argv(args)
        workdir = _opt_str(args, "workdir", ".")
        timeout = args.get("timeout_s", self._limits.command_timeout_s)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1:
            raise _BadCall("timeout_s must be a positive integer")
        timeout = min(timeout, self._limits.command_timeout_s)
        result = self._sandbox.run(argv, workdir, timeout)
        combined = result.stdout
        if result.stderr:
            combined += b"\n--- stderr ---\n" + result.stderr
        if result.timed_out:
            combined += f"\n[mergit: command timed out after {timeout}s]\n".encode()
        text = combined.decode("utf-8", "replace")
        shown = f"exit code {result.exit_code}\n{text}"
        return (
            "command",
            combined,
            result.exit_code,
            ToolOutcome(shown, is_error=result.exit_code != 0),
        )

    def handle_finish(self, args: dict[str, Any]) -> _Result:
        summary = _opt_str(args, "summary", "")
        return "tool_call", summary.encode(), None, ToolOutcome("ok", finished=True)

    def _for_model(self, text: str) -> str:
        raw = text.encode()
        limit = self._limits.model_output_bytes
        if len(raw) <= limit:
            return text
        return (
            raw[:limit].decode("utf-8", "ignore")
            + "\n[output shortened for the model; the receipt keeps it all]"
        )


type _Result = tuple[str, bytes, int | None, ToolOutcome]


class _BadCall(Exception):
    """The model called a tool wrongly. Reported back to the model and recorded."""


def _argv(args: dict[str, Any]) -> list[str]:
    raw: Any = args.get("argv")
    if not isinstance(raw, list) or not raw:
        raise _BadCall("argv must be a non-empty list of strings")
    items = cast("list[Any]", raw)
    if not all(isinstance(a, str) for a in items):
        raise _BadCall("argv must be a non-empty list of strings")
    return [str(a) for a in items]


def _req_str(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str):
        raise _BadCall(f"{key} must be a string")
    return value


def _opt_str(args: dict[str, Any], key: str, default: str) -> str:
    value = args.get(key, default)
    if not isinstance(value, str):
        raise _BadCall(f"{key} must be a string")
    return value


_HANDLERS: dict[str, Callable[[ToolBox, dict[str, Any]], _Result]] = {
    "list_files": ToolBox.handle_list_files,
    "read_file": ToolBox.handle_read_file,
    "write_file": ToolBox.handle_write_file,
    "run_command": ToolBox.handle_run_command,
    "finish": ToolBox.handle_finish,
}
