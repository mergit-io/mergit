# Runbook: agent identity on ENS and the mainnet one-shot (issue #67)

Design: `docs/HLD-ens-integration.md` (section 8.1). Everything here runs from `ens/`. Commands that touch a chain need `ENS_MAINNET_RPC` (an Ethereum mainnet RPC URL) and, in a sandboxed shell, `NODE_USE_ENV_PROXY=1`.

**Rules that always hold**
- Nothing in this package sends to mainnet unless you pass `--mainnet --execute` and have put the owner key in `ENS_OWNER_PRIVATE_KEY` yourself. The key is never printed, logged or stored. Do not paste it into a chat.
- Anvil's public test addresses are refused for the publisher and editor outside `--fork` runs (their private keys are public).
- Roles: the **publisher** holds only `mergit.reputation` and `mergit.operator`; the **editor** holds only `agent-context` and `agent-endpoint[web]`; operators hold nothing (HLD decision O9, option (a)). The `mergit.eth` owner is the resolver's admin.

## 0. Make your config

Copy `agents.example.json` to `agents.json` and edit:
- `agents[]`: `label` (lowercase, digits, hyphens), `name`, `description`, `profileUrl` (must be `https`; use the public profile route agreed with issue #71, the example `https://mergit.site/agents/<name>.mergit.eth` is a guess), and `agentId`.
- `publisher` and `editor`: **real accounts you control** (HLD O7: where the publisher key lives is still open). The example uses anvil test addresses so `--fork` works; mainnet mode refuses them.
- `agentId` is the id `registerAgent` returns. **Leave it out until the agent is registered**; do not put a placeholder. Agents without an id get a registration file with no `registrations`, and the one-shot refuses to run until every agent has its id.

## 1. Register agents on Base Sepolia (M2, needs your funded Base Sepolia wallet)

Chain 84532. Identity: `0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6`. Agent #1 already exists with an empty URL and is not linked (HLD E9).

1. **Generate the files with no registrations yet** (HLD 8.1 step 1). Agents without an `agentId` get no `registrations`; `--without-ids` forces that for all agents:
   `node src/registration-cli.ts agents.json out`
2. **Host them** at stable, editable HTTPS URLs (HLD O5, your decision), **served with an `Access-Control-Allow-Origin` header that allows the web app's origin**: the web app fetches the file from the browser, and without that header no agent can be verified. One simple option is to commit them under `frontend/public/agents/` so they are served at `https://mergit.site/agents/<label>.json`; that deploys with the site and can be edited later. The URL is fixed on chain by the next step, so the content must stay editable and the URL must stay put.
3. **Register each agent.** `registerAgent(address runtimeKey, string metadataURI)`; the runtime key is the address that signs that agent's receipts. Ids are sequential and returned by the call:
   ```
   export RPC=https://sepolia.base.org   # or your own
   export IDENTITY=0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6
   # preview the id this registration will get (a dry call from your address, nothing is sent):
   cast call $IDENTITY "registerAgent(address,string)(uint256)" $RUNTIME_KEY "https://mergit.site/agents/coder-0.json" --from $YOUR_ADDRESS --rpc-url $RPC
   # send it (you enter your own key or use a keystore; never paste a key into chat):
   cast send $IDENTITY "registerAgent(address,string)" $RUNTIME_KEY "https://mergit.site/agents/coder-0.json" --rpc-url $RPC --account <your-keystore>
   cast call $IDENTITY "tokenURI(uint256)(string)" <id> --rpc-url $RPC
   ```
4. **Put the real ids into `agents.json`, then regenerate with ids** and republish the files: `node src/registration-cli.ts agents.json out`.

## 2. The mainnet one-shot (M3 rehearsal, then M6)

Seven steps, in this order, so `mergit.eth` is only pointed at the new resolver after everything else worked: deploy the resolver, grant the publisher its two keys (`mergit.reputation` and `mergit.operator`), grant the editor its two keys, write all agent records in one multicall, then `setResolver` on `mergit.eth`.

1. **Rehearse on a fork** (free, impersonates the owner, nothing is sent to mainnet):
   `ENS_MAINNET_RPC=<url> node src/oneshot-cli.ts agents.json --fork`
   Every record must read back `ok` and the exit code must be 0. The three-agent example used 1,437,255 gas.
2. **Plan against mainnet** (reads only, sends nothing):
   `ENS_MAINNET_RPC=<url> node src/oneshot-cli.ts agents.json --mainnet`
   Check the owner address, the two role holders and the records. Check the owner's ETH balance against the estimate (HLD O2: the owner wallet needed funding; about 0.00035 ETH at 0.24 gwei, about 0.0072 ETH at 5 gwei).
3. **Execute** (the only step that sends transactions, as the owner):
   `ENS_MAINNET_RPC=<url> ENS_OWNER_PRIVATE_KEY=<owner key> node src/oneshot-cli.ts agents.json --mainnet --execute`
   It refuses unless the key belongs to the on-chain owner of `mergit.eth` and the balance covers twice the estimate.
4. **Check the result:** all rows `ok`, then open `https://app.ens.domains/mergit.eth` and a subname such as `coder-0.mergit.eth`.

**If it stops midway** the error names the step, lists the steps already done and the resolver address. `mergit.eth` is not pointed at the new resolver until the last step, so the live name is unchanged. **Just run the same command again:** the resolver address is deterministic (the plan prints it), and a rerun reuses it if the deploy already landed, including when only the receipt wait timed out. Set `"saltNonce": 1` (then 2, ...) only if you deliberately want a brand new resolver.

**Run the one-shot once.** It refuses to run again when the planned records already resolve, because a second run would point `mergit.eth` at a new, empty resolver and orphan everything on the first, including `mergit.reputation`. Adding an agent after the first run means writing its three records (`agent-registration[...]`, `agent-context`, `agent-endpoint[web]`) to the **existing** resolver as the owner; an append mode for that is **not built yet**.

## 3. Still open (not decided by this package)

- **O5** where the registration JSON is hosted.
- **#71** the public profile route behind `agent-endpoint[web]`.
- **O2** funding the owner wallet.
- **O7** where the publisher and editor keys live in deployment (the service reads them from the environment; the secrets file location is yours to choose). The writer service itself is built (section 4).

## 4. The writer service (issue #69)

One process holds two **different** keys and does two jobs: a **publish pass** (reputation mirror and operator record, written with the publisher key, at start and every `WRITER_INTERVAL_SECONDS`) and **`POST /edit`** (an operator-signed edit of `agent-context` or `agent-endpoint[web]`, written with the editor key). It listens on `127.0.0.1` only; put a reverse proxy in front of it if it must be reachable.

1. `cp writer.env.example writer.env` and fill it in (git-ignored; never commit real values). `cp writer.example.json writer.json` and set `resolver` to the resolver address from the one-shot, `agents` to the agents that have ENS names (label and Base agent id), and `fromBlock` to a block **shortly before the first outcome** of those agents, not the contract's deploy block (the public Base Sepolia RPC allows only 200 blocks per log query, so a long backfill takes thousands of requests; a better RPC removes the limit). Each agent's `label` and `agentId` must match: the service reads the `agent-registration[...][id]` record on `<label>.mergit.eth` (written by the one-shot) and **refuses** an agent whose name does not carry it, so a copied example cannot write under the wrong name. `confirmations` (default 5) is how many Base blocks behind the head a pass reads, so a lagging RPC node cannot make it skip blocks for good.
2. Run: `set -a; . ./writer.env; set +a; node src/writer-cli.ts`. It logs the two addresses it will sign with (never the keys) and exits on a bad environment. The keys must hold ETH for gas on mainnet; the publisher holds the roles `mergit.reputation` and `mergit.operator`, the editor `agent-context` and `agent-endpoint[web]` (the one-shot grants them).
3. **How an operator signs an edit.** The operator signs, with the wallet that owns the agent on Base, the EIP-191 message built by `editMessage` in `src/edit-request.ts` (it names the chain, the Identity contract, the agent, key, value, a nonce and a validity window of at most 10 minutes) and posts `{ "request": {...}, "signature": "0x..." }` to `/edit`. The service re-reads `operatorOf` from Base at that moment, so a former owner is refused straight after a transfer. Contract wallets (EIP-1271) are not supported.
4. **Check:** `GET /healthz` returns 200; after a publish pass, `mergit.reputation` and `mergit.operator` resolve on `<label>.mergit.eth`.

**Safety limits.** Edits are sent one at a time from the editor account. Every edit costs the editor key mainnet gas, so the service caps edits per agent per hour (`WRITER_EDITS_PER_AGENT_PER_HOUR`, default 6), edits per hour in total (`WRITER_EDITS_PER_HOUR`, 60) and requests per minute (`WRITER_REQUESTS_PER_MINUTE`, 120; each valid-looking request costs an RPC read). Over a limit the service answers 429 and sends nothing. A failed ENS read (rate limit, network) fails the pass instead of being read as "record not set" and rewritten; a resolver with no code fails the pass.

**Limits (all documented in the HLD):** the outcome cache and the nonce store are in memory (a restart refetches from `fromBlock` and requests signed before the restart are refused); reorganisations of Base are not handled; one process, no HA.
