# How we use Arkiv

**Do the things we filter on, who can edit each entity, and when it expires fit what the product
does?**

- **Filters** (the built-in `arkiv.schema`, plus `planId`, `decisionId`, `taskIndex`, `category`,
  `seed`, `budgetMicros`, `decidedAt` — all indexed, `schema.md`) are exactly the fields the product
  itself already groups suggestions by: one query per plan (`ArkivMirror.describe_query` builds
  `arkiv.schema = str('mergit.routing_decision') AND planId = str('...') AND $owner = addr('...')`),
  which is the same shape as the existing Postgres query `decisions()` in the test suite uses
  (`SELECT ... FROM routing_decisions WHERE plan_uuid = %s`). We didn't invent new query axes for
  Arkiv; we reused the ones the feature already needed, plus `$owner`, which Arkiv being a public,
  permissionless database makes necessary and Postgres's own access control never required. No
  `requester`: review caught that it was never filtered on and would outlive a discarded draft, so
  it's a Postgres-only column now.
- **Who can edit:** nobody, by design — we never call `update_entity`, `extend_entity`, or
  `delete_entity`. A routing decision is a historical fact about one draw at one point in time
  (paper §9.3: "any draw can be replayed from its seed and the posteriors it saw"); the matching
  Postgres row is enforced append-only by a database trigger for the same reason
  (`routing_decisions_append_only()`, migration `0016`). Arkiv's entity having a fixed owner and no
  update path we exercise is a match for that invariant, not an extra feature we're using because
  it's there — and `seed` plus `body`'s posterior snapshot are both on the entity now, so "any draw
  can be replayed" is something the public copy can actually back, not just the Postgres original.
- **Expiry** (`ARKIV_ENTITY_TTL_DAYS`, default 30) fits the data's own lifetime: a suggestion is
  advice for a plan that is still a *draft*. Once a requester approves, funds, and runs a plan, the
  suggestion is behind them — Postgres keeps it forever as an audit trail because storage there is
  cheap and ours; Arkiv keeps it only long enough to be checkable, then lets it go, which matches
  "ephemeral coordination state... that [agents] let expire," the exact framing Arkiv's own
  Build-on-Arkiv prize uses for this pattern.

**Does each Arkiv feature we use change something users see?**
Yes, directly: `GET /v0/plans/{uuid}/arkiv-suggestions` is a new endpoint the frontend's
`SuggestAgents` panel calls through a "View on Arkiv" button, shown only after an exploring
suggestion (greedy writes nothing, so there's nothing to show it for). It renders the entity keys
read back live from Arkiv's query API — not a value cached in our own database — so what the user
sees is proof the mirror round-trips, not a write nobody reads back (the one thing this track's
qualification rules call out as not counted).
