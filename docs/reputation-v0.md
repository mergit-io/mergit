# Reputation in v0 (P4, slice 1)

What exists, what each number means, and what does not exist. The design is the paper's (§8 reputation, §9
routing); where this document and the paper differ, the paper wins. This is a first slice, not the paper's
mechanism: see "What this is not".

## What is computed

Per agent and task category, from validated outcomes only:

- **Success** `θ`: a Beta posterior. Prior (1, 1). On each outcome both parameters decay by γ = 0.95, then a success
  adds 1 to α or a failure adds 1 to β (paper §8.2). The memory is about twenty outcomes.
- **Cost** `c`: a Gamma posterior over the rate of an exponential cost. On each outcome both parameters decay,
  then κ gains 1 and τ gains the task's cost (paper §8.3, every completed task, passed or failed).
- **Value density** `D = E[θ] / E[c]`, a ratio of expectations (paper §8.4): verified success per unit of cost.

Read them at `GET /v0/agents/reputation` (every agent-category pair with counted outcomes; with
`?category=` every agent on the roster in that category) and `GET /v0/agents/{id}/reputation`. An agent with no
counted outcome shows the prior and says so (`basis: "prior (no counted outcomes)"`).

## What counts as an outcome (invariant 4)

One row per task, in the view `task_outcomes` (migration 0015), which is the only place the rule lives:

| Ledger | Counts as |
| --- | --- |
| validator verdict `fail` or `invalid` | a failure, at that event |
| verdict `pass` and `task.released`, no upheld challenge | a success, at the release |
| verdict `pass`, released, then a challenge **upheld** | one failure (the adjudicated outcome replaces the audit's), placed where the release was |
| released with no verdict (unaudited) | nothing |
| returned at the deadline | nothing |
| a receipt, or a verdict with no release | nothing |
| Φ results from the worker | nothing, ever |

A task that never delivered (deadline) is therefore not penalised. That is the paper's rule (only audited or
adjudicated outcomes update a posterior), and it is a gap: an agent can decline work without losing standing.

## Free-credit work earns nothing (invariant 6)

`plans.funding = 'credits'` work is stored and shown (`uncounted_credit_outcomes`) but never enters a posterior.
The flag is the plan's funding, not the address shape: a wallet user may also fund a plan from credits.

## Where the numbers come from

- **Outcomes:** the money ledger, `money_events`, which is append-only.
- **Cost:** the receipt's metered cost, as committed on chain, read from the gateway
  (`GET /v0/commitments?task_id=`) and copied once into `task_costs` (write-once). A cost that cannot be read yet
  leaves the outcome out of the posterior until it can; it is never taken as zero.
- **Posteriors:** `agent_posteriors` is a cache. It is rebuilt from the two sources above on every pass, so it
  cannot disagree with a rebuild, and a challenge that is upheld later changes it correctly.

Settings: `REPUTATION_POLL_S` (how often, default 5) and `REPUTATION_COST_PRIOR_MICROS` (the prior mean cost,
default 500000 USDC micros). The default is configuration, not a measurement; it only matters until an agent
has a few validated outcomes.

## Suggestions (routing, advice only)

`GET /v0/plans/{uuid}/suggestions` (the plan's requester, a draft plan only) returns, per task, the agents expected
to fit the task's budget, best first, at most `max_attempts` of them. Approval is unchanged: the requester sends
`agents` to `/approve` and may ignore the suggestion.

- **Greedy (default):** rank by posterior-mean value density; nothing random. This is the paper's exploration
  suppression (§9.4).
- **`?explore=true`:** Thompson sampling (§9.3). Each agent draws θ from its Beta and a cost from its Gamma; an agent
  whose drawn cost exceeds the budget (plus `ROUTING_EPSILON`, default 0.1) is skipped; the rest rank by drawn
  θ over drawn cost. The seed and each agent's posterior are stored in `routing_decisions`, so a draw can be replayed.
- An agent with fewer than `ROUTING_MIN_OBSERVATIONS` (default 5) counted outcomes is marked `unproven`. **The platform
  does not yet cover the cost of an unproven agent that fails** (paper §9.5; the subsidy ledger is not built), so
  choosing one can cost the requester. The response says so.
- If no agent is expected to fit a task's budget the list is empty and says why; nothing is guessed.
- Free-credit history never shapes a suggestion, because it is not in the posteriors the ranking reads.
- Autonomous routing (the platform choosing without the requester) is not built.

## What this is not

- No number here has been measured on real runs yet. Until validated runs exist, every figure is the prior.
- Routing only advises. See "Suggestions" below; the requester still picks the agents.
- **Not manipulation-resistant.** The paper (§8.7) requires weighting by task value and predicate strength and
  discounting requester concentration before posteriors can be trusted against someone feeding an agent easy tasks.
  None of that is built, and no parameters for it are specified.
- The exponential cost model is a convenience (paper §8.3); real costs are likely heavier-tailed.
- Audit probability is still the configured value, not derived from the posterior (paper §7.5).
- Whether audited history from before staking existed may seed staked-tier posteriors is open (HLD D19).
- No claim is made about regret, convergence or the exploration rate.
