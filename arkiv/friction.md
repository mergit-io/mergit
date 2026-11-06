# Arkiv feedback

What got in the way building this, and how to reproduce each point. Everything below was checked
live against Rabdi (`https://rpc.rabdi.db-chain.testnet.arkiv.network`), not assumed from docs —
an earlier version of this file made claims from reading the Python SDK's source alone, which
turned out to be wrong for this network; this version corrects that.

## The official Python SDK targets a different, incompatible network

`arkiv-sdk` on PyPI (`Arkiv-Network/arkiv-sdk-python`) exists and looks like exactly what a Python
backend needs. Live, it doesn't work against Rabdi at all, in two separate ways:

- Its query options use `includeData` (`{"select": ..., "includeData": {...}}` style params). Rabdi
  rejects it outright: `"unknown field includeData, expected one of atBlock, select, limit, offset,
  cursor"`.
- Its write target (contract/processor address) is `0x…61726B6976`. Rabdi's own write address,
  confirmed by checking its code via `eth_getCode`, is `0x4400000000000000000000000000000000000044`
  — the one address `eth_getCode` on Rabdi actually returns bytecode for; the SDK's address returns
  `"0x"` (nothing deployed there on this chain). The newest prerelease (`1.0.0b3.dev0`) has migrated
  the write address but still sends the old, rejected query options for reads.

**Reproduce:** `pip install --pre arkiv-sdk`, point `ProviderBuilder().custom(...)` at Rabdi's RPC,
and run any `query_entities` call; the node returns the `includeData` error above.

## Rabdi's own JSON-RPC has no payload/content-type field at all

The docs' `select` field list (`key`, `owner`, `creator`, `createdAt`, `updatedAt`, `expiresAt`,
`creationFlags`, `attributes`, `attributeSchema`, `count`) looks complete until you look for where
the actual binary content goes. Checked live on dozens of real entities already on Rabdi
(`arkiv_getEntity`): none ever returns a top-level `payload` or `contentType` field, including ones
whose author clearly meant to store a binary blob (one real entity uses a custom attribute literally
*named* `payload`, since the protocol has none). Everything lives in `attributes`, including
anything you'd think of as "the payload" — hence `body` in our own schema is a `bytes`-typed
*attribute*, not the payload/content-type pair the JS quickstart's prose implies and the (wrong-network)
Python SDK's `create_entity(payload=..., content_type=...)` signature assumes.

**Reproduce:** `arkiv_getEntity` any real key from a live `arkiv_query` result; the response's keys
are exactly the `select` list above, never `payload`.

## The query language's literal syntax isn't what the JS quickstart's prose suggests

The attribute-value syntax the raw JSON-RPC wants is stricter than a first read of the docs
suggests: string literals need `str('...')` (bare `"..."` is a parse error, `-32001`), and address
literals need **unquoted** hex — `addr(0xAbC…)`, not `addr('0xAbC…')` (quoted gives `-32003`, "addr
takes a 0x-prefixed address"). Neither is spelled out next to the `select`-field docs; both were
found by reading the actual error messages from a live node.

**Reproduce:** `arkiv_query` with `'kind = "x"'` → `-32001`; with `$owner = addr('0x...')` → `-32003`.

## A JSON-RPC reachability probe can silently ignore its own filter

One specific sequence produced 60 real, unrelated entities from a query meant to match zero: an
`$owner`-only filter against a throwaway burn address (`0x…dEaD`) returned every entity anyone has
ever sent that address, which is correct — but it looked, for a few minutes, like the `kind`/schema
filter in a *different* query wasn't being applied, until re-running each query in isolation with a
`count`-only `select` showed the schema filter alone genuinely matches zero. Not an Arkiv bug: two
different test queries were run back to back and their results were briefly misread as one. Worth
recording anyway, since it's an easy trap when scripting several `arkiv_query` calls in a row and
reading output after the fact rather than per-call.

## No live write exercised yet — but a real, verified attempt, not a guess

`chain/arkiv/`'s sidecar, using the official JS SDK (the one confirmed above to target the right
network), reaches real on-chain gas estimation with an unfunded throwaway wallet (confirmed `0`
balance via `eth_getBalance`) and fails there — `"Execution error without revert data"` — not at
encoding, not at signing, not at the RPC connection. That is the furthest this can be verified
without a funded wallet, which needs a human with a browser wallet (`hub.arkiv.network/faucet` is
wallet-connect gated, not a plain API). No successful create yet, so no real entity key exists; the
placeholders in `schema.md` and the README stay placeholders until someone funds a wallet.
