# Events between orchestration and the web3 services, version 0

**Status:** normative for the v0 build. Schema: [`schemas/event.json`](schemas/event.json). Examples:
[`examples/events/`](examples/events/).

The Python orchestration service and the Rust chain gateway talk only through these events. Neither reads
the other's database.

## Transport

- HTTP `POST`, JSON body = the envelope, header `Idempotency-Key: <event_id>`.
- **Authenticated with a shared secret** sent as `Authorization: Bearer <token>`: the orchestrator sends
  `EVENTS_TOKEN` to the gateway; the gateway sends `CHAIN_EVENTS_TOKEN` to the orchestrator and `AUDIT_TOKEN` on
  audit requests to the validator; workers send
  `STORE_WRITE_TOKEN` when they upload a bundle to the store, and `WORKER_TOKEN` when they report live steps to
  the control plane (`POST /v0/internal/progress`, internal to orchestration). A request without the right token
  gets `401`. Store reads stay public.
- Orchestration → gateway: `POST {GATEWAY_URL}/v0/events`.
- Gateway → orchestration: `POST {ORCHESTRATOR_URL}/v0/chain-events`.
- The receiver answers `200` for a new event **and** for one it has already seen, and `4xx` for an event
  that fails the schema. The sender retries `5xx` and timeouts with backoff for 10 minutes, then raises an
  alert. Because of retries, every receiver is idempotent on `event_id`.

## Envelope

```json
{ "event_id": "<uuid v4>", "type": "<type>", "at": "2026-10-27T10:00:00.000Z", "payload": { } }
```

## Identifiers

```
plan_id = keccak256(utf8(plan_uuid))
task_id = keccak256(abi.encodePacked(plan_id, uint32 index, uint32 attempt))
```

`index` is the task's position in the plan, from 0. `attempt` starts at 1 and increases on each retry, so a
retry is a new task id with its own escrow lock. Python computes both with `mergit_receipt.plan_id` and
`mergit_receipt.task_id`, never by hand.

## Orchestration → gateway

| Type | Payload | Gateway does |
| --- | --- | --- |
| `plan.approved` | `plan_id, plan_uuid, requester, total_budget_usdc_units, funding: "wallet" \| "credits", credit_account?` | `credits`: checks the allowance and funds the plan from the treasury, or answers with `credits.denied`. With `credit_account` (the control plane's user id) the free credits, the daily plan count and the refund are that account's, whichever address requests; without it they follow the requester address. `wallet`: waits for the requester's own `PlanFunded` |
| `task.dispatch_requested` | `task_id, plan_id, index, attempt, agent_id, amount_usdc_units, category, phi_hash, deadline_unix` | Locks `amount` for the task in Escrow, unless already locked, and records `phi_hash`: a receipt is valid only for the approved Φ. `task_id` must equal the derivation above (`400` otherwise). A retry (`attempt > 1`) gets `503` while the previous attempt still holds its payment; deliver it again later |
| `receipt.sealed` | `task_id, agent_id, root, terminal_hash, body_hash, cost_micros, signature` | Commits the receipt to ReceiptRegistry, unless already committed |
| `plan.closed` | `plan_id` | Closes the plan in Escrow; the unspent balance returns to the requester (or the treasury for credits). A plan never funded is left alone |
| `credits.grant` | `account, amount_usdc_units, ref` | Adds `amount_usdc_units` to the account's credits (a redeemed code). The account's default free grant is created first if it has none, so a code adds to it. Idempotent on `ref` (the code's id): a second event with the same `ref` adds nothing. `account` is 1 to 64 and `ref` 1 to 100 characters of letters, digits and `_ . : -`; the amount is 1 to 10^12 base units |

**Rule:** the receipt bundle is uploaded to the receipt store (`PUT {STORE_URL}/v0/bundles`) **before**
`receipt.sealed` is sent, so a committed receipt always has a body to audit.

## Gateway → orchestration

| Type | Payload | Meaning |
| --- | --- | --- |
| `plan.funded` | `plan_id, requester, amount_usdc_units, tier: "staked" \| "onboarding", tx` | Money is in Escrow; tasks may be dispatched |
| `task.escrowed` | `task_id, tx` | The task's `V` is locked; the job may run |
| `receipt.committed` | `task_id, tx` | The root is on chain |
| `verdict.recorded` | `task_id, verdict: "pass" \| "fail" \| "invalid", tx` | An audit decided the outcome. Moves money and reputation, never the task graph |
| `task.released` | `task_id, to, amount_usdc_units, tx` | The operator was paid |
| `task.returned` | `task_id, amount_usdc_units, reason: "fail" \| "invalid" \| "deadline" \| "challenge", tx` | `V` went back to the plan balance |
| `challenge.opened` | `task_id, challenge_id, challenger, bond_usdc_units, tx` | Should tier |
| `challenge.resolved` | `task_id, challenge_id, upheld, tx` | Should tier. Adjudicated by the platform in v0 (open decision D9) |
| `credits.denied` | `plan_id, reason: "no_credits" \| "rate_limited" \| "over_value_cap"` | The credits plan was not funded |
| `error` | `ref_event_id, code, message` | A transaction for that event failed after retries |

Gateway events are sent after 2 confirmations, in chain order.

## One must-tier task, in order

1. Orchestration → `plan.approved`.
2. The requester funds (wallet) or the gateway funds from credits → `plan.funded`.
3. Orchestration → `task.dispatch_requested` for each ready task → `task.escrowed`.
4. The worker runs the task, seals the receipt, uploads the bundle, then orchestration → `receipt.sealed`.
5. Gateway commits → `receipt.committed`, and asks the validator to audit.
6. The validator records a verdict → `verdict.recorded`, then `task.released` (pass) or `task.returned`.
7. The task graph moves on the `phi_eval` result the worker reported in step 4, not on step 6.
8. When the plan ends, orchestration → `plan.closed`.
