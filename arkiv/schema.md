# Arkiv schema

What we write to Arkiv's Rabdi testnet, for ETHGlobal Mumbai's "Build on Arkiv (existing projects)"
track. Code: `control-plane/mergit_cp/arkiv_mirror.py` (reads, plain httpx), `chain/arkiv/` (the
sidecar that writes, holding the service wallet's key), called from
`control-plane/mergit_cp/routes_routing.py` (`_mirror_decisions`) and read back in
`GET /v0/plans/{uuid}/arkiv-suggestions` (`arkiv_suggestions`).

## What's new at this event, and what existed before

Mergit's router already picked agents for a task before Mumbai: `GET /v0/plans/{uuid}/suggestions`
ranks the roster by validated success per unit cost (`routing.py`, paper §9.3), and — only when
asked to explore — records the draw in our own Postgres table `routing_decisions` (migration
`0016_routing_decisions.sql`) so it can be replayed from its seed. **That Postgres write, the
ranking logic, and the whole suggestions endpoint are pre-existing.** What's new at this event is
everything that follows: a second, public copy of each exploring decision written to Arkiv, and a
new endpoint that reads it back from there.

## Entity

One `arkiv.schema = "mergit.routing_decision"` entity per task per exploring
`GET /v0/plans/{uuid}/suggestions?explore=true` call, all of one call's tasks in a single batched
transaction (`chain/arkiv/src/server.js`'s `executeBatch`), not one transaction per task.

`defineSchema("mergit.routing_decision", {...})` (`chain/arkiv/src/schema.js`) makes the schema's own
name the built-in `arkiv.schema` attribute — confirmed live against Rabdi: `arkiv.schema =
str('my-app.posts')` matches the docs' own example entity on the real network, so filtering on it is
a real query, not SDK sugar.

| Attribute | Type | Indexed | What |
| --- | --- | --- | --- |
| `planId` | `str` | yes | The plan's `0x`-prefixed id (`mergit_receipt.plan_id`), so a query can ask for one plan's decisions |
| `taskIndex` | `i32` | yes | Which task in the plan this decision is for |
| `category` | `str` | yes | The task's category, same value the router ranked within |
| `requester` | `addr` | yes | The plan owner's wallet address — a queryable attribute, **not** the entity's Arkiv-level owner (see "Who owns it" below) |
| `decidedAt` | `str` | yes | ISO-8601 UTC timestamp of the write |
| `body` | `bytes` | no | The candidates/picks JSON, as raw bytes — see below |

There is no separate "payload" field at the protocol level on Rabdi: checked live, `arkiv_getEntity`
never returns one, on any entity, ours or anyone else's (`friction.md`). Everything is a named
attribute, including the blob, which is why `body` is itself an attribute (`bytes`-typed) rather than
a payload/content-type pair — the Python SDK's `create_entity(payload=..., content_type=...)` API,
which assumes that pair exists, targets a different, incompatible network (`friction.md`).

`body`'s JSON:

```json
{
  "candidates": [{"agent_id": "...", "alpha": 0, "beta": 0, "kappa": 0, "tau": 0, "n": 0}],
  "picks": [{"agent_id": "...", "score": 0, "success": 0, "cost": 0}]
}
```

`candidates` is every roster agent's posterior at the moment of the draw (what `_snapshot` in
`routes_routing.py` already recorded to Postgres); `picks` is the ordered result. Same shapes
Postgres's `routing_decisions.candidates`/`.picks` columns hold — this is a mirror of that row, not
a redesign of it.

## Who owns it, and why

One service wallet signs every write. Its *private key* lives only in `chain/arkiv/`'s own env
(`ARKIV_PRIVATE_KEY`), never in the control plane's process or env — the control plane only knows
the wallet's *public* address (`ARKIV_OWNER_ADDRESS`), which it needs to filter reads (below). It is
not a per-requester wallet: Mergit requesters sign in with Ethereum but never hold funds on Arkiv's
testnet, so making them the Arkiv-level owner would mean asking them to fund a second chain to see
their own suggestion history. The requester's address is still fully queryable — as the `requester`
attribute above — just not the chain-level owner field.

Service wallet address: `<TODO: fill in once a funded ARKIV_PRIVATE_KEY is set on chain/arkiv/'s
deploy — see chain/arkiv/README.md>`.

## Expiry

`ARKIV_ENTITY_TTL_DAYS` (default 30) from first write. A routing suggestion is advice for one draft
plan; once that plan is approved, funded, run and done, the suggestion that preceded it has no
further use, so letting it expire rather than grow an unbounded public log is correct, not merely
cheap.

## One query anyone can run

```
arkiv.schema = str('mergit.routing_decision') AND planId = str('<a real plan_id from a live run>') AND $owner = addr(<the service wallet address above>)
```

The `$owner` clause matters: without it, anyone could write an entity with our exact schema tag and
a matching `planId` and have it show up as if it were ours (Arkiv is public and permissionless —
checked live, nothing stops a third party from using any tag). Run it against
`https://rpc.rabdi.db-chain.testnet.arkiv.network` via `arkiv_query`
(`{"select": {"key": true, "attributes": true}}`), or through
`GET /v0/plans/{uuid}/arkiv-suggestions` on the hosted app, which runs exactly this query
(`ArkivMirror.describe_query`) and returns the decoded result.
