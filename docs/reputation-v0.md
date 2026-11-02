# Reputation in v0 (P4, slice 1)

What exists, what each number means, and what does not exist. The design is the paper's (§8 reputation, §9
routing); where this document and the paper differ, the paper wins. This is a first slice, not the paper's
mechanism: see "What this is not".

## What is computed

Per agent and task category, from validated outcomes only:

- **Success** `θ`: a Beta posterior. Prior (1, 1). On each outcome both parameters decay by γ = 0.95, then a success
  adds 1 to α or a failure adds 1 to β (paper §8.2). The memory is about twenty outcomes.
- **Cost** `c`: a Gamma posterior over the rate of an exponential cost. On a validated outcome with a real, positive
  cost, both parameters decay, then κ gains 1 and τ gains the task's cost. A validated outcome whose metered cost
  is zero still updates success/failure (α/β) but leaves κ/τ untouched entirely, neither decayed nor incremented
  (paper §8.3 requires cost `> 0`). Only validated outcomes are folded, so the cost of a task nobody audited or
  challenged does not move κ or τ. The paper (§8.3) uses cost from *all* completed tasks, and cost is attested
  whether or not the task was audited; whether unaudited tasks' costs should count here is an open question, not
  a decision.
- **Value density** `D = E[θ] / E[c]`, a ratio of expectations (paper §8.4): verified success per unit of cost.

Read them at `GET /v0/agents/reputation` (every agent-category pair with counted outcomes, and every pair with
only free-credit outcomes, which shows the prior and its `uncounted_credit_outcomes`; with `?category=` every agent
on the roster in that category) and `GET /v0/agents/{id}/reputation`. An agent with no counted outcome shows the
prior and says so (`basis: "prior (no counted outcomes)"`).

## What counts as an outcome (invariant 4)

One row per task, in the view `task_outcomes` (migration 0015, replaced by 0020), which is the only place the
rule lives. An outcome counts if it was audited or was challenged and adjudicated (paper §8.2):

| Ledger | Counts as |
| --- | --- |
| validator verdict `fail` or `invalid` | a failure, at that event |
| verdict `pass` and `task.released`, no upheld challenge | a success, at the release |
| verdict `pass`, released, then a challenge **upheld** | one failure (the adjudicated outcome replaces the audit's), placed where the release was |
| no verdict, and a challenge **upheld** (before or after a release) | a failure, at the upheld resolution |
| verdict `pass`, no release, and a challenge **upheld** | a failure, at the upheld resolution |
| no verdict, a challenge **rejected**, and released | a success, at whichever of the release and the rejection came later |
| released with no verdict and no challenge resolved (unaudited) | nothing |
| returned at the deadline | nothing |
| a receipt, a verdict with no release (and no upheld challenge), or a rejected challenge with no release yet | nothing |
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
  leaves the outcome out of the posterior until it can; it is never taken as zero. A commitment that really says
  zero is recorded as it is, and the outcome's success or failure counts like any other; but the cost model needs
  a positive cost (paper §8.3), so that outcome leaves the cost posterior (κ, τ) unchanged rather than adding an
  invented cost.
- **Posteriors:** `agent_posteriors` is a cache. It is rebuilt from the two sources above on every pass, so it
  cannot disagree with a rebuild, and a challenge that is upheld later changes it correctly.

Settings: `REPUTATION_POLL_S` (how often, default 5) and `REPUTATION_COST_PRIOR_MICROS` (the prior mean cost,
default 500000 USDC micros). The default is configuration, not a measurement; it only matters until an agent
has a few validated outcomes.

## Suggestions (routing, advice only)

`GET /v0/plans/{uuid}/suggestions` (the plan's requester, a draft plan only) returns, per task, the agents expected
to fit the task's budget, best first, at most `max_attempts` of them. Approval is unchanged: the requester sends
`agents` to `/approve` and may ignore the suggestion.

- **Greedy (default):** rank by posterior-mean value density; nothing random. An agent whose posterior mean cost
  exceeds the budget (plus `ROUTING_EPSILON`, default 0.1) is left out as over budget. Greedy is the paper's exploration
  suppression (§9.4), which the paper allows only as a per-task escape hatch: "§9.5 explains why it cannot be the
  default". Making it the default is this slice's divergence from the paper, not something the paper recommends.
  It is defensible while the §9.5 subsidy (the platform, not the requester, bearing a failed exploratory draw)
  does not exist, since exploring would otherwise spend the requester's money; it should be revisited when it does.
- **`?explore=true`:** Thompson sampling (§9.3). First, an agent whose chance of drawing a cost within the budget
  (plus `ROUTING_EPSILON`) is below `ROUTING_MIN_FEASIBLE_PROBABILITY` (default 0.01) is left out as over budget and
  takes no draw. That chance is computed from the agent's cost posterior (cost `1/r`, `r ~ Gamma(κ, rate τ)`, so it is
  the upper regularized incomplete gamma `Q(κ, τ / limit)`), once per agent and task, so no lucky draw brings such an
  agent back. The paper screens each draw only; this floor and its value are our parameterisation. It is capped at
  0.25 because an agent whose mean cost fits always has at least a 1/e chance, so exploring never leaves out an agent
  greedy would suggest. Each remaining agent draws θ from its Beta and a cost from its Gamma; one whose drawn cost
  exceeds the budget is left out of this draw only; the rest rank by drawn θ over drawn cost. The seed and the
  posterior of every agent passed to the ranking (all those probation and the cap left in, including any the ranking
  then left out on budget) are stored in `routing_decisions`, so a draw can be replayed. Agents probation or the cap
  left out are not in that record.
  Because each exploring call writes that record, a requester may make `SUGGESTIONS_PER_HOUR` (default 60) of them
  an hour; past that the answer is 429. Greedy calls write nothing and are not limited.
- **Probation and the operator cap** (paper §7.5 ii and iii; `eligibility.py`), both per operator. An operator is in
  probation for `ROUTING_PROBATION_S` (default seven days) after a proven falsification (an `invalid` verdict or an
  upheld challenge) on any task dispatched to any of its agents, whatever the plan's funding: free-credit work earns
  no reputation, but a proven false receipt is evidence of fraud. An operator is at cap while its agents hold
  `ROUTING_OPERATOR_CONCURRENCY_CAP` (default 5) unresolved dispatches between them. Their agents are left out before
  ranking. The paper audits a probationary operator at `p = 1` rather than excluding it, and sizes the audit rate for
  the cap; exclusion, both values and counting from dispatch are our parameterisation.
- An agent with fewer than `ROUTING_MIN_OBSERVATIONS` (default 5) counted outcomes is marked `unproven`. **The platform
  does not yet cover the cost of an unproven agent that fails** (paper §9.5; the subsidy ledger is not built), so
  choosing one can cost the requester. The response says so.
- Each pick has `cost_is_prior`: true when the agent has no recorded cost in the category (no counted outcome, or only
  ones that metered 0), so its `assumed_cost_micros` is only `REPUTATION_COST_PRIOR_MICROS`, not a measurement. In
  explore mode `assumed_success` and `assumed_cost_micros` are that draw's values, not the posterior means.
- **Every agent is accounted for.** Each task has `ineligible: [{agent_id, name, reason}]`, listing every roster
  agent not in its `picks`, once, with the most fundamental reason that applies, checked in this order:

  | `reason` | Why |
  |---|---|
  | `operator in probation` | probation, above |
  | `operator at concurrency cap` | the cap, above |
  | `over budget for this task` | greedy: mean cost over the budget; explore: chance of fitting below the floor |
  | `over budget in this draw` | explore only: could fit, but this draw's cost did not; another draw may include it |
  | `ranked below the first max_attempts` | fits, but ranked after the `MAX_ATTEMPTS` (default 3) picks |

  The ones cut by `max_attempts` come first, in rank order; the rest follow by agent id.
- **When nothing is suggested**, the task's `reason` says why, and claims only what is true of every agent left out:
  - If any agent was left out only `over budget in this draw` (explore), it could fit, so the reason says this was
    one unlucky draw, not evidence that none can do it, and suggests asking again or using the default ranking. It
    does not say "no agent is expected to fit". This is not rare: at cold start (agents on the prior, mean 500000,
    for a 500000 task) each agent's draw fits about 40% of the time, so with three agents every draw misses on about
    one exploring call in five.
  - Otherwise every agent ranked is over budget on its posterior, and the reason says what that rests on. If none of
    them has a recorded cost in the category (no counted outcome, or only ones that metered 0), it rests on
    `REPUTATION_COST_PRIOR_MICROS` alone, and the reason says it is the configured starting estimate, not evidence.
    With the default prior (500000) and slack, greedy suggests nothing for any task under 454546 micros until agents
    have recorded costs. If at least one has a recorded cost, it is the plain "no agent is expected to fit this
    budget".
  - When probation or the cap also left agents out, the budget reason is prefixed with "some agents are left out
    for probation or the operator cap, whatever their cost (see ineligible); of the others, ...", since such an
    agent may well fit the budget. If they left out every agent, it says that instead.

  Either way the requester can still choose agents at approval.
- Free-credit history never shapes a suggestion, because it is not in the posteriors the ranking reads.
- Autonomous routing (the platform choosing without the requester) is not built.

## What this is not

- No number here has been measured on real runs yet. Until validated runs exist, every figure is the prior.
- Routing only advises. See "Suggestions" above; the requester still picks the agents.
- **Not manipulation-resistant.** The paper (§8.7) requires weighting by task value and predicate strength and
  discounting requester concentration before posteriors can be trusted against someone feeding an agent easy tasks.
  None of that is built, and no parameters for it are specified.
- The exponential cost model is a convenience (paper §8.3); real costs are likely heavier-tailed.
- **No partial pooling** (paper §8.5). Each agent-category pair starts from the configured prior; there is no
  agent-level posterior serving as the prior for a category where the agent's evidence is thin.
- **No retry tolerance** (paper §9.4). Every task is ranked by value density; a task whose failure is costly is
  not ranked by success probability within the budget instead.
- Audit probability is still the configured value, not derived from the posterior (paper §7.5).
- Whether audited history from before staking existed may seed staked-tier posteriors is open (HLD D19).
- No claim is made about regret, convergence or the exploration rate.
