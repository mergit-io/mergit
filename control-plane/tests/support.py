"""Test doubles and builders. Doubles live here and in tests only, never in `mergit_worker`."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mergit_receipt

from mergit_worker.harness import AgentSpec, HarnessConfig
from mergit_worker.llm import LLMError, LLMResult, ToolCall
from mergit_worker.meter import Price, PriceTable
from mergit_worker.models import CommandResult, Job
from mergit_worker.tools import ToolLimits
from mergit_worker.workspace import GitLimits, Workspace

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
KEY_ADDRESS = "0xf39Fd6e51aad88F6F4ce6ab8827279cffFb92266"
REGISTRY = "0x0000000000000000000000000000000000000001"
CHAIN_ID = 84532
REQUESTER = "0x6e2d4a9c51b07f3e9d28c4a16b0e7f2c3d119a0b"
PLAN_UUID = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b"
LOCAL_GIT = GitLimits(allowed_schemes=("file",), timeout_s=60)


def git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
    done = subprocess.run(["git", "-C", str(cwd), *args], env=env, capture_output=True, text=True, check=True)
    return done.stdout


def make_repo(root: Path) -> str:
    """A tiny Python repository with a bug: `refund` forgets to subtract the fee. Returns its file:// URL."""
    repo = root / "origin"
    (repo / "payments").mkdir(parents=True)
    (repo / "payments" / "__init__.py").write_text("")
    (repo / "payments" / "refund.py").write_text("def refund(amount, fee):\n    return amount\n")
    (repo / "docs").mkdir()
    (repo / "docs" / "notes.md").write_text("notes\n")
    (repo / ".gitignore").write_text("__pycache__/\n")
    git(root, "init", "-q", "-b", "main", str(repo))
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    return f"file://{repo}"


def phi(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "exec/0",
        "command": [sys.executable, "-c", "from payments.refund import refund; assert refund(10, 2) == 8"],
        "expected_exit": 0,
        "workdir": ".",
        "allowed_paths": ["payments/**"],
        "artifact_hashes": None,
        "timeout_s": 60,
    }
    base.update(over)
    return base


def make_job(repo_url: str, **over: Any) -> Job:
    plan_id = mergit_receipt.plan_id(PLAN_UUID)
    fields: dict[str, Any] = {
        "task_id": mergit_receipt.task_id(plan_id, 0, 1),
        "plan_uuid": PLAN_UUID,
        "plan_id": plan_id,
        "index": 0,
        "attempt": 1,
        "agent_id": "1",
        "requester": REQUESTER,
        "category": "test-repair",
        "repo_url": repo_url,
        "ref": "main",
        "title": "Fix refund",
        "instructions": "refund must subtract the fee",
        "phi": phi(),
        "budget_usdc_units": 2_000_000,
    }
    fields.update(over)
    return Job(**fields)


def make_agent() -> AgentSpec:
    return AgentSpec(
        agent_id="1",
        provider="anthropic",
        model="test-model",
        system_prompt="You fix bugs.",
        runtime_key_address=KEY_ADDRESS,
        signing_key=KEY,
    )


def make_prices() -> PriceTable:
    from decimal import Decimal

    return PriceTable({"test-model": Price(Decimal("2.00"), Decimal("10.00"))})


def make_harness_config(**over: Any) -> HarnessConfig:
    cfg: dict[str, Any] = {
        "chain_id": CHAIN_ID,
        "registry": REGISTRY,
        "runtime_image": "mergit-runtime:test",
        "max_steps": 60,
        "job_deadline_s": 600.0,
        "model_max_tokens": 1024,
        "max_output_bytes": 1_048_576,
        "max_hash_bytes": 1_048_576,
        "max_patch_bytes": 1_048_576,
        "tool_limits": ToolLimits(
            command_timeout_s=30,
            max_output_bytes=1_048_576,
            max_write_bytes=1_048_576,
            model_output_bytes=32_768,
        ),
    }
    cfg.update(over)
    return HarnessConfig(**cfg)


class ProcessSandbox:
    """Runs commands as plain subprocesses in the checkout. No isolation: for tests of harness logic only.
    The docker-marked tests cover the real `Sandbox`."""

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace
        self.resets = 0

    @classmethod
    def create(cls, repo_url: str, ref: str, root: Path) -> ProcessSandbox:
        return cls(Workspace.clone(repo_url, ref, root, LOCAL_GIT))

    def run(self, argv: list[str], workdir: str, timeout_s: int) -> CommandResult:
        cwd = self.workspace.work / workdir
        started = time.monotonic()
        env = {"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1", "HOME": "/tmp"}
        try:
            done = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, timeout=timeout_s, check=False)
        except subprocess.TimeoutExpired as exc:
            return CommandResult(-1, exc.stdout or b"", exc.stderr or b"", _ms(started), timed_out=True)
        except (FileNotFoundError, PermissionError) as exc:
            return CommandResult(127, b"", str(exc).encode(), _ms(started), could_not_start=True)
        return CommandResult(done.returncode, done.stdout, done.stderr, _ms(started))

    def reset_processes(self) -> None:
        self.resets += 1

    def destroy(self) -> None:
        self.workspace.destroy()


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


Turn = Callable[[], LLMResult | Exception]


class ScriptedLLM:
    """Plays back a fixed list of model turns. Each is an LLMResult, or an exception to raise."""

    def __init__(self, turns: list[LLMResult | Exception]) -> None:
        self._turns = list(turns)
        self.calls = 0

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> LLMResult:
        self.calls += 1
        if not self._turns:
            raise LLMError("script exhausted")
        turn = self._turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        return turn


def turn(
    *calls: tuple[str, dict[str, Any]],
    text: str = "",
    input_tokens: int = 100,
    output_tokens: int = 50,
    stop_reason: str | None = None,
) -> LLMResult:
    tool_calls = [ToolCall(f"toolu_{i}", name, args) for i, (name, args) in enumerate(calls)]
    blocks: list[dict[str, Any]] = ([{"type": "text", "text": text}] if text else []) + [
        {"type": "tool_use", "id": c.id, "name": c.name, "input": c.input} for c in tool_calls
    ]
    return LLMResult(
        text=text,
        tool_calls=tool_calls,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        model="test-model",
        stop_reason=stop_reason or ("tool_use" if tool_calls else "end_turn"),
        assistant_content=blocks,
    )


FIX = (
    "write_file",
    {"path": "payments/refund.py", "content": "def refund(amount, fee):\n    return amount - fee\n"},
)


@dataclass
class RecordingPublisher:
    sealed: list[mergit_receipt.SealedBundle]

    def publish(self, sealed: mergit_receipt.SealedBundle) -> None:
        self.sealed.append(sealed)

    def bundle(self) -> dict[str, Any]:
        return json.loads(self.sealed[-1].bundle_json)
