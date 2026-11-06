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

## An unfunded wallet fails at gas estimation with no hint that funds are the problem

Before the service wallet was funded, the sidecar's `executeBatch` got as far as real on-chain gas
estimation and failed there with `"Execution error without revert data"`. Encoding, signing and the
RPC connection were all fine; the wallet had a `0` balance (`eth_getBalance`). Nothing in the error
says "insufficient funds". Funding needs a person with a browser wallet, since
`hub.arkiv.network/faucet` is gated behind wallet-connect and has no plain API. Once funded (10
tGLM), the same code wrote with no changes.

**Reproduce:** point the JS SDK's `createWalletClient` at Rabdi with a fresh, unfunded key and call
`executeBatch` with one create.

## u64 attributes lose precision if they cross JSON as numbers

The first live writes stored routing seeds a few units off. Seed `1065256257932064655` landed as
`1065256257932064640`. Arkiv stored what it was given correctly. The value was already wrong by
then: the control plane sent it to the Node sidecar as a JSON number, and `JSON.parse` rounds any
integer past 2^53 to the nearest double before the SDK's `u64()` sees it. The SDK takes a `bigint`
happily, but nothing warns that a plain number got there already rounded. We now send every u64 as a
decimal string, and the sidecar rejects a number outright. A fresh draw's seed
`3019959484170456754` reads back from Rabdi exact.

**Reproduce:** `node -e 'console.log(JSON.parse("1065256257932064655"))'` prints
`1065256257932064600`.

## A MetaMask-exported key has no `0x`, and viem won't take it

MetaMask's "Show private key" gives 64 hex characters with no `0x` prefix. viem's
`privateKeyToAccount` needs the prefix, so the sidecar crash-looped on its first deploy and the
control plane only saw "sidecar unreachable". Not an Arkiv bug, but it is the first thing anyone
who follows the faucet-then-MetaMask path will hit. The sidecar now accepts either form.

## Where it stands

Live on the hosted app: each exploring suggestion writes one batched transaction of one entity per
task, owned by the service wallet. The run screen's "View on Arkiv" reads them back from Rabdi and
checks them against the picks on screen. The query and an entity link are in `schema.md`.
