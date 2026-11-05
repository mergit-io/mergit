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

## Documentation

| | |
| --- | --- |
| [**docs/PRD.md**](docs/PRD.md) | Product requirements — components, receipt format, contracts, economics, phases, open questions |
| [**The paper**](https://github.com/mergit-io/mergit-research/blob/main/paper/draft-v1.md) | The source of truth. Threat model, formal economics, security analysis, limitations |
| [docs/legacy/](docs/legacy/) | Superseded v0.2 documents, kept for reference |

Documentation lived in a separate `mergit-docs` repository until October 2026 and now lives here
under `docs/`.

## ETHGlobal Mumbai — Arkiv track

Continuity Track pick: Arkiv's ["Build on Arkiv (existing projects)"](https://ethglobal.com/events/mumbai/prizes/arkiv).
Mergit's router already picks agents for a task and, on an exploring call, records the draw in its
own Postgres (`routing_decisions`, pre-existing); what's new at this event is a second, public copy
of each exploring decision written to Arkiv's Rabdi testnet and read back through a new endpoint.
Full writeup: [`arkiv/schema.md`](arkiv/schema.md), [`arkiv/why-arkiv.md`](arkiv/why-arkiv.md),
[`arkiv/how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md), [`arkiv/reach.md`](arkiv/reach.md),
[`arkiv/friction.md`](arkiv/friction.md).

- **Service wallet (writes every mirrored entity):** `<TODO: fill in once ARKIV_PRIVATE_KEY is set
  on the hosted deploy — see arkiv/friction.md>`
- **One query anyone can run**, against `https://rpc.rabdi.db-chain.testnet.arkiv.network`
  (`arkiv_query`) or through the hosted app's `GET /v0/plans/{uuid}/arkiv-suggestions`:
  ```
  kind = "mergit.routing_decision" AND planId = "<a real plan_id from a live run>"
  ```
- **In the app:** the live run screen's "Suggested agents" panel, after asking for an exploring
  suggestion, shows a "View on Arkiv" button that reads the mirrored entities back from Arkiv live
  (`frontend/src/screens/live/run/SuggestAgents.tsx`).
- **AI disclosure:** this track's implementation (`mergit_cp/arkiv_mirror.py`, the
  `/arkiv-suggestions` route, the frontend panel, the `arkiv/*.md` files, this section) was written
  with AI assistance (Claude Code), reviewed and tested by the team before merging.

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
