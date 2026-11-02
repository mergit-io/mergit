"""Running the approved predicate Φ after the agent has stopped (spec/predicate-v0.md).

`holds` is computed by the Rust binding from the approved predicate and the observed result; nothing
here re-implements the rule.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import mergit_receipt

from .models import CommandResult, cap_output
from .sandbox import SandboxError, SandboxPort
from .workspace import WorkspaceError


@dataclass(frozen=True, slots=True)
class PhiRun:
    command: CommandResult
    result: dict[str, Any]  # the PhiResult of spec/schemas/phi-result.json
    holds: bool | None  # None: Φ timed out, could not start, or the checkout was not safe to inspect


def run_phi(sandbox: SandboxPort, phi: dict[str, Any], max_output_bytes: int, max_hash_bytes: int) -> PhiRun:
    """Kill any process the agent left running, run Φ, and describe what happened.

    A timeout or a command that cannot start is recorded as `exit_code: -1, holds: false`, and the
    outcome reported to the control plane is `None`, so a person decides rather than a guess."""
    sandbox.reset_processes()
    try:
        command = sandbox.run(list(phi["command"]), phi["workdir"], int(phi["timeout_s"]))
    except (
        WorkspaceError,
        SandboxError,
    ) as exc:  # a workdir that escapes the checkout, or a sandbox that failed
        command = CommandResult(-1, b"", str(exc).encode(), 0, could_not_start=True)
    inconclusive = command.timed_out or command.could_not_start

    stdout = cap_output(command.stdout, max_output_bytes)
    try:
        changed_paths = sandbox.workspace.changed_paths()
    except WorkspaceError:
        # The checkout is not safe to inspect (for example, the agent planted a nested `.git`): Φ
        # cannot be evaluated honestly. This is inconclusive, the same as a command that could not
        # start, never a guess at whether the real change would have passed.
        inconclusive = True
        changed_paths = []
    observed: dict[str, str] = {}
    for path in sorted(phi["artifact_hashes"] or {}):
        digest = sandbox.workspace.file_hash(path, max_hash_bytes)
        if digest is not None:  # an absent file is omitted, per the spec
            observed[path] = digest

    result: dict[str, Any] = {
        "exit_code": -1 if inconclusive else command.exit_code,
        "changed_paths": changed_paths,
        "observed_artifact_hashes": observed,
        "stdout_digest": mergit_receipt.keccak_hex(stdout),
        "holds": False,
    }
    if inconclusive:
        return PhiRun(command, result, None)
    result["holds"] = mergit_receipt.phi_holds(json.dumps(phi), json.dumps(result))
    return PhiRun(command, result, bool(result["holds"]))
