"""The harness: owns the receipt builder, runs the model loop, then runs Φ and seals.

Order of one task, fixed by spec/receipt-v0.md and plan task O5:
  agent loop (every model call and tool call is a step) -> Φ run in the sandbox (a `command` step,
  marked evidence) -> `seal_with_phi` appends the `phi_eval` step last -> upload the bundle ->
  send `receipt.sealed`. The caller then reports `holds` to the control plane. The agent never decides
  that a task is done: `finish` only ends its turn.

Every step the agent loop records is also reported live to the control plane's run API (plan task O7,
`POST /v0/internal/progress`) through `progress.py`, which it gets as `ProgressReporter`. This is purely
for a viewer watching the run; a report that fails or is never configured changes nothing about the task,
the receipt or the job outcome.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol

import mergit_receipt

from .llm import LLM, LLMError, LLMResult
from .meter import Cost, Price, PriceTable, tool_cost
from .models import Job, RunOutcome, cap_output
from .phi import PhiRun, run_phi
from .progress import NullProgressReporter, ProgressReporter
from .sandbox import SandboxPort
from .tools import TOOL_SCHEMAS, Recorder, ToolBox, ToolLimits
from .workspace import WorkspaceError

log = logging.getLogger(__name__)


class HarnessError(Exception):
    """The job row is inconsistent with the spec derivations, or the agent is misconfigured."""


class Publisher(Protocol):
    """Uploads the bundle, then sends `receipt.sealed`, in that order."""

    def publish(self, sealed: mergit_receipt.SealedBundle) -> None: ...


@dataclass(frozen=True, slots=True)
class AgentSpec:
    agent_id: str
    provider: str
    model: str
    system_prompt: str
    runtime_key_address: str  # the registered runtime key; the header's attestation.dev_key
    signing_key: str  # 0x-prefixed secret, from MERGIT_AGENT_KEY_<id>; never leaves the worker


@dataclass(frozen=True, slots=True)
class HarnessConfig:
    chain_id: int
    registry: str
    runtime_image: str
    max_steps: int
    job_deadline_s: float
    model_max_tokens: int
    max_output_bytes: int
    max_hash_bytes: int
    max_patch_bytes: int
    tool_limits: ToolLimits


def run_task(
    job: Job,
    agent: AgentSpec,
    sandbox: SandboxPort,
    llm: LLM,
    prices: PriceTable,
    publisher: Publisher,
    cfg: HarnessConfig,
    progress: ProgressReporter | None = None,
) -> RunOutcome:
    _check_ids(job)
    builder = mergit_receipt.ReceiptBuilder(_header_json(job, agent, cfg))
    spent = _Spent()
    record = _recorder(builder, spent, job.task_id, progress or NullProgressReporter())
    outcome_note = _agent_loop(job, agent, sandbox, llm, prices, record, spent, cfg)

    phi_run = run_phi(sandbox, job.phi, cfg.max_output_bytes, cfg.max_hash_bytes)
    _record_phi_command(job, phi_run, builder, cfg)
    sealed = builder.seal_with_phi(
        json.dumps(phi_run.result), Cost().to_json(), agent.signing_key, cfg.chain_id, cfg.registry
    )
    publisher.publish(sealed)

    holds = phi_run.holds
    notes = [outcome_note]
    if outcome_note in _INFRA_STOPS:
        holds = None  # the agent did not get a fair run, so a person decides, not the check
    patch = None
    if holds is True:  # only a change that passed Φ is ever shown to the requester or turned into a PR
        patch = _capture_patch(sandbox, cfg.max_patch_bytes, notes)
    return RunOutcome(
        task_id=job.task_id,
        holds=holds,
        root=sealed.root,
        notes=notes,
        patch=patch,
        cost_micros=sealed.cost_micros,
    )


_INFRA_STOPS = {"llm_error"}


def _capture_patch(sandbox: SandboxPort, max_bytes: int, notes: list[str]) -> str | None:
    """The change as a patch. If it cannot be stored, the task still passed; the PR gate then refuses to
    build a pull request from it and says why, instead of opening one with a piece missing."""
    try:
        patch = sandbox.workspace.diff_from_head()
    except WorkspaceError as exc:
        notes.append(f"no_patch: {exc}")
        return None
    if len(patch.encode()) > max_bytes:
        notes.append(f"no_patch: larger than {max_bytes} bytes")
        return None
    return patch


class _Spent:
    def __init__(self) -> None:
        self.usd_micros = 0


_MILLION = Decimal(1_000_000)


def _affordable_max_tokens(remaining_usd_micros: int, price: Price, ceiling: int) -> int:
    """The largest `max_tokens` whose worst case (every one of them billed as output) still fits the
    remaining budget, capped at `ceiling`. Bounding only the output side is a deliberate
    simplification: the next call's input tokens are set by the conversation so far, which grows far
    more slowly than one call's `max_tokens`, so this is a cheap, effective guard on the dominant risk
    without needing to estimate input tokens ahead of time. It does not make overspend impossible, only
    unlikely and small, which is the right trade for a receipt that is signed either way."""
    if price.output_per_mtok <= 0:
        return ceiling
    remaining_usd = Decimal(remaining_usd_micros) / _MILLION
    affordable = int((remaining_usd / price.output_per_mtok) * _MILLION)
    return max(0, min(ceiling, affordable))


def _check_ids(job: Job) -> None:
    """Re-derive the ids through the binding. A mismatched job row must not produce a receipt that the
    chain gateway would reject or, worse, attach to another task."""
    if mergit_receipt.plan_id(job.plan_uuid) != job.plan_id:
        raise HarnessError("plan_id does not match plan_uuid")
    if mergit_receipt.task_id(job.plan_id, job.index, job.attempt) != job.task_id:
        raise HarnessError("task_id does not match plan_id, index and attempt")


def _header_json(job: Job, agent: AgentSpec, cfg: HarnessConfig) -> str:
    if agent.agent_id != job.agent_id:
        raise HarnessError("agent does not match the job's agent_id")
    header = {
        "version": "mergit-receipt/0",
        "task_id": job.task_id,
        "plan_id": job.plan_id,
        "requester": job.requester.lower(),
        "agent_id": job.agent_id,
        "category": job.category,
        "phi": job.phi,
        "phi_hash": mergit_receipt.phi_hash(json.dumps(job.phi)),
        "budget_usdc_units": str(job.budget_usdc_units),
        "runtime_image": cfg.runtime_image,
        "attestation": {"kind": "unattested", "dev_key": agent.runtime_key_address.lower()},
        "started_at": _now(),
    }
    return json.dumps(header)


def _now() -> str:
    """RFC 3339, UTC, milliseconds, `Z` suffix (spec/receipt-v0.md)."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _recorder(
    builder: mergit_receipt.ReceiptBuilder, spent: _Spent, task_id: str, progress: ProgressReporter
) -> Recorder:
    def record(step_type: str, inp: bytes, out: bytes, exit_status: int | None, cost: Cost) -> int:
        if step_type == "phi_eval":  # the binding refuses too; fail before reaching it
            raise PermissionError("phi_eval is appended only by sealing")
        seq = builder.add_step(step_type, inp, out, exit_status, cost.to_json())
        spent.usd_micros += cost.usd_micros
        progress.report(task_id, seq, step_type, cost)
        return seq

    return record


def _task_prompt(job: Job) -> str:
    phi = job.phi
    allowed = phi["allowed_paths"]
    return (
        f"Task: {job.title}\n\n{job.instructions}\n\n"
        f"When you finish, this check will be run in the repository: {json.dumps(phi['command'])} "
        f"(working directory {phi['workdir']!r}); it must exit with {phi['expected_exit']}.\n"
        + (f"You may only change paths matching: {json.dumps(allowed)}.\n" if allowed is not None else "")
        + "Use the tools to work. Call `finish` when you believe the work is complete."
    )


def _agent_loop(
    job: Job,
    agent: AgentSpec,
    sandbox: SandboxPort,
    llm: LLM,
    prices: PriceTable,
    record: Recorder,
    spent: _Spent,
    cfg: HarnessConfig,
) -> str:
    """Runs the model until it finishes or a limit is reached. Returns why it stopped."""
    tools = ToolBox(sandbox, record, cfg.tool_limits)
    messages: list[dict[str, Any]] = [{"role": "user", "content": _task_prompt(job)}]
    sent = 0  # messages already recorded as a model_call input
    deadline = time.monotonic() + cfg.job_deadline_s

    for _ in range(cfg.max_steps):
        remaining = job.budget_usdc_units - spent.usd_micros
        if remaining <= 0:
            return "cost_budget"
        if time.monotonic() >= deadline:
            return "time_budget"
        max_tokens = _affordable_max_tokens(remaining, prices.price(agent.model), cfg.model_max_tokens)
        if max_tokens < 1:
            # The call itself was never made, so nothing here was overspent; the budget just has no
            # room left for one more output token even at the smallest size the API will accept.
            return "cost_budget"
        started = time.monotonic()
        try:
            result = llm.complete(
                messages,
                TOOL_SCHEMAS,
                agent.model,
                system=agent.system_prompt,
                max_tokens=max_tokens,
            )
        except LLMError as exc:
            log.warning("model call failed for %s: %s", job.task_id, exc)
            return "llm_error"
        _record_model_call(agent, prices, record, messages[sent:], sent == 0, result, started)
        messages.append({"role": "assistant", "content": result.assistant_content})
        sent = len(messages)  # the next call's new input is only the tool results that follow

        if result.stop_reason in ("refusal", "max_tokens"):
            return result.stop_reason
        if not result.tool_calls:
            return "no_tool_calls"
        blocks: list[dict[str, Any]] = []
        finished = False
        for call in result.tool_calls:
            outcome = tools.execute(call)
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": outcome.content,
                    "is_error": outcome.is_error,
                }
            )
            if outcome.finished:
                finished = True
                break
        if finished:
            return "finished"
        # Tool calls skipped after a `finish` never ran, so none can be left without a result here.
        messages.append({"role": "user", "content": blocks})
    return "step_budget"


def _record_model_call(
    agent: AgentSpec,
    prices: PriceTable,
    record: Recorder,
    new_messages: list[dict[str, Any]],
    first: bool,
    result: LLMResult,
    started: float,
) -> None:
    """One `model_call` step. Its input is what is new since the previous call (plus the system prompt
    on the first), so the chain, not each blob, carries the whole conversation."""
    wall_ms = int((time.monotonic() - started) * 1000)
    payload: dict[str, Any] = {"model": agent.model, "new_messages": new_messages}
    if first:
        payload["system"] = agent.system_prompt
    cost = prices.model_call_cost(agent.model, result.input_tokens, result.output_tokens, wall_ms)
    record(
        "model_call",
        json.dumps(payload, sort_keys=True).encode(),
        json.dumps(result.assistant_content, sort_keys=True).encode(),
        None,
        cost,
    )


def _record_phi_command(
    job: Job, phi_run: PhiRun, builder: mergit_receipt.ReceiptBuilder, cfg: HarnessConfig
) -> None:
    """The Φ command is a step of its own, in the evidence set next to the `phi_eval` step. Its output
    is exactly the bytes `stdout_digest` hashes (stdout alone, capped the same way), so an auditor can
    match the digest to a stored blob. stderr is not part of the receipt; it is only logged locally, for
    an operator, since mixing it into the step's output would make that digest match nothing."""
    cmd = phi_run.command
    if cmd.stderr:
        log.info("phi stderr for %s: %s", job.task_id, cmd.stderr[:2000].decode("utf-8", "replace"))
    seq = builder.add_step(
        "command",
        json.dumps({"argv": job.phi["command"], "workdir": job.phi["workdir"]}, sort_keys=True).encode(),
        cap_output(cmd.stdout, cfg.max_output_bytes),
        phi_run.result["exit_code"],
        tool_cost(cmd.wall_ms).to_json(),
    )
    builder.mark_evidence(seq)
