"""Plain data types shared across the worker."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TRUNCATION_MARKER = b"\n[mergit: output truncated at 1048576 bytes]\n"
OUTPUT_CAP_BYTES = 1_048_576


def cap_output(data: bytes, cap: int = OUTPUT_CAP_BYTES) -> bytes:
    """Cap captured output per spec/receipt-v0.md: keep the first `cap` bytes and end with the marker.
    The digest of the step covers exactly the returned bytes."""
    if len(data) <= cap:
        return data
    return data[:cap] + TRUNCATION_MARKER


@dataclass(frozen=True, slots=True)
class CommandResult:
    exit_code: int
    stdout: bytes
    stderr: bytes
    wall_ms: int
    timed_out: bool = False
    could_not_start: bool = False  # the executable was missing or the exec was refused


@dataclass(frozen=True, slots=True)
class Job:
    """One claimed unit of work. Fields come from the `jobs`, `tasks` and `plans` rows (plan O4)."""

    task_id: str
    plan_uuid: str
    plan_id: str
    index: int
    attempt: int
    agent_id: str
    requester: str
    category: str
    repo_url: str
    ref: str
    title: str
    instructions: str
    phi: dict[str, Any]
    budget_usdc_units: int  # 6 decimals, the same scale as a step's usd_micros
    depends_on: tuple[int, ...] = ()
    dependency_patches: tuple[str, ...] = ()
    """Parallel to `depends_on`: each dependency's stored passing patch, or `""` when it made no change.
    Applied onto the fresh checkout before the agent loop starts, so a dependent task actually sees the
    code it depends on, in the same index order the pull-request gate (plan task O9) later combines
    patches in."""


@dataclass(slots=True)
class RunOutcome:
    """What the harness reports to the control plane once the task is sealed."""

    task_id: str
    holds: bool | None
    root: str | None = None
    notes: list[str] = field(default_factory=lambda: list[str]())
    patch: str | None = None  # the passing change, for the PR gate (plan task O9)
    cost_micros: int | None = None  # the sealed bundle's attested cost; None when the task never sealed
