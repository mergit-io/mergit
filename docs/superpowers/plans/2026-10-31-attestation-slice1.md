# Attestation slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receipt format v1 that can carry a vendor key attestation, and a verifier whose `valid` status is unreachable without a verified document and an allowed measurement. No receipt is actually attested after this plan.

**Architecture:** `Attestation` in `mergit-spec` becomes open-kind with optional claim fields; `SealedReceipt` gains an optional `attestation_document` outside `body_hash`. `mergit-verifier` gains a `Verifier` (registered per-kind document checkers + `TrustPolicy`) and the free `verify()` delegates to it with an empty policy, so every existing caller is unchanged. A `test-attestation` cargo feature supplies an ed25519 test kind used only for vectors.

**Tech Stack:** Rust 1.98 workspace (alloy, serde_jcs), `ed25519-dalek` 2 (test feature only), pyo3 binding, wasm-bindgen, GitHub Actions, TypeScript (one label).

**Spec:** `docs/superpowers/specs/2026-10-31-attestation-slice1-design.md`

## Global Constraints

- **Git:** the user runs every git write (add, commit, push, branch). Each task's final step is "Hand off": print the exact `git add` / `git commit` commands; never run them. Delivery is three PRs: **PR1** = Task 1; **PR2** = Tasks 2-7; **PR3** = Tasks 8-10.
- v0 behaviour is unchanged: `spec/vectors/*` existing files stay byte-identical (`git diff --stat spec/vectors` shows only added files); an unattested receipt is `unattested_valid`, never `valid`.
- Nothing may present an unverified receipt as attested. UI copy for v0 stays "Verified, unattested (development key)". After this plan P1 is **not** done and no text says it is.
- `test-attestation` is off by default, enabled by no service, binding, image, WASM build or CLI; with it off, kind `"test-ed25519"` is `ATTESTATION_UNSUPPORTED`.
- Policy is required and per kind; empty means nothing is trusted. `now` is an explicit unix-seconds `i64`, never the clock.
- Existing quality gates stay green: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`. (Verified clean at plan time.)
- Gateway/store/validator DB tests need `DATABASE_URL`; locally use a throwaway Postgres (socket dir `/tmp/pgk`, port 55432).
- Doc fields: `attestation_document` is `0x`-hex (alloy `Bytes`, like `signature`), not base64 (the design doc said base64; this plan changes it for consistency, and Task 7 fixes the doc).
- Never commit secrets or database files.

## Review Focus

Failure modes the spec implies that no single task's happy path covers, most likely first; each has a test in the owning task:

1. A garbled, truncated or empty document must yield `ATTESTATION_INVALID`, never a panic (Task 4).
2. Measurement hex compared case-insensitively and with/without `0x`; a case difference alone must not flip the outcome either way (Task 3).
3. A kind that has a registered verifier but **no entry in the policy** can never be `valid` (Task 3).
4. `expected_signer` supplied by the caller that differs from `runtime_key` is `BAD_SIGNATURE`, even with a perfect document (Task 3).
5. Certificate-window boundaries: `now == not_after` is valid, `now == not_after + 1` is not (Task 4).

---

## File Structure

- `spec/src/types.rs`, `spec/src/lib.rs`, `spec/src/hash.rs`: attestation type, `VERSION_V1`, `attestation_document`, body-hash exclusion.
- `verifier/src/lib.rs`: stays the verification core; new `verifier/src/attestation.rs` (trait, `TrustPolicy`, `Claims`, `DocError`), `verifier/src/test_kind.rs` (feature-gated).
- `runtime/receipt/src/builder.rs`: v1 header acceptance, `with_attestation_document`.
- `runtime/receipt/examples/gen_vectors.rs`: new attested vectors.
- `spec/receipt-v1.md`, `spec/schemas/header.json`, `spec/schemas/sealed-receipt.json`, `spec/examples/`.
- `.github/workflows/rust.yml`.
- `verifier/wasm/src/lib.rs`, `runtime/py/src/lib.rs`, `runtime/py/tests/test_binding.py`, `evidence/validator/src/lib.rs`, `frontend/src/verifier/report.ts`.

---

### Task 1: Rust CI workflow (PR1)

**Files:**
- Create: `.github/workflows/rust.yml`

**Interfaces:**
- Produces: a CI job named `rust` that later tasks extend with the feature guard (Task 4).

- [ ] **Step 1: Write `.github/workflows/rust.yml`.** Triggers: `pull_request` and `push` to `main`, paths `spec/**, runtime/**, verifier/**, evidence/**, chain/**, Cargo.toml, Cargo.lock, .github/workflows/rust.yml`; `permissions: contents: read`; `concurrency` group `rust-${{ github.ref }}` with cancel-in-progress (copy the shape of `control-plane.yml`). One job `rust` on `ubuntu-latest`, `timeout-minutes: 45`, a `postgres:16` service (`POSTGRES_PASSWORD: postgres`, health-checked, port 5432) and `env: DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres`. Steps: `actions/checkout@v4`; `dtolnay/rust-toolchain@1.98.0` with `components: rustfmt, clippy`; `Swatinem/rust-cache@v2`; then `run:` each of `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- [ ] **Step 2: Verify locally.** Run the three commands with a local Postgres up and `DATABASE_URL` set. Expected: fmt silent; clippy `Finished`; every `test result:` line `ok` (gateway: 9 + 20 passed).
- [ ] **Step 3: Verify the workflow parses.** Run `uvx -q check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/rust.yml`. Expected: `ok -- validation done`.
- [ ] **Step 4: Hand off.** Print: `git add .github/workflows/rust.yml docs/superpowers/specs/2026-10-31-attestation-slice1-design.md docs/superpowers/plans/2026-10-31-attestation-slice1.md && git commit -m "ci: run fmt, clippy and tests for the Rust crates"`.

---

### Task 2: Attestation type, v1 version, document field (PR2)

**Files:**
- Modify: `spec/src/types.rs:30-35` (Attestation) and `:112-122` (SealedReceipt), `spec/src/lib.rs` (constants), `spec/src/hash.rs` (`body_hash`)
- Modify call sites: `runtime/receipt/examples/{gen_vectors,false_receipt}.rs`, `runtime/receipt/tests/builder.rs`, `evidence/validator/tests/audit.rs`, `chain/gateway/tests/common/mod.rs`, `runtime/receipt/src/builder.rs`, `verifier/src/lib.rs`
- Test: `spec/tests/attestation.rs` (create)

**Interfaces:**
- Produces (`mergit_spec`):
  `pub struct Attestation { pub kind: String, pub dev_key: Option<Address>, pub runtime_key: Option<Address>, pub measurement: Option<String> }` (serde: `deny_unknown_fields`; `None` fields skipped so v0 JSON is unchanged);
  `Attestation::unattested(dev_key: Address) -> Self`; `Attestation::attested(kind: &str, runtime_key: Address, measurement: &str) -> Self`; `Attestation::signing_key(&self) -> Option<Address>` (`dev_key.or(runtime_key)`);
  `pub const VERSION_V1: &str = "mergit-receipt/1"`; `VERSION` stays `"mergit-receipt/0"`;
  `SealedReceipt.attestation_document: Option<Bytes>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`), excluded from `body_hash`.

- [ ] **Step 1: Write failing tests in `spec/tests/attestation.rs`.** `unattested_json_is_unchanged`: `serde_json::to_string(&Attestation::unattested(addr))` equals `{"kind":"unattested","dev_key":"<addr lowercase>"}` and `jcs_hash` of a full v0 header built the old way equals the hash recorded in `spec/vectors/valid_minimal.json` (`terminal_hash` chain start is the header hash: load the vector and assert `jcs_hash(&bundle.receipt.header)` round-trips through serde unchanged, i.e. `serde_json::from_value::<Header>(to_value(h)) == h` and re-serialised JSON equals the vector's header JSON). `attested_round_trips`: `Attestation::attested("test-ed25519", a, "ab12")` serialises to `{"kind":"test-ed25519","runtime_key":..,"measurement":"ab12"}` and `signing_key() == Some(a)`. `body_hash_ignores_document`: a receipt with `attestation_document = Some(Bytes::from_static(b"x"))` has the same `body_hash(&r)` as with `None`. `unknown_field_rejected`: JSON attestation with `"extra":1` fails to deserialise.
- [ ] **Step 2: Run** `cargo test -p mergit-spec --test attestation`. Expected: FAIL (items undefined).
- [ ] **Step 3: Implement** the type, constructors, `signing_key`, `VERSION_V1`, the `SealedReceipt` field, and `o.remove("attestation_document")` in `body_hash`. Fix every call site to use `Attestation::unattested(..)`; in `verifier/src/lib.rs` replace `r.header.attestation.dev_key` with `r.header.attestation.signing_key()` (a `None` signer means `signature_ok` is false). Existing `kind = "tee".into()` mutations in tests/gen_vectors keep working because `kind` is a `String`.
- [ ] **Step 4: Run** `cargo test --workspace` (with `DATABASE_URL`). Expected: all pass, including the 19 existing vectors; `git diff --stat spec/vectors` empty.
- [ ] **Step 5: Hand off.** Print `git add spec runtime verifier evidence chain && git commit -m "spec: open attestation kind and an optional attestation document (format v1)"`.

---

### Task 3: Verifier core: policy, `valid`, truth table (PR2)

**Files:**
- Create: `verifier/src/attestation.rs`
- Modify: `verifier/src/lib.rs`
- Test: `verifier/tests/truth_table.rs` (create)

**Interfaces:**
- Consumes: Task 2 types.
- Produces (`mergit_verifier`):
  ```rust
  pub struct Claims { pub measurement: String, pub bound_key: Address }
  pub enum DocError { Malformed, Untrusted, Expired }            // Debug + Clone
  pub trait AttestationVerifier: Send + Sync {
      fn kind(&self) -> &'static str;
      fn verify_document(&self, document: &[u8], roots: &[Vec<u8>], now: i64) -> Result<Claims, DocError>;
  }
  pub struct KindPolicy { pub roots: Vec<Vec<u8>>, pub measurements: Vec<String> }
  #[derive(Default)] pub struct TrustPolicy(pub BTreeMap<String, KindPolicy>);
  pub struct Verifier { /* policy + registered verifiers */ }
  impl Verifier {
      pub fn new(policy: TrustPolicy) -> Self;                    // registers built-ins (none unless test-attestation)
      pub fn register(&mut self, v: Box<dyn AttestationVerifier>);
      pub fn verify(&self, bundle: &Bundle, domain: &Eip712Domain, expected_signer: Option<Address>,
                    commitment: Option<&Commitment>, now: i64) -> Report;
  }
  ```
  `Status` gains `Valid` (serialised `"valid"`). `Reason` gains `AttestationInvalid`, `AttestationMeasurement`, `AttestationKeyMismatch`. `impl Reason { pub fn is_informational(self) -> bool }` true only for `Unattested`. The free `verify(bundle, domain, expected_signer, commitment) -> Report` stays and equals `Verifier::new(TrustPolicy::default()).verify(.., 0)`.

- [ ] **Step 1: Write failing tests in `verifier/tests/truth_table.rs`.** A mock `AttestationVerifier` (kind `"mock"`) returning fixed `Claims` or a fixed `DocError`; a helper in `verifier/tests/common/mod.rs` builds a v1 bundle by loading `spec/vectors/valid_minimal.json`, rewriting `header.version` and `header.attestation`, attaching a document, then resealing with `mergit-spec` functions (`jcs_hash`, `leaf`, `chain`, `merkle_root`, `body_hash`) and signing with `alloy-signer-local` (add both as dev-dependencies of `mergit-verifier`; do **not** depend on `runtime/`, the verifier must stay independent of it). One test per row, asserting exact `status` and `reasons` (excluding informational):
  - `verified_allowed_is_valid`: doc ok, measurement in policy, key matches → `Valid`, no `Unattested`.
  - `empty_policy_is_never_valid`: same bundle, `TrustPolicy::default()` → `Invalid` with `AttestationInvalid` (no roots to verify against).
  - `kind_missing_from_policy_is_never_valid` (Review Focus 3): verifier registered, policy has another kind → `Invalid`, `AttestationInvalid`.
  - `measurement_not_allowed`: → `Invalid`, exactly `[AttestationMeasurement]`.
  - `measurement_hex_case_and_prefix_insensitive` (Review Focus 2): header `0xABCD`, doc `abcd`, policy `ABCD` → `Valid`; header `abce` → `AttestationMeasurement`.
  - `key_mismatch`: doc `bound_key` ≠ header `runtime_key` → `[AttestationKeyMismatch]`.
  - `expected_signer_differs_is_bad_signature` (Review Focus 4): perfect doc, `expected_signer = Some(other)` → `BadSignature`, `Invalid`.
  - `doc_fails_reports_only_invalid`: verifier returns `Err(Malformed)` → exactly `[AttestationInvalid]` (no measurement/key reasons).
  - `attested_kind_without_document` → `[AttestationInvalid]`.
  - `unattested_with_document` → `[AttestationUnsupported]`; `unattested_under_v1` → `[AttestationUnsupported]`.
  - `attested_kind_under_v0` → `[AttestationUnsupported]`; `unknown_kind_no_verifier` → `[AttestationUnsupported]`.
  - `v0_unattested_stays_unattested_valid` and `no_input_combination_reaches_valid_without_document`: loop over every existing v0 vector in `spec/vectors/*.json` with a policy that allows everything → none is `Valid`.
  - `reason_classification`: `Reason::Unattested.is_informational()` true, every other variant false (iterate a `const ALL: [Reason; N]` kept in the test, with an exhaustive `match` so adding a variant fails to compile).
- [ ] **Step 2: Run** `cargo test -p mergit-verifier --test truth_table`. Expected: FAIL (items undefined).
- [ ] **Step 3: Implement** `attestation.rs` and the `Verifier`. Status rule: failing = any reason with `!is_informational()`; `Valid` iff not failing, a document verified, and measurement allowed; `UnattestedValid` iff not failing and no attested kind; any attested-kind problem is a failing reason, so a false claim is `Invalid`. Rework the existing `verify` body into `Verifier::verify`, add the attestation checks per the design doc's table, and keep `AttestationUnsupported`/`Unattested` behaviour for v0. Normalise measurements with `trim_start_matches("0x").to_lowercase()`.
- [ ] **Step 4: Run** `cargo test -p mergit-verifier`. Expected: all pass (truth table plus the existing vectors test).
- [ ] **Step 5: Hand off.** Print `git add verifier && git commit -m "verifier: trust policy and a valid status that needs a verified document"`.

---

### Task 4: `test-attestation` kind and the feature guard (PR2)

**Files:**
- Create: `verifier/src/test_kind.rs`
- Modify: `verifier/Cargo.toml`, `verifier/src/lib.rs`, `.github/workflows/rust.yml`
- Test: `verifier/tests/test_kind.rs` (create)

**Interfaces:**
- Consumes: Task 3 trait and `Verifier::new`.
- Produces (behind `#[cfg(feature = "test-attestation")]`): `pub const TEST_KIND: &str = "test-ed25519"`; `pub fn test_root_public_key() -> Vec<u8>` (32-byte ed25519 public key of a fixed seed `[7u8; 32]`); `pub fn issue_test_document(runtime_key: Address, measurement: &str, not_after: i64) -> Vec<u8>`. Document = JSON `{"runtime_key","measurement","not_after","signature"}`, `signature` = `0x`-hex ed25519 by the fixed key over `jcs_bytes({"runtime_key","measurement","not_after"})`. `Verifier::new` registers it when the feature is on. Feature `test-attestation = ["dep:ed25519-dalek"]`, `ed25519-dalek = { version = "2", optional = true }`.

- [ ] **Step 1: Write failing tests.** In `verifier/tests/test_kind.rs`, `#![cfg(feature = "test-attestation")]`: `good_document_verifies` (returns the claims); `tampered_document_is_untrusted` (flip a byte in `measurement`); `window_boundary` (Review Focus 5: `now == not_after` ok, `now == not_after + 1` → `Expired`); `garbage_never_panics` (Review Focus 1: `b""`, `b"{"`, 1 MiB of `0xff`, valid JSON with a missing field, a wrong-length signature → `Err(Malformed)`); `wrong_root_is_untrusted`. In a second file `verifier/tests/test_kind_off.rs`, **no cfg gate**, run only when the feature is off (`#![cfg(not(feature = "test-attestation"))]`): a v1 bundle of kind `"test-ed25519"` verifies as `Invalid` with `[AttestationUnsupported]`.
- [ ] **Step 2: Run** `cargo test -p mergit-verifier --features test-attestation --test test_kind`. Expected: FAIL.
- [ ] **Step 3: Implement** `test_kind.rs` and registration. Malformed JSON, missing fields, bad hex or wrong signature length → `Malformed`; signature that fails to verify or a root that is not the fixed key → `Untrusted`; `now > not_after` → `Expired`.
- [ ] **Step 4: Run** `cargo test -p mergit-verifier --features test-attestation` and `cargo test -p mergit-verifier`. Expected: both pass (the off test runs only in the second).
- [ ] **Step 5: Add the guard to `rust.yml`.** After the test step add a step that, for each of `-p mergit-gateway -p mergit-store -p mergit-validator -p mergit-verifier -p mergit-verifier-wasm -p mergit-receipt-py` (use the real package names from each `Cargo.toml`), runs `cargo tree -e features -p <pkg>` and fails if the output contains `test-attestation`; also fails if `ed25519-dalek` appears for any of them. Add a separate step `cargo test -p mergit-verifier --features test-attestation`. Verify locally by running the loop (Expected: no match for any package).
- [ ] **Step 6: Hand off.** Print `git add verifier .github/workflows/rust.yml Cargo.lock && git commit -m "verifier: test-only attestation kind behind a feature, with a CI guard"`.

---

### Task 5: Builder accepts v1 headers and a document (PR2)

**Files:**
- Modify: `runtime/receipt/src/builder.rs`, `runtime/receipt/Cargo.toml`
- Test: `runtime/receipt/tests/builder.rs`

**Interfaces:**
- Consumes: Task 2.
- Produces: `ReceiptBuilder::new` accepts `{version: VERSION, kind: unattested}` and `{version: VERSION_V1, kind != unattested, runtime_key and measurement set, dev_key unset}`; everything else is `BuildError::AttestationNotUnattested` (keep the variant name; message becomes "attestation kind does not match the receipt version"). `ReceiptBuilder::with_attestation_document(self, doc: Vec<u8>) -> Self`; sealing copies it into `SealedReceipt.attestation_document`. The signer check uses `attestation.signing_key()`.
- Cargo: add `test-attestation = ["mergit-verifier/test-attestation"]` and optional `mergit-verifier` dependency to `mergit-receipt` (needed by `gen_vectors` only).

- [ ] **Step 1: Write failing tests** in `runtime/receipt/tests/builder.rs`: `v1_header_with_attested_kind_builds_and_carries_document` (seal, assert `bundle.receipt.attestation_document == Some(doc)` and `body_hash` equals that of the same receipt without it); `v0_with_attested_kind_rejected`; `v1_with_unattested_kind_rejected`; `v1_missing_measurement_rejected`; `seal_rejects_signer_other_than_runtime_key` for v1.
- [ ] **Step 2: Run** `cargo test -p mergit-receipt --test builder`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified; keep the existing v0 behaviour and tests untouched.
- [ ] **Step 4: Run** `cargo test -p mergit-receipt`. Expected: all pass.
- [ ] **Step 5: Hand off.** `git add runtime/receipt Cargo.lock && git commit -m "receipt: builder accepts v1 attested headers and a document"`.

---

### Task 6: Attested vectors across Rust (PR2)

**Files:**
- Modify: `runtime/receipt/examples/gen_vectors.rs`, `verifier/tests/vectors.rs`
- Create (generated): `spec/vectors/attested_valid.json`, `attested_measurement_not_allowed.json`, `attested_key_mismatch.json`, `attested_document_for_other_key.json`, `attested_missing_document.json`, `attested_tampered_document.json`, `attested_expired.json`, `unattested_with_document.json`, `attested_under_v0.json`, `attested_unknown_kind.json`, `attested_empty_policy.json`

**Interfaces:**
- Consumes: Tasks 3-5. Vector JSON gains optional `"policy"` (`TrustPolicy` as `{kind: {roots: [base64], measurements: [hex]}}`) and `"now"` (i64); absent means empty policy and `now = 0`, so the 19 existing vectors are untouched.

- [ ] **Step 1: Extend the vector harness first** (`verifier/tests/vectors.rs`): read `policy`/`now`, build `Verifier`, assert as today; raise the minimum count from 19 to 30; run `cargo test -p mergit-verifier --features test-attestation --test vectors`. Expected: FAIL (count).
- [ ] **Step 2: Generate** by extending `gen_vectors` (gated `required-features = ["forgery-fixture", "test-attestation"]`): each vector breaks exactly one rule. Expected outcomes: `attested_valid` → `valid`; `attested_measurement_not_allowed` → `ATTESTATION_MEASUREMENT`; `attested_key_mismatch` and `attested_document_for_other_key` → `ATTESTATION_KEY_MISMATCH`; `attested_missing_document`, `attested_tampered_document`, `attested_expired`, `attested_empty_policy` → `ATTESTATION_INVALID`; `unattested_with_document`, `attested_under_v0`, `attested_unknown_kind` → `ATTESTATION_UNSUPPORTED`. Run: `cargo run -p mergit-receipt --features forgery-fixture,test-attestation --example gen_vectors -- spec/vectors`.
- [ ] **Step 3: Run** the vectors test with and without `--features test-attestation`. Expected: with the feature all pass; without it, the harness skips vectors whose `"requires": "test-attestation"` and asserts that each skipped vector verifies as `invalid` with `ATTESTATION_UNSUPPORTED` (add this key to the generated JSON), and the existing 19 pass. Confirm `git diff --stat spec/vectors` shows only added files.
- [ ] **Step 4: Hand off.** `git add spec/vectors verifier runtime/receipt && git commit -m "spec: attested test vectors"`.

---

### Task 7: Spec document, schemas, CLI (PR2)

**Files:**
- Create: `spec/receipt-v1.md`, `spec/examples/attested-header.json`, `spec/examples/invalid/attested-header-with-dev-key.json`
- Modify: `spec/schemas/header.json`, `spec/schemas/sealed-receipt.json`, `spec/receipt-v0.md` (one line pointing to v1), `verifier/src/main.rs`, `docs/superpowers/specs/2026-10-31-attestation-slice1-design.md` (base64 → hex)

**Interfaces:**
- CLI: `mergit-verify <bundle.json> --chain-id <id> --registry <addr> [--signer <addr>] [--policy <file>] [--now <unix>]`. Exit 0 for `valid` and `unattested_valid`, 1 invalid, 2 usage. `--policy` reads the `TrustPolicy` JSON; with no policy the policy is empty. With `--now` absent the CLI uses the system clock (the only place the clock is read).

- [ ] **Step 1: Write the failing check.** Add the two examples; run `spec/check.sh`. Expected: FAIL (`attested-header.json` should be valid; the invalid one should be rejected).
- [ ] **Step 2: Update schemas:** `attestation` becomes `oneOf` the unattested object (const kind, `dev_key` required, nothing else) and an attested object (`kind` string not `"unattested"`, `runtime_key` and `measurement` required, no `dev_key`); `version` enum `["mergit-receipt/0","mergit-receipt/1"]`; `sealed-receipt.json` allows optional `attestation_document` (`0x` hex). Run `spec/check.sh`. Expected: all `ok`/`rejected`.
- [ ] **Step 3: Write `spec/receipt-v1.md`:** header union, document placement and exclusion from `body_hash`, key-attestation semantics (once per runtime start; binding via signature), the reason table incl. the three new codes, status rules, policy format, `now`, and the stated limits (nothing attested after slice 1; metering still rests on the provider's usage report). Update the v0 doc with one pointer line.
- [ ] **Step 4: CLI.** Implement `--policy`/`--now`; add a test in `verifier/tests/cli.rs` running the built binary (`env!("CARGO_BIN_EXE_mergit-verify")`) on `attested_valid.json` with the matching policy file → exit 0 and `"status": "valid"`; on the same vector with no `--policy` → exit 1. (Feature-gated by `test-attestation`; the binary is built with the feature only inside this test run via `cargo test -p mergit-verifier --features test-attestation`.)
- [ ] **Step 5: Run** `cargo test --workspace` and `cargo test -p mergit-verifier --features test-attestation`. Expected: pass.
- [ ] **Step 6: Hand off.** `git add spec verifier docs && git commit -m "spec: receipt format v1, schemas and policy-aware verifier CLI"`. This closes PR2.

---

### Task 8: WASM and Python bindings (PR3)

**Files:**
- Modify: `verifier/wasm/src/lib.rs`, `runtime/py/src/lib.rs`, `runtime/py/Cargo.toml` / `verifier/wasm/Cargo.toml` only if a dependency is needed
- Test: `verifier/wasm/tests/native.rs`, `runtime/py/tests/test_binding.py`

**Interfaces:**
- WASM: keep `verify_bundle(...)` unchanged (frontend call site). Add `verify_bundle_with_policy(bundle_json, chain_id, registry, signer, commitment_json, policy_json: String, now: i64) -> Result<String, JsError>` and native `verify_bundle_with_policy_json(..) -> Result<String, String>`.
- Python: `verify(bundle_json, chain_id, registry, signer=None, policy_json=None, now=0)`; the existing 4-argument calls keep working.

- [ ] **Step 1: Write failing tests.** Native WASM test: `without_policy_a_v0_vector_is_unchanged` (`valid_minimal` still `unattested_valid`); `policy_args_parse_errors_are_errors_not_verdicts` (bad policy JSON → `Err`). Python test `test_vectors_verify_as_expected` extended to pass each vector's `policy`/`now` and skip vectors with `"requires": "test-attestation"`, asserting for the skipped ones that status is `invalid` with `ATTESTATION_UNSUPPORTED`. Python test `test_valid_is_unreachable_without_policy`: every vector with no policy never returns `valid`.
- [ ] **Step 2: Run** `cargo test -p mergit-verifier-wasm` and, from `control-plane`, `uv run pytest ../runtime/py/tests -q` (after `uv sync`). Expected: FAIL.
- [ ] **Step 3: Implement** the two bindings as thin wrappers over `Verifier`. Neither crate enables `test-attestation`.
- [ ] **Step 4: Run** the same commands plus `wasm-pack test --node verifier/wasm`. Expected: pass.
- [ ] **Step 5: Hand off.** `git add verifier/wasm runtime/py && git commit -m "bindings: policy-aware verify for WASM and Python"`.

---

### Task 9: Validator treats `valid` like `unattested_valid` (PR3)

**Files:**
- Modify: `evidence/validator/src/lib.rs` (around `report.reasons.iter().any(|r| *r != Reason::Unattested)` and the verdict `match`)
- Test: `evidence/validator/tests/audit.rs`

**Interfaces:**
- Consumes: `Reason::is_informational`, `Status::Valid`.

- [ ] **Step 1: Write failing tests.** `valid_status_maps_like_unattested_valid`: unit-test the verdict mapping function extracted as `fn verdict_for(status: Status, phi_holds: Option<bool>) -> u8` (create it): `(Valid, Some(true)) == PASS`, `(UnattestedValid, Some(true)) == PASS`, `(Valid, Some(false)) == FAIL`, `(Invalid, Some(true)) == INVALID`, `(Valid, None) == FAIL`. `informational_reason_does_not_invalidate`: the invalidation rule uses `!is_informational()`.
- [ ] **Step 2: Run** `cargo test -p mergit-validator`. Expected: FAIL (function missing).
- [ ] **Step 3: Implement** by extracting `verdict_for` and replacing the `!= Reason::Unattested` test with `!r.is_informational()`. Nothing reads `Status::Valid` elsewhere.
- [ ] **Step 4: Run** `cargo test -p mergit-validator` with `DATABASE_URL` set. Expected: pass.
- [ ] **Step 5: Hand off.** `git add evidence/validator && git commit -m "validator: classify informational reasons in one place; valid maps like unattested_valid"`.

---

### Task 10: Frontend label for `valid` (PR3)

**Files:**
- Modify: `frontend/src/verifier/report.ts`
- Test: `frontend/src/verifier/report.test.ts`

**Interfaces:**
- `Report.status` becomes `"valid" | "unattested_valid" | "invalid"`. `describeReport` returns, for `valid`, `{ tone: "ok", label: "Verified, attested by hardware", ... }`; for `unattested_valid` the label stays exactly `"Verified, unattested (development key)"`. New reason texts for the three new codes.

- [ ] **Step 1: Write failing tests:** `valid_is_the_only_status_labelled_attested` (iterate all three statuses; only `valid` label contains "attested by hardware"); `unattested_valid_label_unchanged`; `new_reason_codes_have_plain_language_text`; `invalid_with_attestation_reason_shows_the_reason`.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/verifier/report.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the type and branches. Do not change any other screen: no receipt reaches `valid` yet.
- [ ] **Step 4: Run** `npm run lint && npm run format:check && npx tsc --noEmit && npx vitest run`. Expected: clean, all pass. The e2e suite is unaffected; run `npm run test:e2e -- --project=mock` only if time allows.
- [ ] **Step 5: Hand off.** `git add frontend/src/verifier && git commit -m "frontend: a label for a hardware-attested receipt, unreachable until one exists"`. This closes PR3.

---

## Self-review notes

- **Spec coverage:** format (Tasks 2, 5, 7), verifier checks and status rules (3), policy and `now` (3, 7), test kind and guards (4), v0 unchanged (2, 6 diff check), vectors (6), bindings (8), validator and downstream non-use of `valid` (9), UI (10), CI (1, 4), on-chain allowlist is a proposal only and has no task by design.
- **Known deviation:** the design doc said base64 for the document; this plan uses `0x` hex and Task 7 corrects the doc.
- **Types consistent:** `Verifier::verify(.., now: i64)`, `TrustPolicy(BTreeMap<String, KindPolicy>)`, `Claims { measurement, bound_key }`, reasons `AttestationInvalid | AttestationMeasurement | AttestationKeyMismatch` are used identically in Tasks 3-8.
