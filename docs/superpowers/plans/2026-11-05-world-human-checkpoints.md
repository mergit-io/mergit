# Mergit × World: Human Checkpoints and One-Human Free Trial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the hosted Mergit (mergit.site), (1) give the free trial to one *human*, not one sign-in account, using World IDKit, and (2) require a fresh World ID Agent Pass approval, bound to the exact action, before an agent spends money (plan approval) or writes to a user's repository (opening the PR).

**Architecture:** Everything lives in the existing FastAPI control-plane and React frontend. A new `world` package wraps the two World systems: IDKit (proof → `developer.world.org/api/v4/verify` → nullifier stored once per human) and Agent Pass (OIDC step-up at `auth.world.org` → ID token verified against JWKS → single-use approval row bound to a hash of the action). Gates switch on only when the World settings are present, so an unconfigured deployment and every existing test behave exactly as today.

**Tech Stack:** Python 3.13, FastAPI, psycopg 3 (async pool + plain-SQL migrations), httpx, respx, testcontainers Postgres, PyJWT[crypto], eth-account; React 19 + Vite 8 + TypeScript, `@worldcoin/idkit` 4.6.x, vitest; Caddy on one Hetzner server.

**Spec:** Section 1 below (design). Prize text: https://ethglobal.com/events/mumbai/prizes/world. World docs: https://auth.world.org/docs (Agent Pass), https://docs.world.org/world-id/idkit/integrate (IDKit 4.x).

---

## 0. Team split (two people, three PRs)

| PR | Branch | Owner | Tasks | Merge order |
|---|---|---|---|---|
| 1 Foundation | `feat/world-foundation` | Abhinav (built first, ~1 h) | 1 (settings + migration + empty `routes_world.py` router wired in `app.py` + empty test-helper modules) | first |
| 2 One free trial per human (IDKit) | `feat/world-idkit-trial` from PR 1 | **Person A** | 2, 3, 4, 9; IDKit half of 10; Task 0 IDKit app registration | any order after PR 1 |
| 3 Human yes before the agent acts (Agent Pass) | `feat/world-agent-pass` from PR 1 | **Person B = Abhinav** | 5, 6, 7, 8; Agent Pass half of 10; Task 0 Agent Pass client registration | any order after PR 1 |

Rules that keep the halves apart:
- Settings, the whole schema and both new Python dependencies land in PR 1, so neither half edits `config.py`, `pyproject.toml`, `uv.lock` or adds a migration.
- Test helpers are split: `tests/world_fakes_idkit.py` (A: verify-API respx routes, proof fixtures) and `tests/world_fakes_idp.py` (B: RSA key, JWKS, ID-token minting, token-endpoint routes).
- `routes_world.py` exists after PR 1 with an empty `router`; A adds `GET /config` and `POST /rp-context`, B adds `/approvals/{id}/start`, `/callback`, `/approvals/{id}`. Different functions, trivial merge.
- The HTTP contract in §1.7 is the only interface between the halves. B's frontend never calls A's code and vice versa.
- Deploy (server `WORLD_*` env, Caddy CSP) is done once by whoever merges last; `WORLD_FEEDBACK.md` gets one section per half.

---

## 1. Design (the spec this plan implements)

### 1.1 Why (the trust moments)

| Moment | Today on `main` (`f3c2c2c`) | After |
|---|---|---|
| Free trial: 5 USDC of treasury credits | "Once per person" = once per **sign-in method** (`accounts.credits_forfeited` compares HMACs of GitHub/Google/email in `deleted_methods`). A new GitHub or Google account gets the credits again. | One per **human**: IDKit proof, nullifier stored with `UNIQUE(action, nullifier)` that survives account deletion. |
| Agent spends money: `POST /v0/plans/{id}/approve` | Session cookie only. | Fresh World ID approval (`max_age=0`) bound to the exact plan, agents, budget and funding. |
| Agent writes to your repo: `POST /v0/plans/{id}/open-pr` | Session cookie only. | Fresh World ID approval bound to the plan and the SHA-256 of the exact diff. |

World is **not** a login method. GitHub/Google/email sign-in is unchanged.

### 1.2 Credential choice (judged by the IDKit prize)
- Trial gate uses **Selfie Check** (`selfieCheck`, credential 11) by default: the benefit is small (5 test USDC), it needs no Orb (Orb verification is unavailable in India), lowest friction. Trade-off stated in the README: Selfie Check is "not a strict one-person-one-account guarantee"; a larger benefit would use Proof of Human (Orb). Configurable via `WORLD_TRIAL_PRESET=proof_of_human`.
- Agent Pass approvals accept any verified class (`acr` in `orb`, `orb-face`, `selfie`, `selfie-face`) and require a fresh proof (`"pop"` in `amr`; a passkey alone is not fresh).

### 1.3 Components

| Unit | File | Responsibility |
|---|---|---|
| Settings | `control-plane/mergit_cp/config.py` | World env vars, `world_idkit_enabled`, `world_idp_enabled` |
| Schema | `control-plane/migrations/0023_world.sql` | `world_nullifiers`, `world_links`, `world_approvals` |
| RP signer | `control-plane/mergit_cp/world/rp_sign.py` | IDKit 4.x request signature (no Python SDK exists) |
| IDKit verify | `control-plane/mergit_cp/world/idkit.py` | Forward proof to World, return verified nullifier; claim nullifier |
| IdP client | `control-plane/mergit_cp/world/idp.py` | Authorize URL, code exchange, ID-token verification (JWKS) |
| Approvals | `control-plane/mergit_cp/world/approvals.py` | Action hash, create / record result / consume, human link |
| Routes | `control-plane/mergit_cp/routes_world.py` | `rp-context`, approval start, callback, status |
| Gates | `auth.py` (trial), `routes_plans.py` (approve), `routes_pr.py` (open-pr) | Enforce the above |
| Frontend | `frontend/src/world/*`, `FundingChoice.tsx`, `DraftPlanEditor.tsx`, `usePullRequest.ts`, `api/client.ts` | IDKit widget, approval dialog + popup, retry with approval id |
| Deploy | `deploy/make-controlplane-env.sh`, `deploy/README.md`, `deploy/Caddyfile` | Env vars, CSP |
| Docs | `WORLD_FEEDBACK.md`, `README.md`, `CHANGELOG-mumbai.md` | Prize debrief, before/after |

### 1.4 Data model (migration `0023_world.sql`)

```sql
-- One row per human per IDKit action. No FK cascade: deleting the account must not free the nullifier.
CREATE TABLE world_nullifiers (
    action      text          NOT NULL,
    nullifier   numeric(78,0) NOT NULL,
    user_id     uuid          REFERENCES users ON DELETE SET NULL,
    credential  text          NOT NULL,
    environment text          NOT NULL,
    verified_at timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (action, nullifier)
);
CREATE UNIQUE INDEX world_nullifiers_one_per_user ON world_nullifiers (action, user_id) WHERE user_id IS NOT NULL;

-- The World IdP subject (pairwise `sub`) that approves for an account. One human, one account.
CREATE TABLE world_links (
    user_id   uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    sub       text NOT NULL UNIQUE,
    linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_approvals (
    approval_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('approve_plan', 'open_pr')),
    plan_uuid    uuid NOT NULL,
    action_hash  text NOT NULL,             -- sha256 hex of the canonical action JSON
    summary      jsonb NOT NULL,            -- what the dialog showed the human
    state        text UNIQUE,               -- OIDC state; NULL until /start
    nonce        text,
    code_verifier text,
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'denied', 'failed', 'consumed')),
    reason       text,                      -- why denied/failed (shown to the user, logged)
    sub          text,
    acr          text,
    auth_time    timestamptz,
    jti          text UNIQUE,               -- ID token id: a token approves once
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    decided_at   timestamptz,
    consumed_at  timestamptz
);
CREATE INDEX world_approvals_user ON world_approvals (user_id, created_at DESC);
```

### 1.5 Approval state machine
`pending` → `approved` (valid ID token at callback) → `consumed` (the protected action committed).
`pending` → `denied` (user cancelled `access_denied`, different human, not verified, not fresh) or `failed` (token invalid, World unreachable).
Any non-consumed row past `expires_at` is treated as expired (no background job; checked on read).

### 1.6 Action hash
`action_hash(kind, fields) = sha256(json.dumps({"kind": kind, **fields}, sort_keys=True, separators=(",", ":")))` hex.
- `approve_plan` fields: `plan_uuid`, `agents` (as sent), `funding`, `total_budget_usdc_units` (string).
- `open_pr` fields: `plan_uuid`, `diff_sha256` (sha256 of `combined_diff(changes)`).

### 1.7 HTTP contract
- `GET /v0/world/config` → `{"idkit": {"app_id", "environment", "trial_action", "preset"} | null, "agent_pass": bool}` (public values only).
- `POST /v0/world/rp-context` body `{"action": "<trial_action>"}` → `{"rp_context": {...}}` (signed server-side; principal required).
- `POST /v0/account/trial` body `{"world_proof": <IDKit result>}` when IDKit is enabled; else no body (unchanged).
  - no proof → `428 {"code": "world_proof_required"}`; proof rejected → `403 {"code": "world_proof_rejected", "reason"}`; same human again → `403 "the free credits were already used by this person"`.
- `POST /v0/plans/{id}/approve` and `POST /v0/plans/{id}/open-pr` with optional header `X-World-Approval: <approval_id>`:
  - no/unknown header → `428 {"code": "human_approval_required", "approval_id", "start_url", "expires_at", "summary"}`.
  - approval denied/failed/expired/mismatched/used → `403 {"code": "human_approval_invalid", "reason"}`.
- `GET /v0/world/approvals/{id}/start` → 302 to `https://auth.world.org/api/v1/authorize?...&max_age=0&prompt=login` (sets HttpOnly cookie `mergit_world`, path `/v0/world`).
- `GET /v0/world/callback` → validates, records, then `302` to the SPA route `{public_origin}/world/approved?approval=<id>&status=<status>`, which `postMessage`s `{type: "mergit-world-approval", approval_id, status}` to its opener (same origin) and closes. No inline script is served by the API.
- `GET /v0/world/approvals/{id}` → `{"status", "reason", "expires_at"}` (owner only; for polling when the popup cannot post back).

### 1.8 Security rules
- Client secret and IDKit signing key only in server env; never sent to the browser; browser never sees an ID token.
- Backend decides everything; the frontend only carries an `approval_id`.
- ID token: RS256 only; `iss == WORLD_IDP_ISSUER`; `aud == client_id`; `exp` future; `nonce` equals the row's; `auth_time` ≥ `created_at − 5s` and `now − auth_time ≤ 120s`; `acr` in allowlist; `"pop" in amr`; `jti` unused.
- Approval: same user, same `kind`, same `plan_uuid`, recomputed `action_hash` equal, `status == approved`, not expired, consumed **inside the transaction that performs the action**.
- First approval links `sub` to the account (`world_links`); later approvals must present the same `sub`; a `sub` linked to another account is denied.
- Fail closed: World unreachable or JWKS fetch fails → `failed`, action not run, `503`-class message.

---

## Global Constraints

- When `WORLD_*` settings are unset, behaviour and every existing test are unchanged (`world_idkit_enabled` / `world_idp_enabled` false).
- Approval TTL `WORLD_APPROVAL_TTL_S = 300`; freshness `WORLD_MAX_AUTH_AGE_S = 120`; trial action `WORLD_TRIAL_ACTION = "mergit-free-trial"`.
- IdP issuer `https://auth.world.org` (sandbox `https://sandbox.auth.world.org`); endpoints `/api/v1/authorize`, `/api/v1/token`, `/.well-known/jwks.json`; `scope=openid`; PKCE `S256`; `response_type=code`.
- Register the IdP client with **`client_secret_post`** (Mergit's `_exchange` sends the secret in the body; World's method cannot be changed after registration).
- Callback URL registered exactly: `https://mergit.site/v0/world/callback` (built from `Settings.public_origin`).
- IDKit verify: `POST {WORLD_VERIFY_BASE}/api/v4/verify/{WORLD_RP_ID}` with the IDKit result forwarded unchanged; require `success == true` and `environment == WORLD_ENVIRONMENT`.
- Python: ruff + pyright strict clean; Postgres tests marked `@pytest.mark.postgres`; World HTTP mocked with respx; ID tokens signed in tests with a locally generated RSA key.
- Git: branch `feat/world-human-checkpoints` from `origin/main` in a new worktree; GPG-signed commits; **no Co-Authored-By lines**; explicit file paths in `git add` (never `-A`); ask before any push or PR. Main requires PRs.
- Set the new env vars on the server **before** merging (a deploy cannot guard its own install).
- Copy: never call a receipt "attested" because of World; World approves *actions*, not runtimes.

## Review Focus

1. **Approval created inside a transaction that then raises 428** → rolled back, the popup finds no row. Create approval rows on their own connection/transaction. Test: `test_approve_without_header_persists_the_approval_row` (Task 6).
2. **Approval reused for a different plan or a changed request** (approve 2 USDC, send 5; or the diff changed after approval) → must be 403 `action_mismatch`. Tests in Task 6 and Task 7.
3. **World or JWKS unreachable / malformed token** → must fail closed, never approve. Tests `test_callback_fails_closed_when_jwks_is_unreachable`, `test_callback_rejects_hs256_and_none_alg` (Task 5).
4. **Popup blocked or closed** → the user must see "nothing was done" and be able to retry; the action must not run. Test `withHumanApproval rejects when the popup cannot open` (Task 8).
5. **Same human, deleted and recreated account** → trial refused although `deleted_methods` has no match. Test `test_trial_refused_for_same_nullifier_after_account_deletion` (Task 3).

---

## File Structure

```
control-plane/
  migrations/0023_world.sql                 (new)  schema §1.4
  mergit_cp/config.py                       (mod)  World settings + flags
  mergit_cp/world/__init__.py               (new)
  mergit_cp/world/rp_sign.py                (new)  IDKit RP signature
  mergit_cp/world/idkit.py                  (new)  verify proof, claim nullifier
  mergit_cp/world/idp.py                    (new)  OIDC authorize/exchange/verify
  mergit_cp/world/approvals.py              (new)  action hash + approval lifecycle
  mergit_cp/routes_world.py                 (new)  /v0/world/*
  mergit_cp/oauth.py                        (mod)  extract pkce_pair() for reuse
  mergit_cp/auth.py                         (mod)  trial gate
  mergit_cp/routes_plans.py                 (mod)  approve gate
  mergit_cp/routes_pr.py                    (mod)  open-pr gate (async route)
  mergit_cp/app.py                          (mod)  include router, wire gates
  pyproject.toml                            (mod)  PyJWT[crypto], eth-account
  tests/world_fakes_idkit.py                (new)  verify-API respx routes, proofs (Person A)
  tests/world_fakes_idp.py                  (new)  RSA key, JWKS, token minting (Person B)
  tests/fixtures/world_rp_vectors.json      (new)  copied from World's signature spec
  tests/test_world_rp_sign.py, test_world_idkit.py, test_world_trial.py,
  tests/test_world_idp.py, test_world_approvals.py, test_world_routes.py,
  tests/test_world_approve_gate.py, test_world_pr_gate.py   (new)
frontend/
  package.json                              (mod)  @worldcoin/idkit 4.6.x
  src/world/api.ts                          (new)  config, rp-context, approval status
  src/world/humanApproval.ts (+ .test.ts)   (new)  428 → dialog → popup → retry
  src/world/HumanApprovalDialog.tsx         (new)  shows exactly what is approved
  src/world/TrialVerify.tsx                 (new)  IDKit widget for the trial
  src/api/client.ts                         (mod)  ApiError.detail, approval header
  src/auth/accountApi.ts                    (mod)  startTrial(proof?)
  src/auth/FundingChoice.tsx                (mod)  trial → TrialVerify
  src/screens/live/run/DraftPlanEditor.tsx  (mod)  approve via withHumanApproval
  src/api/usePullRequest.ts                 (mod)  open-pr via withHumanApproval
deploy/make-controlplane-env.sh, deploy/README.md, deploy/Caddyfile   (mod)
WORLD_FEEDBACK.md, CHANGELOG-mumbai.md, README.md                      (new/mod)
```

---

### Task 0: Branch, accounts, and the facts only World can answer

**Files:** none in the repo; notes go into `WORLD_FEEDBACK.md` in Task 10.

- [ ] **Step 1:** `git -C /data/Projects/mergit-io/mergit-main fetch origin && git -C /data/Projects/mergit-io/mergit-main worktree add -b feat/world-human-checkpoints /data/Projects/mergit-io/mergit-world origin/main`. Record the start time (debrief "time to first success").
- [ ] **Step 2:** At the World booth, get answers to: (a) how to complete a mocked proof for IDKit (`staging` + simulator vs `sandbox`) and for Agent Pass; (b) whether a personal Google account can register at `auth.world.org/portal`; (c) whether IDKit 4.x nullifiers are stable per human per action (needed for the trial gate); (d) whether one project can win both Agent Pass and IDKit; (e) whether `sybil_score` is returned by `/api/v4/verify`. Write the answers down.
- [ ] **Step 3:** Register the IDKit app at `developer.world.org`: create action `mergit-free-trial` with max verifications **1**; save `app_id`, `rp_id`, `signing_key` (shown once) into the password manager.
- [ ] **Step 4:** Register the Agent Pass client at `auth.world.org/portal`: redirect URI `https://mergit.site/v0/world/callback`, client auth `client_secret_post`; save `client_id` and the `worldidp_client_secret_…` secret.
- [ ] **Step 5:** Smoke-test by hand: open `https://auth.world.org/api/v1/authorize?client_id=…&redirect_uri=…&response_type=code&scope=openid&state=x&nonce=y&code_challenge=…&code_challenge_method=S256&max_age=0` and confirm World shows its approval screen. Record the time of first success.

### Task 1: Settings, schema and the shared skeleton (PR 1, foundation)

**Files:**

- Modify: `control-plane/mergit_cp/config.py` (after `oauth_state_ttl_s`, ~line 123; properties next to `github_enabled`, ~line 172)
- Create: `control-plane/migrations/0023_world.sql` (exactly §1.4)
- Create: `control-plane/mergit_cp/world/__init__.py` (empty package), `control-plane/mergit_cp/routes_world.py` (docstring + `router = APIRouter(prefix="/v0/world", tags=["world"])`, no routes), include it in `app.py` next to `oauth.router` (~line 116)
- Create: `control-plane/tests/world_fakes_idkit.py`, `control-plane/tests/world_fakes_idp.py` (module docstrings only; each half fills its own)
- Modify: `control-plane/pyproject.toml` + `control-plane/uv.lock`: add `eth-account>=0.13` (Person A, Task 2) and `PyJWT[crypto]>=2.9` (Person B, Task 5) here, so neither half touches the lock file
- Copy this plan to `docs/superpowers/plans/2026-11-05-world-human-checkpoints.md`
- Test: `control-plane/tests/test_world_settings.py`

**Interfaces — Produces:**

- `Settings.world_app_id: str | None`, `world_rp_id: str | None`, `world_signing_key: SecretStr | None`, `world_environment: Literal["production", "staging", "sandbox"] = "production"`, `world_verify_base: str = "https://developer.world.org"`, `world_trial_action: str = "mergit-free-trial"`, `world_trial_preset: Literal["selfie_check", "proof_of_human"] = "selfie_check"`, `world_max_sybil_score: int | None = None`
- `Settings.world_idp_issuer: str = "https://auth.world.org"`, `world_idp_client_id: str | None`, `world_idp_client_secret: SecretStr | None`, `world_approval_ttl_s: int = 300`, `world_max_auth_age_s: int = 120`
- `Settings.world_idkit_enabled -> bool` (app_id, rp_id and signing_key all set); `Settings.world_idp_enabled -> bool` (client id and secret set)

- [ ] **Step 1: Write the failing tests**
```python
def test_world_is_off_unless_every_value_is_set(settings: Settings) -> None:
    assert not settings.world_idkit_enabled and not settings.world_idp_enabled
    on = settings.model_copy(update={"world_app_id": "app_x", "world_rp_id": "rp_x",
                                     "world_signing_key": SecretStr("11" * 32)})
    assert on.world_idkit_enabled and not on.world_idp_enabled

@pytest.mark.postgres
def test_migration_creates_the_world_tables(client: TestClient, database_url: str) -> None:
    # world_nullifiers PK (action, nullifier); world_links.sub unique; world_approvals.jti unique
    ...  # query information_schema and assert the three tables and constraints exist
```
- [ ] **Step 2:** Run `cd control-plane && rtk proxy ".venv/bin/python -m pytest -q -m 'postgres or not postgres' tests/test_world_settings.py"` → FAIL (attributes missing).
- [ ] **Step 3:** Add the fields and two properties; blank env values must map to unset like the existing `_blank_is_unset` validator. Add the migration file.
- [ ] **Step 4:** Re-run → PASS. Also run the full suite `rtk proxy ".venv/bin/python -m pytest -q -m 'postgres or not postgres'"` → all green (World off by default).
- [ ] **Step 5:** `git add control-plane/mergit_cp/config.py control-plane/migrations/0023_world.sql control-plane/tests/test_world_settings.py && git commit -S -m "control-plane: World settings and schema (off unless configured)"`

### Task 2: IDKit RP signature (no Python SDK)

**Files:**

- Create: `control-plane/mergit_cp/world/rp_sign.py` (the `world` package exists from Task 1)
- Create: `control-plane/tests/fixtures/world_rp_vectors.json` — copy every test vector from https://docs.world.org/world-id/idkit/signatures verbatim
- Test: `control-plane/tests/test_world_rp_sign.py`

**Interfaces — Produces:**

- `@dataclass(frozen=True) class RpContext: sig: str; nonce: str; created_at: int; expires_at: int` with `to_json() -> dict[str, str | int]` matching IDKit's `rp_context` field names
- `sign_rp_request(signing_key_hex: str, action: str, *, now: int, nonce: str | None = None, ttl_s: int = 300) -> RpContext`

- [ ] **Step 1: Write the failing test**
```python
VECTORS = json.loads((Path(__file__).parent / "fixtures/world_rp_vectors.json").read_text())

@pytest.mark.parametrize("v", VECTORS, ids=lambda v: v["name"])
def test_signature_matches_worlds_vectors(v: dict[str, Any]) -> None:
    ctx = sign_rp_request(v["signing_key"], v["action"], now=v["created_at"], nonce=v["nonce"])
    assert ctx.sig == v["expected_sig"]
    assert ctx.expires_at == v["created_at"] + 300

def test_a_fresh_nonce_each_call() -> None:
    a = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    b = sign_rp_request("11" * 32, "mergit-free-trial", now=1_700_000_000)
    assert a.nonce != b.nonce
```
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement per the spec page: Keccak-256 of the spec's message layout, EIP-191 prefix, secp256k1 recoverable signature via `eth_account.Account.sign_message` / `eth_keys`; 32-byte random nonce via `secrets`. Match the vectors exactly (field encoding is whatever the vectors pin).
- [ ] **Step 4:** Run → PASS. Break one byte of the message layout and confirm the vector test fails, then restore.
- [ ] **Step 5:** Commit `control-plane: IDKit 4.x request signing (checked against World's vectors)`.

### Task 3: IDKit verification and the one-human trial gate

**Files:**

- Create: `control-plane/mergit_cp/world/idkit.py`
- Modify: `control-plane/mergit_cp/auth.py:309-317` (`start_trial`), `control-plane/mergit_cp/routes_plans.py:285-290` (credits funding check)
- Fill: `control-plane/tests/world_fakes_idkit.py` (respx route for verify, proof fixtures); tests `test_world_idkit.py`, `test_world_trial.py`

**Interfaces:**

- Consumes: Task 1 settings; Task 2 not needed here.
- Produces:

  - `@dataclass(frozen=True) class VerifiedProof: nullifier: int; credential: str; environment: str; sybil_score: int | None`
  - `class ProofRejected(Exception): reason: str` (`"world_rejected"`, `"wrong_environment"`, `"wrong_action"`, `"sybil_score"`, `"world_unreachable"`)
  - `async def verify_proof(settings: Settings, http: httpx.AsyncClient, proof: dict[str, Any], *, action: str) -> VerifiedProof`
  - `async def claim_nullifier(conn: AsyncConnection, action: str, proof: VerifiedProof, user_id: UUID) -> bool` (False when already claimed)
  - `async def has_claimed(conn: AsyncConnection, action: str, user_id: UUID) -> bool`
  - `class TrialBody(BaseModel): world_proof: dict[str, Any] | None = None` in `auth.py`

- [ ] **Step 1: Write the failing tests**
```python
# test_world_idkit.py (respx)
async def test_verify_forwards_the_proof_unchanged_and_returns_the_nullifier(world_settings) -> None: ...
    # respx asserts the request JSON == the proof dict byte-for-byte; returns {"success": True, "environment": "staging", ...}
async def test_verify_rejects_success_false_and_wrong_environment(world_settings) -> None: ...
async def test_verify_is_rejected_when_world_is_unreachable(world_settings) -> None: ...  # reason == "world_unreachable"

# test_world_trial.py (postgres)
def test_trial_needs_a_world_proof_when_idkit_is_on(world_client) -> None:
    assert world_client.post("/v0/account/trial").status_code == 428
def test_trial_starts_with_a_valid_proof(world_client) -> None: ...            # 200, users.trial_started_at set
def test_same_human_on_a_second_account_is_refused(world_client) -> None:      # same nullifier, other user → 403
    ...  # detail == "the free credits were already used by this person"
def test_trial_refused_for_same_nullifier_after_account_deletion(world_client) -> None: ...  # Review Focus 5
def test_cancelled_verification_leaves_the_trial_unstarted(world_client) -> None: ...        # 428, trial_started_at NULL
def test_credits_funding_requires_a_claimed_nullifier(world_client) -> None: ...              # approve funding=credits → 403
def test_trial_is_unchanged_when_world_is_off(client) -> None: ...                           # existing behaviour
```
- [ ] **Step 2:** Run `-m postgres tests/test_world_trial.py` and `tests/test_world_idkit.py` → FAIL.
- [ ] **Step 3:** Implement `verify_proof` (POST `{world_verify_base}/api/v4/verify/{world_rp_id}`, timeout 10s, the proof as JSON unchanged; check `success`, `environment`, action; take `nullifier` from the proof's response item; parse as int; enforce `world_max_sybil_score` only if set and the field is present). Implement `claim_nullifier` as `INSERT ... ON CONFLICT DO NOTHING RETURNING 1`. In `start_trial`: when `settings.world_idkit_enabled`, require `body.world_proof` (428 `world_proof_required`), verify (403 `world_proof_rejected` with reason), claim in the **same transaction** as `accounts.start_trial` (conflict → the existing 403 message). In `approve_plan` (credits funding) add `or (settings.world_idkit_enabled and not await has_claimed(...))` → same 403.
- [ ] **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5:** Commit `control-plane: free trial is once per human (World IDKit nullifier)`.

### Task 4: `rp-context` and `config` routes

**Files:** Extend `control-plane/mergit_cp/routes_world.py` (created empty and already wired in Task 1); test `control-plane/tests/test_world_routes.py`.

**Interfaces — Produces:** `router = APIRouter(prefix="/v0/world", tags=["world"])` with `GET /config` and `POST /rp-context` (§1.7). `rp-context` accepts only `settings.world_trial_action`; requires a signed-in principal.

- [ ] **Step 1: Tests:** `test_config_exposes_only_public_values` (no signing key, no client secret anywhere in the JSON — assert by substring); `test_rp_context_needs_a_session` (401); `test_rp_context_refuses_unknown_actions` (422); `test_rp_context_is_signed_for_the_trial_action` (verify with `eth_account.Account.recover_message` against the key's address).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `control-plane: World config and IDKit rp-context routes`.

### Task 5: Agent Pass OIDC client and ID-token verification

**Files:** Create `control-plane/mergit_cp/world/idp.py`; modify `control-plane/mergit_cp/oauth.py` (extract `pkce_pair() -> tuple[str, str]` from `start`, lines ~121-123, and use it there); tests `test_world_idp.py` (`PyJWT[crypto]` is already a dependency from Task 1); fakes in `tests/world_fakes_idp.py` (`rsa_key()`, `jwks_json()`, `mint_id_token(**claims) -> str`, `respx_world_idp(router, token)`).

**Interfaces — Produces:**

- `def authorize_url(settings: Settings, *, state: str, nonce: str, code_challenge: str) -> str` — includes `response_type=code`, `scope=openid`, `max_age=0`, `prompt=login`, `code_challenge_method=S256`, `redirect_uri={public_origin}/v0/world/callback`.
- `async def exchange_code(settings: Settings, http: httpx.AsyncClient, code: str, verifier: str) -> str` (returns the `id_token`; `client_secret_post`).
- `@dataclass(frozen=True) class IdClaims: sub: str; auth_time: int; acr: str | None; amr: tuple[str, ...]; jti: str; nonce: str`
- `class TokenInvalid(Exception): reason: str`
- `class JwksCache` with `async def key_for(kid: str) -> jwt.PyJWK` (fetch `{issuer}/.well-known/jwks.json`, cache 10 min, refetch once on unknown `kid`).
- `async def verify_id_token(settings: Settings, jwks: JwksCache, token: str, *, now: int) -> IdClaims` — checks of §1.8 that do not need the DB (alg, iss, aud, exp, signature).

- [ ] **Step 1: Tests:** `test_authorize_url_forces_fresh_login`; `test_exchange_posts_the_secret_in_the_body` (respx asserts form fields); `test_valid_token_returns_claims`; `test_callback_rejects_hs256_and_none_alg` (Review Focus 3); `test_wrong_issuer_audience_or_expired_is_rejected` (parametrized); `test_unknown_kid_refetches_jwks_once`; `test_callback_fails_closed_when_jwks_is_unreachable` (`TokenInvalid("jwks_unreachable")`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `jwt.decode(token, key, algorithms=["RS256"], audience=client_id, issuer=issuer, leeway=60)`. **Step 4:** Run → PASS; existing GitHub/Google OAuth tests still green after the `pkce_pair` extraction.
- [ ] **Step 5:** Commit `control-plane: World Agent Pass OIDC client with JWKS-verified ID tokens`.

### Task 6: Approval lifecycle, callback, and the plan-approval gate

**Files:** Create `control-plane/mergit_cp/world/approvals.py`; extend `routes_world.py` (start, callback, status); modify `routes_plans.py:236-300` (`approve_plan` signature gains `x_world_approval: Annotated[UUID | None, Header()] = None`); tests `test_world_approvals.py`, `test_world_approve_gate.py`.

**Interfaces — Produces:**

- `def action_hash(kind: Literal["approve_plan", "open_pr"], fields: dict[str, Any]) -> str` (§1.6)
- `@dataclass(frozen=True) class PendingApproval: approval_id: UUID; expires_at: datetime; summary: dict[str, Any]` with `def required_error(self) -> HTTPException` (428 body of §1.7, `start_url=f"/v0/world/approvals/{id}/start"`)
- `async def create_approval(pool: Pool, settings: Settings, *, user_id: UUID, kind: str, plan_uuid: UUID, fields: dict[str, Any], summary: dict[str, Any]) -> PendingApproval` — **own connection and transaction** (Review Focus 1)
- `async def begin(conn, approval_id: UUID, user_id: UUID) -> tuple[str, str, str]` (state, nonce, verifier; sets them on a pending, unexpired row; else raises `ApprovalInvalid`)
- `async def record(conn, state: str, claims: IdClaims | None, error: str | None, settings: Settings, now: datetime) -> tuple[UUID, str]` (approval id, status) — applies §1.8: nonce, freshness, acr allowlist, `"pop"` in amr, jti unused, `world_links` link-or-match.
- `async def consume(conn, approval_id: UUID, *, user_id: UUID, kind: str, plan_uuid: UUID, fields: dict[str, Any], now: datetime) -> None` — `UPDATE ... SET status='consumed' WHERE status='approved' AND expires_at > now AND action_hash = %s ... RETURNING`; else `ApprovalInvalid(reason)` with reasons `expired | denied | failed | used | action_mismatch | not_yours`.
- `class ApprovalInvalid(Exception): reason: str` → mapped to 403 `human_approval_invalid`.

- [ ] **Step 1: Tests (postgres + respx + minted tokens):**
  - `test_approve_without_header_persists_the_approval_row` (428; row exists after the request although the approve transaction rolled back)
  - `test_full_journey_approves_and_funds_the_plan` (428 → `/start` 302 with state/nonce → callback with minted token → status `approved` → approve with header → 200, `plan.approved` event enqueued, approval `consumed`)
  - `test_cancel_at_world_denies_and_nothing_is_funded` (`?error=access_denied` → `denied`; approve with header → 403, plan still `draft`)
  - `test_expired_approval_is_refused`; `test_reused_approval_is_refused` (`used`)
  - `test_changed_budget_after_approval_is_refused` (`action_mismatch`, Review Focus 2)
  - `test_approval_for_another_plan_is_refused`; `test_someone_elses_approval_is_refused` (`not_yours`)
  - `test_a_different_human_cannot_approve` (sub ≠ linked sub → `denied`)
  - `test_world_id_linked_to_another_account_is_denied`
  - `test_stale_auth_time_and_missing_pop_are_denied` (parametrized)
  - `test_replayed_id_token_is_denied` (jti)
  - `test_callback_without_the_state_cookie_is_rejected`
  - `test_gate_is_off_when_agent_pass_is_not_configured` (existing approve tests unchanged)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The callback ends with `RedirectResponse(f"{settings.public_origin}/world/approved?approval={id}&status={status}", 302)` (the SPA route is Task 8). The gate in `approve_plan` runs after `problems` are computed and `total` is known: no header → `create_approval(...)` then `raise pending.required_error()`; header → `await consume(conn, ...)` inside the existing transaction before `plans.approve`.
- [ ] **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5:** Commit `control-plane: fresh World ID approval before an agent spends (plan approval)`.

### Task 7: The open-PR gate

**Files:** Modify `control-plane/mergit_cp/routes_pr.py` (`build_router` gains `approval_gate: ApprovalGate | None = None`; `open_pr` becomes `async def` and calls the sync store via `starlette.concurrency.run_in_threadpool`); `app.py:120-122` wires the gate when `settings.world_idp_enabled`; test `test_world_pr_gate.py`.

**Interfaces:**

- Consumes: Task 6 `create_approval`, `consume`, `action_hash`.
- Produces: `class ApprovalGate(Protocol): async def __call__(self, request: Request, *, plan_uuid: str, requester: str, diff_sha256: str, approval_id: str | None) -> None` (raises 428/403 `HTTPException`; returns when the approval was consumed).

- [ ] **Step 1: Tests:** `test_open_pr_needs_a_fresh_approval` (428 with `summary.repo_url` and `summary.diff_sha256`); `test_approved_open_pr_queues_the_request`; `test_diff_changed_after_approval_is_refused` (`action_mismatch`); `test_already_opened_pr_needs_no_new_approval` (existing `done` request → 200 without a gate call); existing `test_pr_routes_mounted.py` unchanged when the gate is `None`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement: after `ready_changes`, if a request already exists and is `done`, return it; else call the gate with `sha256(combined_diff(changes))`, then `store.approve`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `control-plane: fresh World ID approval before an agent opens a PR`.

### Task 8: Frontend — human approval dialog, popup and retry

**Files:** Create `frontend/src/world/api.ts`, `frontend/src/world/humanApproval.ts`, `frontend/src/world/humanApproval.test.ts`, `frontend/src/world/HumanApprovalDialog.tsx`, SPA route `/world/approved` (posts the message, closes); modify `frontend/src/api/client.ts` (`ApiError` keeps the parsed `detail`; `approvePlan(planUuid, body, approvalId?)` and `openPullRequest(planUuid, approvalId?)` send `X-World-Approval`), `DraftPlanEditor.tsx:87`, `usePullRequest.ts:59`.

**Interfaces — Produces:**

- `type ApprovalRequired = { approval_id: string; start_url: string; expires_at: string; summary: Record<string, unknown> }`
- `function approvalRequired(error: unknown): ApprovalRequired | null`
- `async function withHumanApproval<T>(run: (approvalId?: string) => Promise<T>, confirm: (req: ApprovalRequired) => Promise<boolean>): Promise<T>` — calls `run()`; on 428 asks `confirm` (the dialog), opens `start_url` with `window.open` **synchronously inside the click handler path**, waits for `message` `{type:"mergit-world-approval"}` from `location.origin` or polls `GET /v0/world/approvals/{id}` every 2 s until not `pending` or expired; on `approved` calls `run(approval_id)`; otherwise throws `ApiError(403, "World ID approval was not given — nothing was done.")`.

- [ ] **Step 1: vitest:** `approves then retries with the approval id`; `rejects when the popup cannot open` (window.open returns null → message "Your browser blocked the World ID window…", Review Focus 4); `rejects on denied and never retries`; `ignores messages from other origins`; `stops polling at expires_at`.
- [ ] **Step 2:** `cd frontend && npm run test -- src/world/humanApproval.test.ts` → FAIL. **Step 3:** Implement; the dialog lists exactly the summary (plan goal, per-task agent, budget, funding; or repo, branch, files changed) and states "World's screen will not show this — check it here." **Step 4:** PASS; `npm run build` clean.
- [ ] **Step 5:** Commit `frontend: World ID approval before funding a plan or opening a PR`.

### Task 9: Frontend — IDKit on "Start free trial"

**Files:** `frontend/package.json` (`@worldcoin/idkit` ^4.6.0), create `frontend/src/world/TrialVerify.tsx`, modify `frontend/src/auth/accountApi.ts:68` (`startTrial(worldProof?: unknown)` posts `{world_proof}`; maps 428/403 codes to messages), `frontend/src/auth/FundingChoice.tsx:76`.

**Interfaces:** Consumes `GET /v0/world/config`, `POST /v0/world/rp-context`, `POST /v0/account/trial` (Task 3/4).

- [ ] **Step 1: vitest:** `startTrial sends the proof unchanged`; `maps world_proof_rejected and the duplicate-human 403 to plain messages`; `FundingChoice shows the wallet option after a cancelled verification`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `<IDKitRequestWidget app_id action rp_context environment preset={selfieCheck()|proofOfHuman()} handleVerify={(r) => startTrial(r)} onSuccess=…/>`; when `config.idkit` is null keep today's button. **Step 4:** PASS; `npm run build`.
- [ ] **Step 5:** Commit `frontend: verify one human with World ID before the free trial`.

### Task 10: Deploy, hosted verification, debrief and submission docs

**Files:** `deploy/make-controlplane-env.sh` and `deploy/README.md` (new `WORLD_*` vars), `deploy/Caddyfile` CSP `connect-src` += `https://developer.world.org https://auth.world.org https://bridge.worldcoin.org`, `WORLD_FEEDBACK.md`, `CHANGELOG-mumbai.md`, `README.md` ("World integration — added at ETHGlobal Mumbai": before/after, credential choice, failure paths, starting commit `f3c2c2c`).

- [ ] **Step 1:** Put the `WORLD_*` values on the server env **before** merging; restart; `GET https://mergit.site/v0/world/config` shows `idkit` and `agent_pass: true`.
- [ ] **Step 2:** On mergit.site with mocked proofs, run and screen-record: trial success; same human second account refused; approve plan → World → funded; cancel at World → not funded; open PR approved; changed diff refused. Take screenshots of each UI state (Playwright headless) and check them.
- [ ] **Step 3:** Write `WORLD_FEEDBACK.md`: time to first success (Task 0 timestamps), friction (no `binding_message`; prod discovery lists only `orb` acr; mocked-proof path undocumented; HTTPS-only callbacks; client auth fixed at registration; no Python IDKit SDK; staging vs sandbox naming), missing capability, the single highest-impact improvement.
- [ ] **Step 4:** Ask the user before pushing; open the PR against `main` with the before/after and the demo checklist; merge only when told.
- [ ] **Step 5:** Submission text for all four World prizes (Agent Pass, Agent Pass Continuity, IDKit, IDKit Continuity) referencing the README section and the demo timestamps.

### Task 11 (stretch, only if Tasks 0–10 are done): agent-initiated approval
When a running plan would exceed its remaining budget, the worker asks for approval through the Device Authorization Grant (`/api/v1/device_authorization`, poll `/api/v1/token`, stop on `access_denied`/`expired_token`, `slow_down` +5 s, 20-minute expiry), shows `user_code`/`verification_uri_complete` on the run page, and pauses the task until approved. Same `world_approvals` table with `kind='budget_raise'` (add to the CHECK in a new migration).

---

## Timeline (one person, ~48 h)

| Window | Tasks |
|---|---|
| Day 1 evening (Nov 5) | 0, 1, 2 |
| Day 2 morning | 3, 4 |
| Day 2 afternoon/evening | 5, 6 |
| Day 3 morning (Nov 6–7) | 7, 8, 9 |
| Before submission | 10 (deploy, recording, debrief, PR) |

## Cost
World services $0 (no current fee schedule; proofs mocked during the event); hosting $0 extra (existing Hetzner + Caddy HTTPS on mergit.site); only shared cost is agent inference for demo runs (~$26 with `deepseek-v4-flash` default and a $30 OpenRouter key cap).
