<div align="center">

# mergit

**A trust and settlement layer for autonomous agent work.**

*Agent platforms bill you for the attempt. Mergit settles on the outcome — verified.*

[![Paper](https://img.shields.io/badge/read_the-paper-6366F1?style=flat-square)](https://github.com/mergit-io/mergit-research/blob/main/paper/draft-v1.md)
[![Whitepaper](https://img.shields.io/badge/15_min-whitepaper-818CF8?style=flat-square)](https://github.com/mergit-io/mergit-research/blob/main/paper/whitepaper.md)
[![PRD](https://img.shields.io/badge/requirements-PRD-64748B?style=flat-square)](docs/PRD.md)
[![Licence](https://img.shields.io/badge/licence-GPL--3.0-blue?style=flat-square)](LICENSE)

</div>

---

## What this is

Delegate a task to an agent today and you are billed for the attempt. Tokens, tool calls and
sandbox minutes are metered precisely; whether the task was *done* is not metered at all.

Outcome-contingent payment is solved for work that can be **re-executed** — post stake, re-run the
query, slash on mismatch. Agent work cannot be re-run: it is multi-step, tool-using and
side-effecting, so the repository has already changed, the API call already landed, and the money
already moved. The constraint is not the price of verification but its definability.

Mergit owns the execution environment, so it **attests execution instead of reproducing it**:

- **Verifiable Execution Receipts** — hash-chained, sequence-numbered steps signed inside a TEE and
  bound to a measured runtime image. Merkle root on chain, body off chain, disclosure tiered.
- **Verification economics** — stake, per-agent audit rates derived from a posterior over
  capability, permissionless bonded challenge, per-operator concurrency cap.
- **Cost-adjusted reputation** — `D = E[verified success] / E[metered cost]`. Verified quality per
  unit cost, not quality alone.
- **Routing as a decision policy** — Thompson sampling over value density under budget.
- **Revocable settlement** — escrow released on a passing audit or window expiry; a successful
  challenge refunds, rewards and slashes.

**Chain:** an Ethereum L2, EVM-compatible, ERC-8004-compatible identity.

## Status

**Implementation is starting.** The design is settled and the build is not. Nothing here has been
measured, and no figure in the documentation is a benchmark — the prior prototype
([Mergit-proto](https://github.com/mergit-io/Mergit-proto)) is archived and validated the
multi-agent execution model, not the trust layer.

Delivery order, from [PRD §14](docs/PRD.md#14-delivery-phases):

| | |
| :---: | --- |
| **P0** | Runtime and receipt format — harness, sandbox, metering, hash chain, signing |
| **P1** | Attestation — TEE-backed sandbox, measured image |
| **P2** | On-chain identity and receipt commitments on an L2 testnet |
| **P3** | Settlement and challenge — escrow, stake, dispute window |
| **P4** | Reputation and routing |
| **P5** | Permissionless staked validation |

## ENS integration (ETHGlobal Mumbai)

Mergit's agents get public names under `mergit.eth` on **Ethereum mainnet (ENSv2)**. **Agents, money, receipts
and outcomes stay on Base Sepolia.** Only names and records are on mainnet. Design:
[docs/HLD-ens-integration.md](docs/HLD-ens-integration.md). Live app: https://mergit.site (an agent's page is
`/agents/<label>.mergit.eth`, the final ledger is `/ledger`).

**What existed before this work, and what is new.** Everything up to commit `804f5f5` (2026-11-05, the parent of
the first ENS commit) is the pre-existing system: the runtime, receipts, contracts client, chain gateway,
control plane, and the web app. The ENS work is everything after it: `ens/` (the one-shot, publisher, writer
service, final ledger, key generation, fork tests), the frontend's `chain/ens/` read layer, the agent profile
page, the leaderboard's ENS names and the `/ledger` page, the hosting changes (`deploy/Caddyfile`), and two new
registered agents (`mergit-coder-1`, `mergit-coder-2`).

**How a name is trusted (two-way).** A registered agent is linked to a name in both directions, and the web app
checks both before it shows a badge: the name's ENSIP-25 record `agent-registration[<Identity>][<agentId>]` says
which agent it is, and the agent's registration file (the metadata URI that `Identity.tokenURI` returns on Base)
names the ENS name back. If either side is missing or disagrees, the page shows exactly what failed and no tick.
After a transfer of the agent on Base the badge reads "owner changed, not verified" until the next publish.

| Record on `<label>.mergit.eth` | Written by | What it is |
| --- | --- | --- |
| `agent-registration[...]` | admin (`mergit.eth` owner), once | ENSIP-25 link to the on-chain agent |
| `agent-context`, `agent-endpoint[web]` | Mergit's editor key, after checking the requester owns the agent | description and public page |
| `mergit.reputation` | publisher key only | a **mirror** of validated outcomes from Base (counts, not a score) |
| `mergit.operator` | publisher key only | current operator on Base |
| `mergit.ledger` (on `mergit.eth`) | publisher key only | hash and URL of the final ledger file the `/ledger` page verifies |

**No hard-coded values.** Every name, record, owner and resolver the app shows is read from mainnet at runtime
(the mainnet RPC and the Identity and ReputationAnchor addresses are build settings, `VITE_ENS_*`). The agent
list is the platform's own. A new registered agent shows up without a code change.

**Verify it yourself.**

- `cd ens && npm run gate` reads the live mainnet state of `mergit.eth` (owner, registry, expiry).
- `cd ens && ENS_MAINNET_RPC=<url> BASE_SEPOLIA_RPC=<url> npm test` runs the suite, including the fork tests on
  real mainnet and Base Sepolia state. Without the RPCs the fork tests are skipped.
- `cd frontend && npx vitest run` runs the frontend tests.
- The mainnet steps and their order are in [ens/RUNBOOK.md](ens/RUNBOOK.md), section 6. Every command is a dry run
  unless you pass `--execute`.

**Mainnet status:** the mainnet one-shot, publish and ledger steps have not been run yet at the time of this
commit (2026-11-06). Everything above is tested on forks and read-only against mainnet. This line is updated
after the run.

**Limits, stated plainly.**

- ENSIP-25 and ENSIP-26 are drafts. `mergit.reputation` is a mirror of the audited outcomes, not the source of
  truth, and it is not the paper's cost-adjusted value density. No figure in the documentation is a benchmark.
- All agent names share one resolver, and ENS scopes a role to the whole resolver (confirmed on a fork, HLD
  L1). So operators hold no ENS role at all: Mergit's key writes after checking ownership on Base.
- Creating an agent is manual in v0 (the `mergit.eth` owner registers it and writes its records, HLD E12). Having
  the planner create agents on demand is future work, as is an automated registrar.
- The Content-Security-Policy is still report-only. Registration files hosted by operators on other origins need
  a server-side proxy. The browser end-to-end specs are not written. Per-user access control over agent data is not
  built (HLD L3).

## Documentation

| | |
| --- | --- |
| [**docs/PRD.md**](docs/PRD.md) | Product requirements — components, receipt format, contracts, economics, phases, open questions |
| [**The paper**](https://github.com/mergit-io/mergit-research/blob/main/paper/draft-v1.md) | The source of truth. Threat model, formal economics, security analysis, limitations |
| [docs/legacy/](docs/legacy/) | Superseded v0.2 documents, kept for reference |

Documentation lived in a separate `mergit-docs` repository until October 2026 and now lives here
under `docs/`.

## Repository layout

| Path | What | Language |
| --- | --- | --- |
| `spec/` | Receipt format, predicate, events, JSON Schemas, test vectors, and the `mergit-spec` crate that hashes them | Markdown, Rust |
| `runtime/` | Receipt builder (`receipt/`) and its Python binding (`py/`, module `mergit_receipt`) | Rust |
| `verifier/` | Receipt verifier library and `mergit-verify` CLI; `wasm/` builds it for the browser. Never imports `runtime/` | Rust |
| `evidence/` | Receipt store (`store/`) and validator (`validator/`) | Rust |
| `chain/` | Contract client (`client/`), chain gateway with payment path and free credits (`gateway/`), generated ABIs (`abi/`) | Rust |
| `control-plane/` | Planner, task graph, approvals, router, agent workers | Python |
| `frontend/` | Web app | TypeScript, React |
| `deploy/` | Docker images, local compose, hosting | |
| `docs/` | PRD, HLD, diagrams, build design and plans | |

The v0 build is planned in [docs/superpowers/plans/](docs/superpowers/plans/).

## Repositories

| | |
| --- | --- |
| [mergit-research](https://github.com/mergit-io/mergit-research) | The paper. Upstream of everything here |
| [mergit-contracts](https://github.com/mergit-io/mergit-contracts) | Solidity — identity, receipt commitments, stake, escrow, challenge |
| [Mergit-proto](https://github.com/mergit-io/Mergit-proto) | Archived v0 prototype |

## Contributing

See [CONTRIBUTING.md](https://github.com/mergit-io/.github/blob/main/CONTRIBUTING.md). Claim an
issue before opening a pull request against it, and implement against the paper or the PRD rather
than against an idea in a thread.

## Licence

Code is **GPL-3.0** ([LICENSE](LICENSE)). Everything under `docs/` is **CC BY 4.0**
([docs/LICENSE](docs/LICENSE)) so documentation contributions do not carry obligations over the
code.
