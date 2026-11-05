# Reach

**Who uses this today, and will they use the part on Arkiv?**
Mergit's `/v0/plans/{uuid}/suggestions?explore=true` is already a live, used feature: a requester
drafting a plan can ask for an exploring (rather than greedy) ranking of which agent to run each
task, and that call already writes a replay row to our own Postgres today, independent of this
event. Every exploring call a requester makes now also gets mirrored to Arkiv — the same users,
the same action, no new UI flow for them to opt into.

**Will it ship to them after Mumbai?**
Yes, assuming it holds up: nothing about the mirror is event-only scaffolding. `ArkivMirror` is a
best-effort side effect (`routes_routing._mirror_decisions` catches and logs any failure rather
than raising it), so leaving it on costs us nothing on the request path even if Arkiv's testnet has
an outage, and removing it later is a one-line settings change (`ARKIV_RPC_URL` unset), not a
migration. The honest caveat: Arkiv itself is currently testnet-only (see its own Terms of Use), so
"after Mumbai" for us currently means "until Arkiv has a production network," at which point moving
the service wallet over is the only change needed.

**Who else would use a copy of this data on Arkiv?**
Two concrete audiences, neither hypothetical:

- **Our own router's future work (paper §9.3, §7.5).** The reputation/routing paper already wants
  an auditable, replayable record of every exploring draw — that's *why* `routing_decisions` is
  append-only in Postgres today. A public copy is strictly more auditable than a private table only
  we can read: anyone can verify a draw was recorded honestly and wasn't edited after the fact,
  which a database we control cannot prove to an outside party.
- **Other agent-coordination projects on Arkiv.** This is a direct instance of the "ephemeral
  coordination state that agents share, query and let expire" pattern Arkiv's own Build-on-Arkiv
  prize names as a target use case. A team building on Arkiv to compare how different projects
  model agent-assignment data would have a real, running example to query (`kind =
  "mergit.routing_decision"`), not a synthetic demo entity nobody else depends on.
