# Attestation, slice 1: the format and the verifier, before any hardware

**Status:** draft for approval. Scope: PRD §14 **P1** (attestation), first slice only.
**Source of truth:** the paper (§5.2 assumption 1, §6, §12.5) and PRD §7 (R2). Where this document disagrees
with them, they win and the conflict is raised on `mergit-research`.

## Why

Every receipt today says `attestation.kind = "unattested"` with a development key. The verifier can return
`unattested_valid` at best and has no `valid` outcome. P1 is done when *a receipt's attestation verifies
against the vendor's root of trust*. That needs real TEE hardware, and the project has no budget for it now.

Most of P1 does not need hardware: the receipt format that carries an attestation, the verifier that checks
one, the trust policy, and the tests proving a forged "attested" claim is refused. That is slice 1. It is
built so a real vendor document can be dropped in later without changing the format.

## What slice 1 does *not* do

Stated first, because over-claiming is the failure this project is about.

- **It does not attest anything.** No receipt produced after slice 1 is attested. The product, docs and UI
  keep saying "unattested (development key)" until a verified vendor document exists. **P1 is not done** after
  this slice and nothing may say it is.
- No vendor-specific document parsing (Nitro, SEV-SNP, TDX). That is slice 2 and depends on open question Q2.
- No enclave runner, no measured image build, no key generation inside a TEE. That is slice 3 and needs
  hardware.
- No contract changes. Section "On-chain allowlist" below is a proposal for `mergit-contracts`, not code.
- Attestation proves which code ran. It does not prove a model provider's usage report was honest, so metering
  remains only as sound as that report (paper assumption 5). Docs say so.

## Goals

1. A receipt format that can carry a vendor attestation and bind it to the runtime key and to *this* receipt.
2. A verifier with a `valid` outcome that **no code path can reach without a verified document**.
3. A trust policy (which vendor roots, which measurements are accepted) that is an explicit input to
   verification, never a default that trusts everything.
4. Existing v0 vectors, receipts and behaviour unchanged.
5. Tests that assert the guards fire (forged claim, wrong measurement, key mismatch, a document issued for another
   runtime key, test-only kind in a production build), not just that a good document passes.

## Anti-goals (would make this a failure even if tests pass)

- Any path that displays or returns `valid` for a receipt whose document was not verified against a vendor
  root *and* a measurement the policy allows.
- A "test attestation" that can be enabled in a production binary, the WASM verifier or a deployed image.
- Silently weakening v0: an unattested receipt must still verify as `unattested_valid`, never `valid`.

## Design

### Receipt format (version 1, additive)

`mergit-receipt/0` is unchanged. Attested receipts use `version = "mergit-receipt/1"`. A verifier rejects an
attested kind under version 0 and an unknown kind under any version (`ATTESTATION_UNSUPPORTED`, as today).

Header `attestation` becomes a tagged union on `kind`:

```
{ "kind": "unattested", "dev_key": <address> }                       // unchanged
{ "kind": "<vendor>",   "runtime_key": <address>, "measurement": <hex> }   // version 1 only
```

`runtime_key` and `measurement` are the receipt's *claims*. The header is hashed into `h_0`, so the claims are
inside the commitment.

The sealed receipt gains an optional `attestation_document` (base64 bytes), beside `signature` and excluded
from `body_hash` the same way. It is a **key attestation**: the vendor's signed statement that code with
`measurement` is running and holds `runtime_key` (the document's public-key field). It is produced once when
the runtime starts and attached to every receipt that runtime seals.

The receipt is bound to that key by what already binds it: the EIP-712 signature must recover to
`runtime_key`, and only the attested runtime holds the private half. No per-receipt digest goes into the
document, so there is no second artifact and no per-receipt vendor call. A document from another runtime
fails the key check; a stale document is handled by the measurement allowlist, which is how a bad build is
revoked.

### Verifier

A per-kind interface, implemented by slice 2 for real vendors:

```
verify_document(document, policy, now) -> Result<Claims { measurement, bound_key }, DocError>
```

`now` is an explicit argument (RFC 3339), never read from the clock, so Rust, Python and WASM agree and
vectors are reproducible. Certificate validity windows are checked against it. There is no other freshness
rule: a document is valid for as long as its certificates are and its measurement stays allowed.

The core then checks, collecting every failing reason as today:

| Check | Reason on failure |
| --- | --- |
| Document does not verify against the kind's root of trust at `now` | `ATTESTATION_INVALID` |
| Attested kind but `attestation_document` absent | `ATTESTATION_INVALID` |
| `Claims.measurement` differs from the header's, or is not in the policy allowlist for that kind | `ATTESTATION_MEASUREMENT` |
| `Claims.bound_key` differs from the header's `runtime_key`, or the signature does not recover to it | `ATTESTATION_KEY_MISMATCH` |
| Kind present but no verifier compiled in, or an attested kind under version 0 | `ATTESTATION_UNSUPPORTED` |
| `kind = unattested` carrying an `attestation_document`, or `unattested` under version 1 | `ATTESTATION_UNSUPPORTED` |

When several apply, every one is reported. A document that fails verification reports `ATTESTATION_INVALID`
only (its claims cannot be trusted enough to compare), so the truth table has no case where an unverified
document yields measurement or key reasons.

Status rules (the guard this slice exists to establish):

- `valid` **only if** no reason other than informational ones is present *and* a document verified *and* the
  policy accepted the measurement. A policy with an empty allowlist can never produce `valid`.
- A receipt with no document (v0, or `unattested`) and no failing reason stays `unattested_valid`.
- A receipt that claims an attested kind but whose document fails is `invalid`: a false claim of attestation
  is a bad receipt, not a merely unattested one.
- `UNATTESTED` stays the informational reason on receipts without a verified document.
- Reasons are classified informational vs failing in one place (`Reason::is_informational`) so the validator
  and clients cannot disagree about what makes a receipt invalid.
- **Nothing downstream keys off `valid` in this slice.** The validator maps `valid` and `unattested_valid`
  identically (pass or fail on Φ). Reputation and routing do not exist yet; when they do, using `valid`
  as an input is a separate decision.

`TrustPolicy` is required and is per kind: `{ "<kind>": { "roots": [<DER, base64>], "measurements": [<hex>] } }`.
Roots are inline certificates, not fingerprints, so a policy file is self-contained. The CLI reads it from a
file (`--policy`); the WASM verifier takes it from the host page; the validator reads a file named in its
config. **With no policy configured the policy is empty**, so an attested receipt can never be `valid`
(a document cannot verify against no roots). There is no "trust everything" default.

### Test-only attestation kind

Without hardware, the machinery needs something to test against. A kind `"test-ed25519"` exists only behind a
cargo feature `test-attestation`, modelled on the existing `forgery-fixture` feature: a document signed by a
fixed test key, with a fixed test root.

Guards:

- Format: a small JSON object `{runtime_key, measurement, signature}` where `signature` is an ed25519
  signature, by a fixed test root key, over `JCS({runtime_key, measurement})`. It carries the Ethereum
  `runtime_key` as a plain field. It deliberately does not imitate any vendor's container (CBOR/COSE, X.509):
  slice 2 writes its own parser and reuses nothing from this.
- The feature is off by default and is not enabled by any service, binding, image or the WASM build.
- With the feature off, `"test-ed25519"` is an unknown kind: `ATTESTATION_UNSUPPORTED` and `invalid`.
- A CI check fails the build if `cargo tree -e features` on any release target (gateway, store, validator,
  verifier CLI, wasm, python binding) shows `test-attestation` enabled.

### Surfaces touched

`spec/` (new `receipt-v1.md`, schemas, types, vectors) · `runtime/receipt` (sealing with a document) ·
`verifier` (checks, status, CLI exit code 0 for `valid` and `unattested_valid`) · `verifier/wasm` and
`runtime/py` (report type gains `valid`) · `evidence/validator` (uses `is_informational`; mapping otherwise
unchanged) · `frontend/src/verifier/report.ts` (a `valid` label exists, reachable only from status `valid`;
default copy unchanged) · a small Rust CI workflow, because none exists today and the feature-off guard is
meaningless without CI.

### Vectors and tests

New vectors generated by the Rust crate under the test feature: valid attested; wrong measurement; key
mismatch; a document issued for another runtime key; missing document; tampered document; `unattested`
carrying a document; attested kind under version 0;
unknown kind; empty-allowlist policy. Rust, Python and WASM must agree on every one, as for v0.

Tests that assert a guard fires carry more weight than the happy path: no combination of inputs reaches
`valid` without a verified document and an allowed measurement; the test kind is rejected with the feature
off; v0 receipts still yield `unattested_valid`.

## On-chain allowlist (proposal only, not in this slice)

PRD §8 says `ReceiptRegistry` stores receipt roots "with attestation reference", and `Identity` stores only a
runtime key. A later change to `mergit-contracts` would add an allowlist of accepted measurements (admin-set
at first) and have the registry or validator reject a commitment whose receipt does not reference an allowed
measurement. It is drafted separately for review and does not block slice 1.

## Open questions

- **Q2 (which TEE):** needed for slice 2, not this slice. Current lean is AWS Nitro Enclaves (simplest to
  verify offline, including in WASM) with a documented path to a second vendor. The paper cites attacks on
  SEV-SNP attestation, which weighs on the choice. Not yet decided.
- **Hardware for slice 3:** no budget at present. Options are trial credits or a short paid rental, decided
  when slice 3 is reached.

## Calls made by the author (change any)

- Version bump to `mergit-receipt/1` for attested kinds rather than widening v0.
- The document is a key attestation made once per runtime start, excluded from `body_hash` (like
  `signature`); receipts are bound to it by the existing signature. I dropped a per-receipt user-data binding
  (and its reason code) because it needs a vendor call per receipt and a second binding to reason about.
  Trade-off: no per-receipt freshness, so revocation relies on the measurement allowlist.
- Verification takes an explicit `now`; there is no other freshness rule.
- Policy is per kind with inline roots; empty by default, so nothing is trusted unless configured.
- Edge cases (missing document, `unattested` with a document) are `invalid` via the reasons in the table.
- Test kind implemented behind a cargo feature, not a runtime flag.
- A Rust CI workflow is included as its own small PR, ahead of the feature work.
- Delivered as separate PRs: (1) Rust CI, (2) spec + types + verifier, (3) bindings, WASM, validator and
  frontend.
