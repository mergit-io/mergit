# Arkiv feedback

What got in the way building this, and how to reproduce each point.

## The Python SDK is real, but easy to miss

`docs.arkiv.network`'s own quickstarts (`start-here/first-entity`, `writing/create`) are all
TypeScript against `@arkiv-network/sdk` + `viem`. Our control plane is Python, so the first
conclusion a reader reaches is "writes need Node" — `createEntity` there is a signed,
custom-encoded transaction, not a plain JSON-RPC call, so hand-rolling it in another language looks
risky. The official Python SDK (`Arkiv-Network/arkiv-sdk-python`, `pip install --pre arkiv-sdk`,
built on `web3.py`) exists and does the same job, but we only found it by searching GitHub's
`arkiv-network` org directly — nothing on the docs site itself linked to it. **Reproduce:** read
`docs.arkiv.network/start-here/first-entity/` end to end; it never mentions the Python SDK or links
to it.

## The Python SDK has no stable release, and the two listings disagree

PyPI's `arkiv-sdk` has no `1.0.0` yet — the real releases are `1.0.0.dev1` through our pin,
`1.0.0b2`. That needs an exact-version pin (`arkiv-sdk==1.0.0b2`) rather than a range, since most
resolvers (uv included) only accept a prerelease when the specifier itself names one. Separately,
the GitHub repo's own "Releases" sidebar showed `v0.2.2` as "Latest" while PyPI already had several
newer `1.0.0` alphas and betas — someone comparing the two listings would reasonably conclude the
project is stuck pre-1.0 at `v0.2.2`, which understates what's actually published. **Reproduce:**
`pip index versions arkiv-sdk` (or the PyPI JSON API) against
`github.com/Arkiv-Network/arkiv-sdk-python/releases`.

## Attributes are `str | int` only — structured data has to go in the payload

`arkiv.types.Attributes` is `NewType("Attributes", dict[str, str | int])`. Our routing decision
carries a list of per-agent posteriors and ranked picks, which can't be an attribute value at all —
we only found this by reading the SDK's `types.py` rather than from a documented constraint. It's a
reasonable design (attributes are the indexed, queryable part; anything else belongs in the
payload), but the quickstart's single `str`/`dec`/`bytes` example doesn't make the boundary
explicit. We ended up putting `candidates`/`picks` in the JSON payload and only the filterable
fields (`planId`, `taskIndex`, `category`, `requester`, `decidedAt`, `kind`) as attributes
(`arkiv_mirror.py`, `schema.md`).

## No live write exercised yet

Everything in this track — `write_decision`, `read_decisions`, the `/arkiv-suggestions` endpoint,
and the frontend panel — is tested against a fake `RawArkivClient` (`tests/test_arkiv_mirror.py`,
the Arkiv-specific cases in `tests/test_routes_routing.py`) plus the full existing Postgres suite,
not against a real Rabdi write: that needs a funded service wallet and an access key, which only
someone with wallet access can obtain (`hub.arkiv.network/faucet`, `hub.arkiv.network/access-keys`)
and set as `ARKIV_RPC_URL`/`ARKIV_PRIVATE_KEY`/`ARKIV_ACCESS_KEY` on the hosted deploy. `schema.md`'s
wallet address is a placeholder until that happens.
