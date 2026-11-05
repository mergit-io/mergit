// The entity shape every mirrored routing decision takes on Arkiv. `defineSchema`'s own name
// ("mergit.routing_decision") becomes the built-in, always-queryable `arkiv.schema` attribute —
// verified live against Rabdi: `arkiv.schema = str('my-app.posts')` matches the docs' own example
// entity on the real network, so this is the real filter, not SDK sugar.
//
// `body` carries the JSON payload (candidates/picks) as raw bytes: Arkiv attributes are
// `str | i32 | u64 | u256 | dec | addr | bytes` only, no nested structures (confirmed by reading
// the SDK's own `Attributes` type), and a plain JSON string is smaller round-tripped as UTF-8
// bytes than re-encoded through any of the scalar types.
import { defineSchema, i32, str, bytes, addr } from "@arkiv-network/sdk/schema";

export const RoutingDecision = defineSchema("mergit.routing_decision", {
  planId: str().indexed(),
  taskIndex: i32().indexed(),
  category: str().indexed(),
  requester: addr().indexed(),
  decidedAt: str().indexed(),
  body: bytes(),
});
