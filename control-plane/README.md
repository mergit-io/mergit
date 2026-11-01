# control-plane

Python side of Mergit v0: planner, task graph, API and the agent worker. Two packages share this project:
the **API** (`mergit_cp/`, plan tasks O1 to O4, O6 and O7) and the **agent worker** (`mergit_worker/`, O5).

## The API

`uvicorn mergit_cp.app:create_app --factory` serves the web app's endpoints. It applies `migrations/` at
start, under an advisory lock, so several instances can start together.

| Endpoint | What it does |
| --- | --- |
| `GET /v0/auth/nonce`, `POST /v0/auth/verify`, `GET /v0/auth/me`, `POST /v0/auth/logout` | Sign-In with Ethereum (EIP-4361). Single-use nonces, server-side sessions in an httpOnly cookie |
| `POST /v0/plans` | `{goal, repo_url, ref, budget_usdc_units, category}`: the planner drafts tasks, each with a Φ. Rate limited per wallet |
| `PATCH /v0/plans/{plan_uuid}` | Replaces the tasks of a draft. Checked exactly like a planner answer |
| `POST /v0/plans/{plan_uuid}/approve` | `{agents: {"<index>": [agent_id, ...]}, funding: "wallet" \| "credits"}`. Fixes each task's `phi_hash` and the agent picks, and sends `plan.approved` |
| `POST /v0/plans/{plan_uuid}/abandon` | Requester gives up on this plan: moves it to `closed` and sends `plan.closed` (O6) |
| `POST /v0/chain-events` | Everything the gateway reports back (spec/events-v0.md). Idempotent on `event_id`; requires `Authorization: Bearer CHAIN_EVENTS_TOKEN` |
| `GET /v0/plans` | The signed-in requester's own plans, summary only |
| `GET /v0/plans/{plan_uuid}` | The plan, its tasks, every attempt (`jobs`) and every money/verdict event concerning it. Requester-only (`403`/`404`) |
| `GET /v0/agents` | `{agent_id, name, model}` for every deployed agent |
| `GET /v0/plans/{plan_uuid}/events` | Server-Sent Events: `plan.state`, `task.state`, `step.recorded`, `verdict`, `money`, as the plan runs |
| `POST /v0/internal/progress` | The worker reports one step; requires `Authorization: Bearer WORKER_TOKEN` |

Amounts are decimal strings of USDC base units everywhere. Only the requester may edit or approve, and only a
draft can change.

| Module | Role |
| --- | --- |
| `auth.py` | Sign-in and the `current_address` dependency every plan route uses |
| `planner.py` | `plan_goal`, `check_tasks` (shared by the planner and edits), planner cost recording |
| `predicates.py` | `check_predicate`: the spec schema plus a guard against commands that cannot fail |
| `llm.py` | Async model adapter for the planner (the worker has its own sync one) |
| `plans.py`, `routes_plans.py` | Plan storage and routes |
| `graph.py` | `ready_tasks`: which indexes may dispatch right now, from dependency and job state alone |
| `dispatch.py` | `dispatch_task` (one attempt), `dispatch_ready` (every index `ready_tasks` names), `record_escrowed` |
| `chain_events.py` | `POST /v0/chain-events`: acts on `plan.funded` and `task.escrowed`, stores the rest for O6 |
| `outcomes.py` | O6: reacts to a finished job (`process_due`), `stuck_indexes` (`needs_requester`), `abandon` |
| `events.py` | Transactional outbox to the gateway: retries, per-plan order, no double send across instances |
| `spec.py` | The JSON Schemas in `spec/schemas`, used to check what this service sends and receives |
| `runs.py`, `routes_runs.py` | The read API: a requester's plans, one plan's full detail, the agent roster |
| `stream.py` | `PlanBroadcaster`: in-process pub/sub from `POST /v0/internal/progress` to the SSE handler |

Events are written in the same transaction as the change they report, then delivered to
`{GATEWAY_URL}/v0/events` with `Authorization: Bearer EVENTS_TOKEN` and `Idempotency-Key`. A 5xx or a network
error is retried with backoff for `EVENT_RETRY_WINDOW_S` (600); any other 4xx stops at once. Both end as a
logged error with the row marked failed.

**Dispatch (plan task O4).** `plan.funded` moves the plan to `funded`, dispatches attempt 1 for every index
with no unmet dependency (`graph.ready_tasks`), and, if anything was dispatched, moves it on to `running`.
Each dispatch records what it asked for in `task_dispatches`, so the matching `task.escrowed` (which carries
only a `task_id`) knows which job to queue. `dispatch_task` and `dispatch_ready` are also the functions O6
(`outcomes.py`) calls directly: a retry (`dispatch_task` with the next agent and `attempt + 1`) and
newly-unblocked dependents after a pass (`dispatch_ready` again) — one rule, never two copies of it. Every
other event type the gateway sends (`verdict.recorded`, `task.released`, `task.returned`, `challenge.*`,
`credits.denied`) is recorded in the money ledger (see O6 below) and nothing acts on it: Φ is the only thing
that moves the task graph.
`CHAIN_EVENTS_TOKEN` is this deployment's own choice: spec/events-v0.md names a token for the other two legs
but not this one, so this is worth confirming with the gateway side before go-live rather than leaving the
endpoint open.

A task that depends on another is dispatched only once its dependency has passed (`ready_tasks`), but the
worker still clones only the plan's base ref (O5) for every job, so a dependent task does not actually see
its dependency's change in its own checkout. That gap sits between O4, O5 and O9 and is flagged on PR #15;
PR #15 has since fixed its side by having the worker apply a dependency's stored patch before a dependent
task runs (once these branches merge, this note can go).

## Accounts and sign-in methods

A user signs in with **GitHub**, **Google**, an **emailed six-digit code** or a **wallet** (SIWE). The first three
create an account; a wallet is optional and is connected afterwards (`POST /v0/auth/wallet/link`). Accounts are never
merged by email: a second method is attached only by the signed-in user asking for it, and an identity that already
belongs to someone else is refused.

| Method | Settings (`deploy/secrets/api.env`) | Callback to register |
|---|---|---|
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `https://<APP_DOMAIN>/v0/auth/github/callback` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://<APP_DOMAIN>/v0/auth/google/callback` |
| Email code | `SMTP_HOST`, `SMTP_FROM`, optional `SMTP_PORT` (587 STARTTLS, 465 TLS), `SMTP_USER`, `SMTP_PASSWORD` | none |

A method is offered only when its settings are complete (`GET /v0/auth/providers` says which), and a blank value
means "not set up". OAuth uses the authorization-code flow with PKCE; the `state` is single use and is also bound to
the browser by an HttpOnly cookie. A code lives ten minutes, allows five wrong guesses, works once, is stored only as
an HMAC, and at most five are sent to one address per hour.

**The free trial.** A user with no wallet acts, on chain, as `trial_address(user_id)`: a hash nobody holds a key for.
Their plans can only be funded from the gateway's free credits (the API refuses `funding: "wallet"`), the gateway's
per-address grant and daily limit become per user, and Escrow refunds Onboarding plans to the treasury, not to that
address. Free-credit work is audited on every task and earns no transferable reputation. Limits: nothing stops one
person making many GitHub or Google accounts to collect more credits; the per-plan cap and the daily limit bound
the cost, and a real fix needs a decision on identity proofing that has not been made. There is no paid tier yet.

**Merging two accounts of one person.** A wallet belongs to one account, or "sign in with this wallet" would be
ambiguous. Linking a wallet that already has its own account is answered with `409`, `code: "wallet_taken"` and a
one-time `merge_token` (five minutes, bound to both accounts and that wallet, stored only as a hash). The person has
then proved both sides: they are signed in to this account and they just signed with that wallet. If they confirm
(`POST /v0/auth/merge`), the other account's wallets, sign-in methods, "Notify me" votes and earliest trial start move
to this one, its runs stay visible (including free-trial runs, whose requester is a hash of the old user id), and the
other account is deleted. It cannot be undone. Nothing moves without the confirmation. Not covered: a GitHub, Google or
email identity that already belongs to another account is still refused (`identity_taken`), not offered for merge.

## Outcomes, retries and escalation (plan task O6)

The worker never calls back into this service with a job's result; it writes it straight to the job's own
row (`jobs.status`, `jobs.phi_holds`), over the database both sides share. `outcomes.process_due` is this
service's side of that handoff: a background loop (`OUTCOME_POLL_S`, default 1s, same shape as the event
sender) claims every job finished and not yet reacted to (`FOR UPDATE SKIP LOCKED`) and, per job:

- `phi_holds = true`: the index passed. Nothing else to write — `graph.py` already reads "passed" straight
  off `jobs.phi_holds`, so a pass needs no second record of itself.
- `phi_holds = false` or `NULL` (Φ could not run at all): dispatch the requester's next agent for this
  index, one attempt higher, if `tasks.agents` has one left and the attempt cap (`MAX_ATTEMPTS`, 3) is not
  reached. `NULL` is treated exactly like `false` here — Φ being inconclusive is never a silent pass.

Either way, `dispatch_ready` is asked what just became dispatchable (the same question O4 asks on
`plan.funded`), and a plan whose every index has passed moves to `done`.

An index that fails its last allowed attempt is `needs_requester` — not a stored state, but
`outcomes.stuck_indexes`' answer, computed from `jobs` and `tasks.agents` on demand: it is exactly the set
`dispatch_ready` will never find ready again on its own. **`POST /v0/plans/{plan_uuid}/abandon`** is the
requester's way out of a stuck plan: moves it to `closed` and sends `plan.closed`, idempotently and without
requiring every index to actually be stuck first — a requester may have other reasons.

### The money ledger (plan task O6, money half)

`verdict.recorded`, `task.released`, `task.returned` (and `receipt.committed`, `challenge.*`,
`credits.denied`) move money and reputation, **never the graph**. `mergit_cp/money.py` turns each into one row of
the append-only `money_events` table (`migrations/0006_money_events.sql`), in the same transaction that stores
the event in `chain_events_seen`, so the raw log and the ledger commit together or not at all.

- **Structured:** typed columns, not JSON: `kind`, `plan_uuid`, `task_id`, `tx` (the transaction hash), and per
  kind `verdict`, `payee` + `amount_usdc_units`, `amount_usdc_units` + `reason`, the challenge fields, or the
  `credits.denied` reason. A `CHECK` makes each kind carry exactly its own fields. Amounts are `numeric(78,0)`
  (a uint256 fits) and are returned as decimal strings; addresses are stored lowercase.
- **Idempotent twice over:** `event_id` is unique (a retried delivery), and so is `(kind, task_id, tx,
  challenge_id)` (the gateway re-reading a log after losing its cursor builds a new envelope for the same
  on-chain event). Either way: one row.
- **Append-only:** a trigger refuses `UPDATE` and `DELETE`. A ledger row is never edited.
- **Honest about what it cannot place:** an event naming a task or plan this service never dispatched has no
  plan to belong to. It is logged and stays only in the raw log; it is not a `500` that the gateway retries for
  ten minutes. A number that does not fit a uint256 is rejected as a malformed event (`400`), not stored.
  `error` events name no plan or task and stay in the raw log.
- **Late events are fine:** a verdict, release or return after the plan is `done` or `closed` is recorded like any
  other. The migration also backfills rows from the existing raw log, so upgrading keeps a plan's history.
- **Never the graph, checked three ways** (`tests/test_money_graph.py`): delivering every money event in every
  job state changes no plan, task, job, dispatch or outbox row; a failed job is retried identically with and
  without money events present (including `task.returned` with reason `fail`); and the ledger module imports
  nothing from `dispatch`, `outcomes`, `graph` or `plans` and writes none of their tables, while none of those
  read the ledger.

## Run API and live stream (plan task O7)

`GET /v0/plans` and `GET /v0/plans/{plan_uuid}` are read-only and requester-scoped. The detail view adds two
things on top of the plan and its tasks:

- **`attempts`**: one row per `jobs` entry (task_id, index, attempt, agent_id, status, `phi_holds`,
  `receipt_root`, `finished_at`). Already a real, structured table from O4/O5, so this is a plain read.
- **`money_events`**: this plan's rows of the money ledger above, oldest first. Each keeps the `{type, at,
  payload}` shape (the payload is the gateway's own fields, rebuilt from the typed columns) and adds `id`,
  `task_id`, `index`, `attempt` and `tx`. Scoped by `plan_uuid`, so one plan never sees another's events.

**`credits.denied` (issue #23) needs no handler, only this read.** It only ever arrives before
`plan.funded` (the gateway tries credits first and sends `plan.funded` only once money actually landed), so
the plan is already sitting exactly where a denied requester needs it: `approved`, not yet funded, free to
fund from a wallet (independent of this service entirely) or close (`POST /v0/plans/{plan_uuid}/abandon`,
plan task O6). The only real gap was the reason going nowhere, and the ledger and the SSE `money` event
now carry it; see `test_credits_denied_carries_its_reason_in_plan_detail` and
`test_credits_denied_streams_as_a_money_event`.

**Plan detail and the stream read the ledger, not `chain_events_seen`.** `runs.py` no longer queries the raw log.

**`GET /v0/plans/{plan_uuid}/events`** (SSE) sends a full snapshot of plan and task state on connect, then:

- `plan.state`, `task.state` and the ledger rows (`verdict` for a verdict, `money` for the rest) are re-read from the database at most every
  `SSE_POLL_S` (1s) and sent only when something changed since the last poll;
- `step.recorded` is relayed the moment the worker posts it to `POST /v0/internal/progress`
  (`{task_id, seq, type, cost}`, found to a plan through `task_dispatches` → `jobs`), with no polling delay.

**The worker does not call `POST /v0/internal/progress` yet.** The endpoint, its auth and the broadcast path
are built and tested (a direct `curl`/test call reaches a connected stream immediately), but nothing in
`mergit_worker/harness.py` posts to it from inside the agent loop. Until that's wired up, `step.recorded`
simply never arrives and a client only ever sees the polled events. Wiring the worker side is a small,
separate change (one HTTP call from `_recorder` in `harness.py`) left for whoever picks it up next, same
spirit as the dependent-task fix above.

`PlanBroadcaster` (`stream.py`) is in-process: a step is only seen by a client connected to the same API
instance the worker happened to reach. Fine for one instance (`O10` as currently planned); a second
instance would need Postgres `LISTEN`/`NOTIFY` or a shared queue, which is out of scope here.

**Configuration** (`mergit_cp/config.py`). Required: `DATABASE_URL`, `APP_DOMAIN`, `SESSION_SECRET` (32+
characters), `GATEWAY_URL`, `STORE_URL`, `AGENTS_FILE`, `PLANNER_MODEL`, `PLANNER_PROVIDER`, `EVENTS_TOKEN`,
`CHAIN_EVENTS_TOKEN`, `WORKER_TOKEN`, plus whichever model key `PLANNER_PROVIDER` needs. Defaults: `CHAIN_ID`
(84532), `PLANS_PER_HOUR` (10),
`PLANNER_MAX_TASKS` (8), `MAX_ATTEMPTS` (3), `REPO_HOSTS` (github.com), `CORS_ORIGINS`, `SSE_POLL_S` (1),
`OUTCOME_POLL_S` (1).
`WORKER_TOKEN` is this deployment's own choice, like `CHAIN_EVENTS_TOKEN`: spec/events-v0.md does not name a
token for this leg either, since the whole endpoint is new in O7. The planner model must be priced in
`prices.toml`, or the API refuses to start. Model choice for the planner is open decision D18, so it has no
default in code.

A browser's `EventSource` only sends the session cookie with `new EventSource(url, { withCredentials: true })`;
without it, `GET /v0/plans/{plan_uuid}/events` sees no session and answers `401`.

**Database.** The control plane uses its own database, not the gateway's: both have tables named `plans`,
`tasks` and `outbox`, and spec/events-v0.md says neither reads the other's.

## The worker

`python -m mergit_worker` claims one `queued` job at a time (`SELECT … FOR UPDATE SKIP LOCKED`), runs the
model loop against a fresh sandbox, then:

1. runs the approved predicate Φ in the sandbox after the agent has stopped (a `command` step, in the evidence set),
2. calls `seal_with_phi`, which appends the `phi_eval` step last,
3. uploads the bundle, merged with the full trajectory (every step's blobs, kept for a bonded challenge, not only the evidence steps), with `PUT {STORE_URL}/v0/bundles`,
4. sends `receipt.sealed` to `{GATEWAY_URL}/v0/events`,
5. writes the Φ result to the job row (`phi_holds`: `true`, `false`, or `NULL` when Φ could not run).

| Module | Role |
| --- | --- |
| `harness.py` | Owns the `ReceiptBuilder`. Agent loop, Φ, seal, publish. Stop reasons: `finished`, `no_tool_calls`, `step_budget`, `cost_budget`, `time_budget`, `llm_error`, `refusal`, `max_tokens` |
| `sandbox.py` | Docker container per job: no network, no secrets, one volume, CPU/memory/pid limits, read-only root, no capabilities, optional gVisor (`SANDBOX_RUNTIME=runsc`). A timeout kills every process in the container |
| `workspace.py` | The checkout on the host and the only code that touches it (see Security) |
| `tools.py` | `list_files`, `read_file`, `write_file`, `run_command`, `finish`. Each call is one step |
| `phi.py` | Runs Φ and builds the `PhiResult`; `holds` comes from `mergit_receipt.phi_holds` |
| `meter.py` | Cost per step: provider token counts times `prices.toml` (list prices, not measurements) |
| `publish.py` | Bundle upload then event, bearer tokens, `Idempotency-Key`, backoff for 10 minutes |
| `jobs.py` | All worker SQL |
| `llm.py` | `LLM` protocol and the Anthropic adapter |
| `progress.py` | `ProgressReporter`: reports a step to the control plane's live stream (O7) the instant it is recorded |

### What the agent cannot do

- Append or influence `phi_eval`: the tool layer only has a `record` callback that refuses the type, the tool list has no such tool, and the Rust binding refuses it too.
- Decide that a task is done: `finish` ends its turn. The graph moves on the Φ result.
- Reach a credential: the model's tools take no secrets, the container environment is a fixed, non-secret list, and signing keys live in the worker process (`MERGIT_AGENT_KEY_<agent_id>`).

### Security notes

The container can write anything to the mounted checkout, so the host never trusts it:

- the git directory lives **outside** the mount; every host git call passes `--git-dir` and `--work-tree`, so a planted top-level `.git` file or config (for example `core.fsmonitor`) is never read;
- a `.git` **anywhere inside** the checkout is refused outright before `changed_paths`/`diff_from_head` run any git command over the tree, rather than trusted to be handled by the right flags everywhere: git recurses into a gitlink (a nested `.git`, real submodule or not) using *that* repository's own config, and a `core.fsmonitor` entry there runs a command on the host the moment something walks over it;
- `changed_paths` also reports paths a `.gitignore` would otherwise hide (`--ignored=matching`), so an agent cannot satisfy `allowed_paths` by writing outside it and hiding the result;
- host reads and writes walk paths with `O_NOFOLLOW` per component, so a symlink made by the agent cannot redirect them, and the open is non-blocking, so a named pipe the agent created cannot hang the worker;
- repository URLs are limited to `SANDBOX_ALLOWED_URL_SCHEMES` (default `https`), refs and paths are validated, and git runs with a scrubbed environment and no hooks.

Only the checkout is mounted. Test runners are told not to write caches or bytecode into it (`SANDBOX_ENV` in `sandbox.py`), so they do not show up as changed paths and fail an `allowed_paths` check.

If the checkout is refused (the nested-`.git` case above), Φ is inconclusive (`holds = NULL`) the same way a
timed-out command is: not a guess at whether the real change would have passed.

### Live step reporting (plan task O7)

Every agent-loop step (not the Φ `command` step, not `phi_eval`) is reported to the control plane's
`POST /v0/internal/progress` the instant `harness.py`'s recorder gives it a `seq`, so a viewer's SSE stream
shows it with no polling delay. This is purely observational: `ProgressReporter.report` never raises, a
refusal or a transport error is only logged, and nothing about the task, the receipt or the job outcome
depends on it. `NullProgressReporter` (the default) sends nothing, for a worker started without
`CONTROL_PLANE_URL`/`WORKER_TOKEN`.

### Configuration

Typed, from the environment (`mergit_worker/config.py`). Required: `DATABASE_URL`, `GATEWAY_URL`, `STORE_URL`,
`EVENTS_TOKEN`, `STORE_WRITE_TOKEN`, `RECEIPT_REGISTRY`, `AGENTS_FILE`, and `MERGIT_AGENT_KEY_<id>` per agent,
plus whichever model key(s) its deployed agents' providers need (`ModelClients.build` only builds a client
for a provider a *deployed* agent actually names, so e.g. `ANTHROPIC_API_KEY` is not required when every
deployed agent is `openai_chat`). Everything else has a default, including `CHAIN_ID`
(84532), `SANDBOX_IMAGE`, `SANDBOX_RUNTIME`, `SANDBOX_MEMORY` (2g), `SANDBOX_NANO_CPUS` (2 CPUs),
`MAX_STEPS` (60), `MAX_OUTPUT_BYTES` (1 MiB), `COMMAND_TIMEOUT_S`, `JOB_DEADLINE_S`, `MODEL_MAX_TOKENS`
(16000; Opus 5.5's thinking tokens count against it, so this is also a per-call ceiling the harness clamps
*down* from when the remaining budget cannot cover it), `JOB_LEASE_S` (3600; a `running` job claimed longer
ago than this, by any worker, is reclaimed at start-up as `error` rather than left stuck forever).
`CONTROL_PLANE_URL` and `WORKER_TOKEN` are optional and only meaningful together (see above); with only one
set, the worker logs a warning at start and runs with live reporting off, same as with neither set.

Model and system prompt per agent: `agents.toml`, keyed by `name` in `deploy/agents.example.json`.
Prices: `prices.toml`.

If the worker itself runs in a container, `SANDBOX_WORKSPACE_ROOT` must be the same path on the host and in
the worker container, because sandboxes are started through the host Docker socket.

### Database contract

`jobs.py` reads `jobs`, `tasks` and `plans` and writes `status`, `claimed_by`, `claimed_at`, `phi_holds`,
`receipt_root`, `notes`, `finished_at` on `jobs`. It also reads `tasks.depends_on` (to apply a dependency's
own stored patch before a dependent task runs) and `jobs.patch`. The exact columns are in
`tests/jobs_schema.sql`. O4 owns the real migration and should either match those names or change `jobs.py`
and that file in the same pull request.

A crashed or killed worker never resumes a job under its old `task_id`: `fail_own_running` (this worker's own
jobs, checked at start-up) and `reclaim_stale` (anyone's, past `JOB_LEASE_S`) both mark the row `error` instead
of putting it back on the queue. Resuming would mean paying the model again for the same attempt and
re-sealing a bundle the store may already hold under that `task_id`, which it then refuses as a second bundle
for one task. A fresh attempt is a new `task_id`, decided by plan task O6, not a retry of this one.

`PgJobStore` also reconnects once and retries on a dropped connection (`claim`, `report`, `fail` and the two
start-up sweeps above): a worker process runs for a long time, and losing its one connection must not be
fatal to it.

## Pull-request gate (plan task O9)

When every task of a plan has passed Φ, the requester reviews the combined diff and approves; the worker then
opens the pull request.

- `GET /v0/plans/{plan_uuid}/diff` shows the stored change of each passing task, in task order.
- `POST /v0/plans/{plan_uuid}/open-pr` is the requester's approval. It records a `pr_requests` row
  (`migrations/0009_pr_requests.sql`) and returns `202`; asking again returns the same request, and a request
  that ended in an error is queued again. Only the plan's requester may call it (`403` otherwise), and it is
  refused with `409` and the list of blockers unless the plan is `done` **and** every task has a passing
  attempt with a stored patch (an empty patch, a task that passed without changing any tracked file, is not a
  blocker; only a capture that never happened is). The plan state alone is not trusted.
- `GET /v0/plans/{plan_uuid}/pr` returns status, branch, commit SHA, PR number and URL.

The API holds no GitHub token. The worker, the only process with `GITHUB_TOKEN`, claims the request,
re-checks the gate, applies each task's patch in order onto a fresh checkout of the plan's base ref, makes one
commit, force-pushes it to `mergit/<plan_uuid>` (a branch Mergit owns) and opens the PR. The PR body links each
task's receipt at `{APP_BASE_URL}/app/proofs/<task_id>` and says the receipts are unattested. Branch, commit
SHA and PR number are recorded on the request. A task with an empty patch is skipped when applying (`git apply`
itself refuses an empty patch), not fatal to the others.

A task that depends on another is dispatched (O4) only once that dependency has passed, and the worker applies
the dependency's own stored patch onto the fresh checkout before that task's agent loop starts (`depends_on`
and `dependency_patches` on the claimed `Job`, in `jobs.py`), in the same index order the PR step combines
patches in. A dependency with no tracked change (`""`) has nothing to apply and is skipped; a patch that does
not apply fails that job outright, naming the dependency, rather than running against the wrong tree.

Titles and the goal go through `clean_line` before reaching the PR body: markup is escaped, and `@mentions`
and bare links are defanged with a zero-width space so a planner- or requester-supplied string cannot ping
someone or get autolinked.

Like `PgJobStore`, `PgPrStore` never silently resumes a request under a different claim after a crash or a
stale lease (`requeue_own_running`, `reclaim_stale`, both checked at start-up) and reconnects once on a dropped
connection. Unlike a job, though, a stuck PR request is simply requeued rather than marked `error`: opening a
PR is idempotent (GitHub's "already exists" response, or just reapplying the same patches), so there is no
double-pay or duplicate-bundle risk in trying again. A crash while claiming either queue, or while running the
PR queue itself, no longer stops the job queue from being served on the worker's next turn.

The token is used in the `Authorization` header of API calls and in the environment of the single `git push`
process, as an HTTP header. It is never in a sandbox, a prompt, a URL, argv or a file. A worker started without
`GITHUB_TOKEN` runs tasks but ignores PR requests. Settings: `GITHUB_TOKEN`, `GITHUB_API_URL`,
`GITHUB_GIT_BASE_URL`, `GITHUB_HOSTS`, `APP_BASE_URL`, `PR_AUTHOR_NAME`, `PR_AUTHOR_EMAIL`.

`mergit_cp.routes_pr.build_router(get_requester, get_store)` takes the session and store dependencies, so the
app from O1 mounts it with its own SIWE session.

**Known limitations, not fixed here:** the PR's base is the base ref's tip at open time, not the commit the
tasks actually ran against, so a tag or SHA `ref` cannot become a GitHub PR base and a ref that moved between
dispatch and open can make a patch fail to apply; fixing it means pinning a base SHA somewhere in O3/O4's
schema, which is outside this pass. `open-pr` also does not bind to the specific diff the requester saw in
`GET .../diff` (no `diff_sha256` round trip), so a retry mid-review could approve a slightly different diff
than the one read; the frontend side of that doesn't exist yet either.

`jobs.status` only ever reaches `queued` once O4 has recorded a `task.escrowed`; before that, a dispatched
attempt exists only in `task_dispatches`. The real migration is `migrations/0004_dispatch.sql` (plan task
O4); `tests/jobs_schema.sql` is a copy of the same columns for the worker's own unit tests, kept in step
with it on purpose rather than imported, so a renamed or retyped column shows up as a failing test on both
sides.

## Develop

```bash
cd control-plane
uv sync --python 3.13                          # builds mergit_receipt with maturin (needs Rust)
uv run ruff check . && uv run ruff format --check . && uv run pyright
uv run pytest                                  # unit tests, no Docker
docker build -t mergit-sandbox:dev sandbox
uv run pytest -m "docker or postgres"          # real sandbox and real Postgres (testcontainers)
```

## Not done here

Tracked by other plan tasks and issue #12 bullets: egress allowlist, receipt body encryption (K4), data
availability checks, additional agents, evals, failure injection, and hosting (O10, in progress). gVisor is
wired through
`SANDBOX_RUNTIME` but has not been exercised in CI.

## Model provider

Each agent and the planner name their own model provider; there is no process-wide default and no
fallback. `agents.toml` carries both:

```toml
[providers.openrouter]
kind = "openai_chat"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"

[agents.claude-worker]
provider = "openrouter"
model = "anthropic/claude-sonnet-5"
...
```

A `[providers.<name>]` table names that provider's implementation: `kind = "anthropic"` talks to the
Anthropic SDK directly and needs nothing else (it falls back to the SDK's own `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN`); `kind = "openai_chat"` speaks an OpenAI-compatible chat API (Groq, OpenRouter, or
anything else shaped like one) and needs `base_url` plus `api_key_env`, the environment variable holding
its key. Each `[agents.<name>]` table then names which provider it uses by `provider`, and the planner
names its own by `Settings.planner_provider` (`PLANNER_PROVIDER`) — a deployment choice, same as
`PLANNER_MODEL`, not derived from which keys happen to be set.

`load_providers` (`mergit_worker/providers.py`) reads every `[providers.*]` table once at start-up; the
worker builds one client per provider actually used by a *deployed* agent (`ModelClients.build`), so an
unused provider's key is never required. A run never changes provider or model halfway: the choice is made
once, at start-up, and a receipt names the model that produced it, priced from the matching entry in
`prices.toml`.

Before a real run, check every credential at once: `python -m mergit_cp.llm_check` (inside the api
container) walks every provider actually in use — the planner's plus every deployed agent's — and for each
makes one plain and one tool-calling request, printing the result and never the key. The worker refuses to
start if a deployed agent's provider has no key; the API starts and a planning request answers `502`.
