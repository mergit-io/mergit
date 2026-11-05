# Arkiv write sidecar

ETHGlobal Mumbai "Build on Arkiv" track. The one thing this exists for: signing and sending the write
Rabdi's current protocol needs — a batched `executeBatch` create of routing-decision entities — which
only the official JS SDK (`@arkiv-network/sdk`) demonstrably does correctly against Rabdi. The control
plane's own `arkiv_mirror.py` reads directly (plain `arkiv_query` over httpx, no SDK); only the write
needs this, and only this process ever holds the service wallet's private key.

## Why a sidecar, not Python

The only Python SDK (`arkiv-sdk` on PyPI) targets a different, incompatible Arkiv network — verified
live against Rabdi: its query options (`includeData`) and its write target (processor address) are both
rejected by Rabdi's node. See `../../arkiv/friction.md` for the exact RPC errors. The JS SDK's own write
target and query language both matched Rabdi live when checked the same way.

## Running it

```
npm install
ARKIV_PRIVATE_KEY=0x... ARKIV_SIDECAR_TOKEN=... node src/server.js
```

Env vars:

| Name | Required | What |
| --- | --- | --- |
| `ARKIV_PRIVATE_KEY` | yes | The service wallet's key. Fund it from `hub.arkiv.network/faucet`; get an access key from `hub.arkiv.network/access-keys`. Never the control plane's own env. |
| `ARKIV_SIDECAR_TOKEN` | yes | Shared secret the control plane sends as `Authorization: Bearer`; must match `ARKIV_SIDECAR_TOKEN` in `deploy/secrets/api.env`. |
| `ARKIV_ACCESS_KEY` | no | Raises the public RPC's heavy rate limit. |
| `PORT` | no | Default `8088`. |

`GET /healthz` — liveness. `POST /internal/mirror` — the one real endpoint (see `src/server.js`'s own
comments for the body shape); everything else is `404`, and a wrong or missing bearer token is `401`.

## Deploying it

Gated by the `arkiv` compose profile (`deploy/compose.controlplane.yaml`), same opt-in pattern as
`keyrelay`: nothing starts until `deploy/secrets/arkiv.env` exists (create it with the two vars above)
and the profile is passed —

```
docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml --profile arkiv up -d --build
```

Until then, `ARKIV_SIDECAR_URL` in `api.env` points nowhere running, and every mirror write just fails
and gets logged — never a crash, same as any other Arkiv misconfiguration (`arkiv_mirror.py`'s own
docstring).

## What's verified, and what isn't

Checked live against Rabdi, from this sidecar's own code path: the schema (`src/schema.js`) builds and
sends; an unfunded test wallet's write reaches real on-chain gas estimation and fails there
("Execution error without revert data", on a wallet confirmed to hold 0 tGLM) — not at encoding, not at
signing, not at the RPC connection. That is as far as this can be verified without a funded wallet. No
successful create, and so no real entity key, exists yet.
