# Failure-injection audit

**Source:** HLD decisions doc, "M5 · wk 8-9 · Hardening for production": "Failure-injection suite:
fabricated success, empty diff, wrong file, budget overrun, step tampering, cache replay. Each must
be caught." Plus issue #28's "multi-worker load test with no lost or double-run tasks."

This records what the code and tests already guarantee for each named scenario. Evidence is cited by
file and test name, not line numbers, so it stays true as the files change: `pytest
'tests/test_harness.py::test_dropped_step_is_rejected'` runs a cited test on its own. Paths without a
`control-plane/` prefix are relative to the repo root (the Rust crates and the `mergit_receipt` type
stub live outside this subtree); all other paths are relative to `control-plane/`.

| HLD scenario | Status | Evidence |
|---|---|---|
| Fabricated success (agent claims done, nothing actually passed) | **Covered, structurally and by test** | The `finish` tool in `mergit_worker/tools.py` takes only a `summary` string: there is no field an agent could set to claim success, and only Φ decides. `tests/test_harness.py::test_finish_alone_does_not_complete_the_task` drives this through the real pipeline: the agent calls `finish` and `outcome.holds is False`. |
| Wrong file (agent edits outside the task's paths, the check still exits 0) | **Covered** | `tests/test_phi.py::test_change_outside_allowed_paths_fails_even_when_check_passes` writes the allowed fix plus an out-of-scope file; the command exits 0 and `holds is False`. |
| Empty diff passing | **Accepted by design, not a defect** | The pull-request gate in `README.md` (plan task O9) does not treat an empty patch, a task that passed without changing a tracked file, as a blocker, and skips it when applying a plan's combined diff because `git apply` refuses an empty patch. A task can pass Φ without a change (a check that was already satisfied), and failing it would make the gate stricter than the predicate it trusts. |
| Budget overrun | **Covered, including the one gap this audit found** | `tests/test_harness.py::test_budget_exhausted_still_seals_with_phi` shows sealing still happens and partial, useful work still passes Φ. `tests/test_harness.py::test_budget_too_small_for_one_token_stops_before_calling` stops the loop with no model call. Nothing had checked that running out of budget with no completed work ends in a recorded failure rather than a silent pass, so `tests/test_harness.py::test_budget_exhausted_with_no_completed_work_fails` was added: with `budget_usdc_units=1` it asserts no model call, `outcome.notes == ["cost_budget"]` and `outcome.holds is False`. It passed against the unmodified harness, so this is new coverage of an unexercised branch, not a bug fix. |
| Step tampering (a receipt's hash chain or signature altered after sealing) | **Covered in the Rust crates, and from Python** | The vectors in `spec/vectors/` (`bad_signature.json`, `chain_mismatch.json`, `body_hash_mismatch.json`, `commitment_mismatch.json` and others) are consumed by `verifier/tests/vectors.rs` and `spec/tests/attestation.rs`. `mergit_receipt.verify()` is exposed to Python in `runtime/py/mergit_receipt.pyi`. Three tests in `tests/test_harness.py` mutate a copy of a real sealed bundle the way an attacker would and confirm the control plane's own `verify()` call rejects it: `test_tampered_step_output_is_rejected` (one character of a step's `output_digest`), `test_reordered_steps_are_rejected` (two steps swapped) and `test_dropped_step_is_rejected` (a step removed; CLAUDE.md invariant 1, the complete trajectory). Each asserts the status is not `"unattested_valid"` and `reasons` is non-empty, and `test_fake_agent_fixes_repo_and_phi_holds` first shows the untampered bundle verifies. |
| Cache replay (a stale cached tool or model response presented as fresh) | **Not buildable yet: the feature it would guard does not exist** | The only cache fields are `cache_read_tokens` and `cache_write_tokens`, for billing (`mergit_worker/meter.py`, `LLMResult` in `mergit_cp/llm.py`): they count tokens a provider served from its own cache, with no notion of freshness or replay. There is no cache-provenance field on a receipt step, no cache store, and nothing a step could replay. A guard needs a receipt-schema decision first (mergit-research), like TEE attestation. |
| No lost or double-run tasks under concurrent workers (issue #28) | **Covered** | `tests/test_jobs.py::test_concurrent_workers_never_claim_the_same_job` runs 6 worker threads against `SELECT ... FOR UPDATE SKIP LOCKED` on a real Postgres and checks that 30 jobs are each claimed exactly once. |

**Summary:** five of seven items were already guarded and tested. Empty diff is accepted by design, and
cache replay cannot be built without a schema decision. The one real gap, a budget overrun with no
completed work, is closed by a new test, and step tampering now has Python-side tests as well as the
Rust vector suite.
