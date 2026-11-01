from __future__ import annotations

import base64
import json
import sys
from typing import Any

import mergit_receipt
import pytest

from mergit_worker.harness import HarnessError, run_task
from mergit_worker.llm import LLMError
from mergit_worker.models import TRUNCATION_MARKER
from mergit_worker.tools import ToolLimits
from tests.support import (
    CHAIN_ID,
    FIX,
    REGISTRY,
    ProcessSandbox,
    RecordingPublisher,
    ScriptedLLM,
    make_agent,
    make_harness_config,
    make_job,
    make_prices,
    phi,
    turn,
)


def run(sandbox: ProcessSandbox, publisher: RecordingPublisher, turns: list[Any], repo_url: str, **kw: Any):
    job = make_job(repo_url, **kw.pop("job", {}))
    llm = ScriptedLLM(turns)
    outcome = run_task(job, make_agent(), sandbox, llm, make_prices(), publisher, make_harness_config(**kw))
    return outcome, publisher.bundle()["receipt"], llm


def step_types(receipt: dict[str, Any]) -> list[str]:
    return [s["type"] for s in receipt["steps"]]


def verify(publisher: RecordingPublisher) -> dict[str, Any]:
    sealed = publisher.sealed[-1]
    return json.loads(mergit_receipt.verify(sealed.bundle_json, CHAIN_ID, REGISTRY, None))


def test_fake_agent_fixes_repo_and_phi_holds(sandbox, publisher, repo_url):
    outcome, receipt, _ = run(
        sandbox, publisher, [turn(FIX), turn(("finish", {"summary": "done"}))], repo_url
    )
    assert outcome.holds is True
    assert step_types(receipt) == [
        "model_call",
        "artifact_write",
        "model_call",
        "tool_call",
        "command",
        "phi_eval",
    ]
    assert verify(publisher)["status"] == "unattested_valid"


class _RecordingProgress:
    def __init__(self) -> None:
        self.reports: list[tuple[str, int, str, int]] = []

    def report(self, task_id: str, seq: int, step_type: str, cost: Any) -> None:
        self.reports.append((task_id, seq, step_type, cost.usd_micros))


def test_steps_are_reported_live_as_they_are_recorded(sandbox, publisher, repo_url):
    """Every agent-loop step goes to the progress reporter the instant it is recorded, with the same
    seq the receipt gives it; the Φ command and phi_eval steps, added after the loop ends, are not
    reported this way (the job's own outcome covers them)."""
    progress = _RecordingProgress()
    job = make_job(repo_url)
    outcome = run_task(
        job,
        make_agent(),
        sandbox,
        ScriptedLLM([turn(FIX), turn(("finish", {}))]),
        make_prices(),
        publisher,
        make_harness_config(),
        progress,
    )
    assert outcome.holds is True
    assert [r[0] for r in progress.reports] == [job.task_id] * len(progress.reports)
    assert [r[1] for r in progress.reports] == [1, 2, 3, 4]
    assert [r[2] for r in progress.reports] == ["model_call", "artifact_write", "model_call", "tool_call"]


def test_phi_runs_after_agent_stops_and_is_last_step(sandbox, publisher, repo_url):
    _, receipt, _ = run(sandbox, publisher, [turn(FIX), turn(("finish", {}))], repo_url)
    types = step_types(receipt)
    assert types.count("phi_eval") == 1
    assert types[-1] == "phi_eval"
    assert types[-2] == "command"  # the Φ command, right before its evaluation
    assert receipt["evidence"] == [len(types) - 1, len(types)]
    assert sandbox.resets == 1  # stray processes are killed before Φ runs


def test_agent_cannot_append_phi_eval(sandbox, publisher, repo_url):
    # The model has no tool for it: asking for one is an unknown tool, recorded as a plain tool_call.
    _, receipt, _ = run(
        sandbox, publisher, [turn(("phi_eval", {"holds": True})), turn(("finish", {}))], repo_url
    )
    assert step_types(receipt).count("phi_eval") == 1  # only the one added by sealing
    assert step_types(receipt)[1] == "tool_call"
    # And the binding itself refuses it when called directly.
    builder = mergit_receipt.ReceiptBuilder(
        json.dumps(json.loads(publisher.sealed[-1].bundle_json)["receipt"]["header"])
    )
    with pytest.raises(ValueError, match="phi_eval"):
        builder.add_step(
            "phi_eval",
            b"",
            b"",
            0,
            json.dumps(
                {
                    "model": None,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "tool_calls": 0,
                    "wall_ms": 0,
                    "usd_micros": 0,
                }
            ),
        )


def test_finish_alone_does_not_complete_the_task(sandbox, publisher, repo_url):
    outcome, _, _ = run(sandbox, publisher, [turn(("finish", {"summary": "all done!"}))], repo_url)
    assert outcome.holds is False  # the agent said done; the check said no
    assert verify(publisher)["status"] == "unattested_valid"


def test_step_cost_recorded_from_provider_usage(sandbox, publisher, repo_url):
    _, receipt, _ = run(
        sandbox,
        publisher,
        [turn(("finish", {}), input_tokens=1_000_000, output_tokens=500_000)],
        repo_url,
    )
    model_step = receipt["steps"][0]
    # 1M input at $2/Mtok + 0.5M output at $10/Mtok = $7 = 7_000_000 micro-USD
    assert model_step["cost"] == {
        "model": "test-model",
        "input_tokens": 1_000_000,
        "output_tokens": 500_000,
        "tool_calls": 0,
        "wall_ms": model_step["cost"]["wall_ms"],
        "usd_micros": 7_000_000,
    }
    assert receipt["meter"]["usd_micros"] == 7_000_000


def test_outcome_carries_sealed_cost(sandbox, publisher, repo_url):
    outcome, _, _ = run(
        sandbox,
        publisher,
        [turn(FIX), turn(("finish", {"summary": "done"}))],
        repo_url,
    )
    assert outcome.cost_micros == publisher.sealed[-1].cost_micros
    assert outcome.cost_micros > 0


def test_budget_exhausted_still_seals_with_phi(sandbox, publisher, repo_url):
    expensive = turn(FIX, input_tokens=1_000_000, output_tokens=0)  # $2 > the 1_000_000 budget
    outcome, receipt, llm = run(
        sandbox,
        publisher,
        [expensive, turn(("finish", {}))],
        repo_url,
        job={"budget_usdc_units": 1_000_000},
    )
    assert llm.calls == 1  # no second model call once the budget is spent
    assert outcome.notes == ["cost_budget"]
    assert step_types(receipt)[-1] == "phi_eval"
    assert outcome.holds is True  # the work it did before running out still counts


class _RecordingLLM(ScriptedLLM):
    """A `ScriptedLLM` that also remembers the `max_tokens` it was asked for on every call."""

    def __init__(self, turns: list[Any]) -> None:
        super().__init__(turns)
        self.requested_max_tokens: list[int] = []

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str,
        *,
        system: str | None = None,
        max_tokens: int = 8192,
    ) -> Any:
        self.requested_max_tokens.append(max_tokens)
        return super().complete(messages, tools, model, system=system, max_tokens=max_tokens)


def test_a_tight_budget_clamps_the_requested_max_tokens(sandbox, publisher, repo_url):
    """A call whose `max_tokens` is left at the configured ceiling could, in the worst case, cost more
    than a small remaining budget allows. The harness must ask for less, not find out after the fact."""
    job = make_job(repo_url, budget_usdc_units=1_000)  # price is $10/mtok output: 100 tokens' worth
    llm = _RecordingLLM([turn(("finish", {}))])
    run_task(job, make_agent(), sandbox, llm, make_prices(), publisher, make_harness_config())
    assert llm.requested_max_tokens == [100]  # well under the 1024 ceiling `make_harness_config` sets


def test_budget_too_small_for_one_token_stops_before_calling(sandbox, publisher, repo_url):
    job = make_job(repo_url, budget_usdc_units=1)  # a fraction of a cent: cannot afford one output token
    llm = _RecordingLLM([turn(("finish", {}))])
    outcome = run_task(job, make_agent(), sandbox, llm, make_prices(), publisher, make_harness_config())
    assert llm.calls == 0
    assert outcome.notes == ["cost_budget"]


def test_step_budget_stops_the_loop(sandbox, publisher, repo_url):
    spin = [turn(("list_files", {})) for _ in range(5)]
    outcome, receipt, llm = run(sandbox, publisher, spin, repo_url, max_steps=3)
    assert llm.calls == 3
    assert outcome.notes == ["step_budget"]
    assert step_types(receipt)[-1] == "phi_eval"


def test_provider_failure_seals_but_is_inconclusive(sandbox, publisher, repo_url):
    outcome, receipt, _ = run(sandbox, publisher, [LLMError("boom")], repo_url)
    assert outcome.holds is None  # not the agent's fault, so a person decides
    assert step_types(receipt) == ["command", "phi_eval"]


def test_model_that_stops_without_tools_ends_the_loop(sandbox, publisher, repo_url):
    outcome, _, llm = run(sandbox, publisher, [turn(text="I think it is fine")], repo_url)
    assert llm.calls == 1
    assert outcome.notes == ["no_tool_calls"]
    assert outcome.holds is False


def test_tool_output_truncated_with_marker(sandbox, publisher, repo_url):
    cap = 1000
    limits = ToolLimits(
        command_timeout_s=30, max_output_bytes=cap, max_write_bytes=cap, model_output_bytes=2048
    )
    noisy = {"argv": [sys.executable, "-c", "print('x' * 3000)"]}
    _, receipt, _ = run(
        sandbox,
        publisher,
        [turn(("run_command", noisy)), turn(("finish", {}))],
        repo_url,
        tool_limits=limits,
    )
    cmd_step = receipt["steps"][1]
    assert cmd_step["type"] == "command"
    blobs = json.loads(publisher.sealed[-1].trajectory_blobs_json)
    stored = base64.b64decode(blobs[cmd_step["output_digest"]])
    assert stored.endswith(TRUNCATION_MARKER)
    assert len(stored) == cap + len(TRUNCATION_MARKER)
    assert mergit_receipt.keccak_hex(stored) == cmd_step["output_digest"]  # digest covers stored bytes


def test_inconsistent_task_id_is_refused_before_anything_runs(sandbox, publisher, repo_url):
    with pytest.raises(HarnessError, match="task_id"):
        run(sandbox, publisher, [], repo_url, job={"attempt": 2})
    assert publisher.sealed == []


def test_agent_mismatch_is_refused(sandbox, publisher, repo_url):
    with pytest.raises(HarnessError, match="agent"):
        run(sandbox, publisher, [], repo_url, job={"agent_id": "2"})


def test_phi_that_cannot_start_is_inconclusive(sandbox, publisher, repo_url):
    outcome, receipt, _ = run(
        sandbox,
        publisher,
        [turn(("finish", {}))],
        repo_url,
        job={"phi": phi(command=["/no/such/binary"])},
    )
    assert outcome.holds is None
    phi_eval = receipt["steps"][-1]
    assert phi_eval["type"] == "phi_eval"
    assert verify(publisher)["status"] == "unattested_valid"


def test_header_phi_hash_comes_from_the_binding(sandbox, publisher, repo_url):
    _, receipt, _ = run(sandbox, publisher, [turn(("finish", {}))], repo_url)
    header = receipt["header"]
    assert header["phi_hash"] == mergit_receipt.phi_hash(json.dumps(header["phi"]))
    assert header["attestation"]["kind"] == "unattested"


def test_passing_task_carries_its_patch(sandbox, publisher, repo_url):
    outcome, _, _ = run(sandbox, publisher, [turn(FIX), turn(("finish", {}))], repo_url)
    assert outcome.holds is True
    assert outcome.patch is not None
    assert "+    return amount - fee" in outcome.patch
    assert "payments/refund.py" in outcome.patch


def test_failing_task_carries_no_patch(sandbox, publisher, repo_url):
    outcome, _, _ = run(sandbox, publisher, [turn(("finish", {}))], repo_url)
    assert outcome.holds is False
    assert outcome.patch is None


def test_patch_over_the_cap_is_dropped_and_noted(sandbox, publisher, repo_url):
    outcome, _, _ = run(sandbox, publisher, [turn(FIX), turn(("finish", {}))], repo_url, max_patch_bytes=10)
    assert outcome.holds is True
    assert outcome.patch is None
    assert any(n.startswith("no_patch: larger than 10") for n in outcome.notes)


def test_non_utf8_change_cannot_be_a_patch(sandbox, publisher, repo_url):
    sandbox.workspace.write_file("payments/blob.txt", b"\xff\xfe not utf8\n")
    outcome, _, _ = run(sandbox, publisher, [turn(FIX), turn(("finish", {}))], repo_url)
    assert outcome.holds is True
    assert outcome.patch is None
    assert any("UTF-8" in n for n in outcome.notes)
