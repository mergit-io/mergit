// The entity shape every mirrored routing decision takes on Arkiv. `defineSchema`'s own name
// ("mergit.routing_decision") becomes the built-in, always-queryable `arkiv.schema` attribute —
// verified live against Rabdi: `arkiv.schema = str('my-app.posts')` matches the docs' own example
// entity on the real network, so this is the real filter, not SDK sugar.
//
// `decisionId`, `seed` and `budgetMicros` link this entity back to the exact Postgres
// `routing_decisions` row and let anyone replay the draw — the thing migration 0016 says that
// table exists for ("any draw can be replayed from its seed and the posteriors it saw"). No
// `requester`: a discarded draft plan can't be deleted off Arkiv (entities are append-only, only
// expiry removes them), so attaching a wallet address to data that outlives a "discard" is wrong,
// and nothing ever queried by it anyway (`$owner`, the service wallet, is what reads filter on).
//
// `body` carries the JSON payload (candidates/picks) as raw bytes: Arkiv attributes are
// `str | i32 | u64 | u256 | dec | addr | bytes` only, no nested structures (confirmed by reading
// the SDK's own `Attributes` type), and a plain JSON string is smaller round-tripped as UTF-8
// bytes than re-encoded through any of the scalar types.
import { defineSchema, i32, str, bytes, u64 } from "@arkiv-network/sdk/schema";

export const RoutingDecision = defineSchema("mergit.routing_decision", {
  planId: str().indexed(),
  decisionId: u64().indexed(),
  taskIndex: i32().indexed(),
  category: str().indexed(),
  seed: u64().indexed(),
  budgetMicros: u64().indexed(),
  decidedAt: str().indexed(),
  body: bytes(),
});
