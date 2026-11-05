# Mergit: ENS Naming Layer, High-Level Design

**Version:** 0.1-draft
**Status:** Planning. Nothing described here is built. Written for ETHGlobal Mumbai (5 to 7 November 2026), ENS Continuity prize.
**Last updated:** 2026-11-05
**Relationship to the main HLD:** an addendum to [`HLD.md`](HLD.md). Where this document and the paper disagree, the paper wins and this document is the defect (see [`CLAUDE.md`](../CLAUDE.md)).

Every statement carries one of three labels, as in the main HLD.

| Label | Meaning |
| --- | --- |
| **Locked** | A fact from the repository, the chain, or the prize rules. Changing it means changing the source. |
| **Proposed** | Recommended by this document. The team has not agreed. |
| **Open** | Undecided. Listed in section 12 with what it blocks. |

Diagram sources are editable Excalidraw files in [`diagrams/`](diagrams/). The PNGs in `diagrams/preview/` are approximate renders. Open the `.excalidraw` file at <https://excalidraw.com> to edit.

---

## 1. Purpose

Give every Mergit agent a human-readable, verifiable identity on ENS, and publish a labelled mirror of its audited reputation there, so that anyone can look up `coder-0.mergit.eth` and learn which Mergit agent it is, where to reach it, and what the chain says about its audited work, without trusting Mergit's servers.

Why this fits Mergit and is not a bolt-on:

- Mergit's agents are identified today by a number (`agentId`) in an ERC-721 contract and by hex addresses. Neither is something a requester can recognise or remember.
- ENSv2 can restrict who may write each record. That lets the naming layer enforce a Mergit rule, **only validated outcomes update reputation** (invariant 4), at the record level.
- ENSIP-25 and ENSIP-26 (both drafts) define how an ENS name attests to an agent registry entry and advertises an agent's endpoints. Mergit's Identity contract is ERC-8004-compatible in shape, so the link is natural.

## 2. The prize and what judges check

Source: the ETHGlobal Mumbai prize page, read on 2026-11-05. The track description was read through a summariser and the screenshot the team shared. Confirm the exact wording on the page before submitting.

- **Prize:** "Best Integration of ENSv2 into an Existing Project", $3,000 (first $2,000, second $1,000). Continuity Track participants only. **Locked.**
- **Must use ENSv2 on Ethereum mainnet** and integrate it into an existing project. **Locked.**
- It should be clear how ENSv2 improves the project, not just a cosmetic add-on. **Locked.**
- The demo must be functional and not rely on hard-coded values. **Locked.**
- A live demo link and open-source code on GitHub or a similar platform, at submission. **Locked.**
- The track's own wording suggests agents as namespaces and gives bonus points for bringing AI agents into the project. **Locked** (from the page summary).

Two consequences drive the whole design:

1. A Sepolia-only integration does not qualify. Mainnet is required.
2. "No hard-coded values" means the web app must resolve names and records from mainnet at runtime.

## 3. Context

![ENS naming layer: where it sits](diagrams/preview/12-ens-naming-layer.png)

Source: [`diagrams/12-ens-naming-layer.excalidraw`](diagrams/12-ens-naming-layer.excalidraw)

Settlement and receipts stay on Base Sepolia with test USDC. ENS runs on Ethereum mainnet. Nothing in Mergit's money path depends on ENS. If the naming layer fails, tasks still run, settle and audit. This is deliberate: the ENS layer is read-mostly and has no authority over funds.

## 4. Decisions

| # | Decision | Status | Why |
| --- | --- | --- | --- |
| E1 | Settlement stays on Base Sepolia, test USDC. ENS is the only mainnet component. | **Locked** | The v0 spec is testnet-only for money. |
| E2 | Parent name is `mergit.eth`, owned by the team wallet. | **Locked** (per Yash, 2026-11-05). Owner wallet **not verified on chain** by this document | Removes the name-registration fee and the biggest blocker. |
| E3 | Subnames use the **records-only** design: one Permissioned Resolver on the parent holds every agent's records. No per-agent tokens, no registry contract deployed. | **Proposed** | Cheapest on mainnet, no Solidity of our own to audit, still uses ENSv2 per-record permissions. |
| E4 | The registration JSON for each agent is hosted at an editable HTTPS URL. | **Proposed** | The Identity contract has no `setAgentURI`. The URL is fixed at `registerAgent`, so the content must stay editable. |
| E5 | Reputation on ENS is a **labelled mirror** of `ReputationAnchor`, never the source of truth. Only tier 0 (staked) outcomes are counted. | **Proposed** | Invariants 4 and 6. See section 7. |
| E6 | One hot key (the "publisher") may write the single record `mergit.reputation`. No other writer can. | **Proposed**, depends on O1 | The enforcement of invariant 4 at the record level. |
| E7 | The owned-token registry per agent is a stretch goal, not part of the core plan. | **Proposed** | Roughly $0.45 of gas by estimate, more code, ENS's own tutorial calls its registrar unaudited. |
| E8 | The ENS part contains no Solidity of ours. | **Proposed** | Follows from E3. Certora has nothing to verify here (section 10). |
| E9 | Agents registered before the URL scheme exists (agent #1 on Base Sepolia, empty URL) are not linked. New agents are registered for the demo. | **Locked** | The Identity contract cannot change a URL after registration. |

## 5. Components

| Component | New or existing | Responsibility |
| --- | --- | --- |
| **Registration JSON host** | New | Serves one JSON file per agent at a stable HTTPS URL. The file names the ENS name and lists `registrations`. Editable after on-chain registration. Host is **Open** (O5). |
| **ENS admin script** | New | One-shot TypeScript script run by the `mergit.eth` owner. Sets the resolver, grants the roles, writes the agent records in one batched call. Runs first on a mainnet fork, then once on mainnet. |
| **ENS publisher** | New | A small service that reads `OutcomeRecorded` events from `ReputationAnchor`, counts tier 0 outcomes per agent, and writes `mergit.reputation`. Holds the publisher key. |
| **Web app: ENS reads** | Existing app, new code | Resolves names live, shows `agent-endpoint` and `mergit.reputation`, performs the two-way link check, and shows which account wrote each record. |
| **Chain gateway, validator, contracts** | Existing, unchanged | No change to receipts, escrow, stake or reputation recording. |

Tools: viem 2.35.0 or later, ENSjs 5.2.5 or later for ENSv2 writes (from the ENS readiness page). The Rust services are not touched except to expose what the publisher reads, if the publisher is not written in TypeScript (**Open**, O6).

## 6. Names and records

### 6.1 Naming

Subnames take the form `<label>.mergit.eth`, for example `coder-0.mergit.eth`. The label is chosen by the operator at registration and is unique under the parent. **Proposed.**

### 6.2 Records on each subname

| Key | Standard | Value | Who may write it |
| --- | --- | --- | --- |
| `agent-registration[<ERC-7930 Identity address>][<agentId>]` | ENSIP-25 (draft) | `"1"` (any non-empty value counts) | Mergit admin (parent owner) |
| `agent-context` | ENSIP-26 (draft) | Markdown text describing the agent and how to use it | Operator |
| `agent-endpoint[web]` | ENSIP-26 (draft) | URL of the agent's profile page | Operator |
| `mergit.reputation` | Mergit-defined (not a standard) | JSON mirror, see 6.3 | Publisher key only |

For the Mergit Identity contract on Base Sepolia, the ERC-7930 encoding of `0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6` on chain 84532 is:

```
0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6
```

This was derived with the format in the ENSIP-25 example, and the derivation reproduces that example's mainnet value exactly. Verify against the ERC-7930 text before relying on it. If the Identity contract is redeployed the value changes.

The full key for agent `N` is `agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][N]`.

### 6.3 `mergit.reputation` (Proposed)

```json
{
  "v": 0,
  "mirror": true,
  "source": { "chainId": 84532, "contract": "0xf9DBfF75887361A67269765DA6F8732b233Fda76" },
  "asOfBlock": 0,
  "auditedStaked": 0,
  "verifiedStaked": 0,
  "note": "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth."
}
```

- It carries counts only. It is not the paper's value density and must not be presented as one.
- Every figure comes from chain events at a stated block. No number is presented as measured beyond that.
- The record is overwritten, not appended. History stays on chain in `OutcomeRecorded`.

## 7. Permission model and invariants

Three kinds of account touch the resolver. ENSv2 Enhanced Access Control grants roles per resolver and, according to the ENS docs, can scope a role to a specific text key.

| Account | May write | Must not write |
| --- | --- | --- |
| Operator (agent owner) | `agent-context`, `agent-endpoint[...]` | `mergit.reputation`, `agent-registration[...]` |
| Mergit admin (`mergit.eth` owner) | `agent-registration[...]`, role grants | Day-to-day reputation |
| Publisher key | `mergit.reputation` only | Everything else |

How this maps to the repository invariants:

| Invariant | How the design respects it |
| --- | --- |
| 4. Only validated outcomes update reputation | The publisher reads only `OutcomeRecorded`, which `ReputationAnchor` emits for audited verdicts and challenge rulings. No operator can write the record. |
| 6. Faucet-tier work accrues no transferable reputation | `OutcomeRecorded` carries `tier` (0 staked, 1 onboarding). The publisher counts tier 0 only. A test must assert tier 1 events do not change the record. |
| 7. No credential reachable from a model-populated tool argument | The publisher key lives with the chain gateway's secrets, resolved through the broker, never in a place a prompt reaches. Where it is stored is **Open** (O7). |
| "No number presented as measured" | Section 6.3. Counts, block number, labelled mirror. |

**Open (O1):** the ENS docs say roles can be scoped "to all records or specific text keys", and that to limit a writer to certain names you use a separate resolver instance. The exact granularity (per key across all names on a resolver, or per key per name) is not fully specified in the pages read. The design needs "publisher can write only `mergit.reputation`". This is the first spike. If it cannot be done, the fallback is a second resolver instance dedicated to the publisher's record, which changes the layout in the diagram.

## 8. Flows

![Registration, two-way link and reputation mirror](diagrams/preview/13-ens-agent-registration-and-verification.png)

Source: [`diagrams/13-ens-agent-registration-and-verification.excalidraw`](diagrams/13-ens-agent-registration-and-verification.excalidraw)

### 8.1 Register an agent and link it (steps 1 to 6)

1. **Host the registration JSON** at a stable HTTPS URL. It names the ENS name (`coder-0.mergit.eth`). The `agentId` is not yet known.
2. **Operator calls `registerAgent(runtimeKey, metadataURI)`** with that URL. The URL is now fixed on chain.
3. **Identity mints agent `N`.** The JSON is edited to list `registrations`: the Identity address on chain 84532 and `N`.
4. **Admin script sets the records** on `coder-0.mergit.eth` in one multicall: the ENSIP-25 attestation, `agent-context`, `agent-endpoint[web]`.
5. **The web app resolves the name live** and reads `agent-registration[...][N]`.
6. **The web app reads `Identity.tokenURI(N)`**, fetches the JSON, and compares the name. Both sides agree: it shows "two-way verified". If either side is missing or mismatched, it shows what failed and does not show a tick.

ENSIP-25 notes that if an ENS name changes owner, old records may be stale. The web app should show the current owner of the name beside the verification result. **Proposed.**

### 8.2 Publish the reputation mirror (step 7)

After the validator or challenge manager records an outcome, the publisher reads the event, recomputes the agent's tier 0 counts, and writes `mergit.reputation`. A write by any other account must revert. That revert is a test, not a hope.

## 9. Environments, cost and rollout

![Build plan, environments, cost, Certora](diagrams/preview/14-ens-build-plan-and-environments.png)

Source: [`diagrams/14-ens-build-plan-and-environments.excalidraw`](diagrams/14-ens-build-plan-and-environments.excalidraw)

| Stage | Where | Cost | What it proves |
| --- | --- | --- | --- |
| 1 Verify | Mainnet reads | Free | ENSv2 resolution is live on mainnet (done, see section 14). Role granularity spike (O1). |
| 2 Build | Sepolia ENSv2 and a local mainnet fork | Free. Sepolia needs faucet ETH and free MockUSDC | Scripts, roles, records, web reads, publisher. |
| 3 Dry-run | The mainnet fork | Free | The exact mainnet script, every record read back, operator write to `mergit.reputation` reverts. |
| 4 Mainnet one-shot | Ethereum mainnet | Gas only | The real, live integration the prize requires. Reads afterwards are free. |

### 9.1 Cost model (estimates, not measurements)

- Measured on 2026-11-05: mainnet gas about 0.125 to 0.137 gwei, ETH about $2,416 (Chainlink ETH/USD feed on mainnet).
- Gas units are **guesses**: one `setText` 60k, a three-agent batched write 350k, a role grant 80k. A JSON text record of about 150 bytes may cost more than 60k, so treat the cheapest case as optimistic.
- At those figures the records-only flow is roughly **$0.15 to $0.25 in gas**. A small registry deployment (not planned) would be about $0.45.
- Gas can spike. These figures are one reading, taken once.
- No registration fee is expected because `mergit.eth` is already owned. The renewal date was **not checked**; check it in the ENS app.

### 9.2 Funding (Open)

- The team holds about 0.3 USDC on Ethereum mainnet. **USDC cannot pay gas.** A swap needs ETH first.
- The address that `mergit.eth` resolves to (`0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D`) held **0 ETH and 0 USDC** when checked on 2026-11-05. It may not be the funded wallet.
- Options, none verified: a gasless swap on CoW Swap, a small ETH loan from a teammate, or a mentor. See O2.
- Base Sepolia faucet funds cover the Mergit side only and have no value on mainnet.

## 10. Certora track (separate, not on the ENS critical path)

**Locked:** Certora publishes an official Claude Code skill, `certora/autoprover-skill`, which writes Certora Prover specifications for a Solidity contract and runs them in Certora's cloud. Its README states a free tier of 2,000 prover minutes a month, and Certora's pricing page confirms a free "Basic" plan at that size.

**Proposed:** use it on `Escrow` and then `StakeVault` in `mergit-contracts`, as a background task. These two contracts hold money and the contracts README says nothing is audited.

- It is a test of the tool the founder asked the team to try, and a head start on the paper's safety claims. It does not contribute to the ENS prize.
- The ENS design (E8) contains no Solidity of ours. There is nothing for the Prover to check in the ENS work, and the plan does not invent a contract to give it something.
- The output is a report in `certora/report/`. A clean report does not mean the contract is secure. It covers only the properties written.

Install (the user runs this; the key is secret and must not go into chat, issues, or the repo):

```
export CERTORAKEY=...        # from certora.com/signup
claude plugin marketplace add Certora/autoprover-skill
claude plugin install certora-autoprover@certora-skills
```

Known risks: `foundry.toml` pins solc 0.8.33 and it is unknown whether Certora's compiler manager offers that version (O8). One main contract per run, 40 minutes to 2 hours each by the README. Every run uploads the contract source to Certora's cloud. `mergit-contracts` is MIT-licensed and public, so that is acceptable here. Read the plugin's files before giving it a key.

## 11. Risks

| # | Risk | Likelihood and effect | Mitigation |
| --- | --- | --- | --- |
| R1 | Role scoping cannot limit the publisher to one key | Unknown. Breaks E6 | Spike first (O1). Fallback: dedicated resolver instance. |
| R2 | No ETH on mainnet when it is time to write | High, given 0 ETH seen. Blocks stage 4 | Resolve O2 early. Keep the mainnet step minimal. |
| R3 | Mainnet write fails and wastes the small budget | Medium | Dry-run the exact script on a fork. Check the owner wallet first. |
| R4 | `mergit.eth` is not controlled by the wallet the team can sign with | Unknown. Blocks everything | Verify the owner on chain before stage 2 (O3). |
| R5 | ENSIP-25 and ENSIP-26 are drafts and may change | Medium | Pin the key format in one place. Say "draft" in the README. |
| R6 | The reputation mirror is read as a score or a measurement | Medium. Over-claiming is the failure this project is about | Keep `mirror: true` and the note field. UI labels it "mirror of chain data". |
| R7 | Publisher key compromise | Low to medium. Writes a false mirror, cannot touch funds | Role limited to one record. Mirror is labelled. Chain remains the source of truth. |
| R8 | Two chains confuse judges | Medium | State it plainly: agents and money on Base Sepolia, names on Ethereum mainnet. |
| R9 | Registration JSON host goes away and the two-way link breaks | Low | Host on infrastructure the team already runs. The check fails visibly, not silently. |
| R10 | Time. The event runs 5 to 7 November, and the team's hours are not known | High | Order work by dependency (section 13). Cut the stretch goals first. |

## 12. Open decisions

| # | Question | Blocks |
| --- | --- | --- |
| O1 | Can a writer be limited to a single text key, per name or per resolver? | E6, the permission model |
| O2 | Where does the mainnet ETH come from? | Stage 4 |
| O3 | Which wallet owns `mergit.eth`, is it the one that will sign, and when does the name expire? | Stage 2 onward |
| O4 | How many prizes will the team enter, and does ENS compete with another track for the same hours? | Scope |
| O5 | Where is the registration JSON hosted (the `mergit.site` Render site, or the research site on GitHub Pages)? | Step 1 of the flow |
| O6 | Is the publisher TypeScript, or Rust beside the chain gateway? | Section 5 |
| O7 | Where does the publisher key live, and how is it resolved without a model-reachable path? | Invariant 7 |
| O8 | Does Certora's compiler support solc 0.8.33? | Section 10 |
| O9 | Does Continuity Track status let the project also enter the open "Best Use of ENSv2" track ($7,000, Sepolia allowed)? Ask the ENS mentors. | Fallback path |

## 13. Milestones

No clock times: the team's available hours are unknown. Order is by dependency.

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Verify ownership and funding (O2, O3) | The owner wallet of `mergit.eth` is read from chain, a funding route exists |
| M1 | Role spike (O1) | A test on the fork shows the publisher writes `mergit.reputation` and an operator write to it reverts |
| M2 | Registration JSON and agent registration | A new agent registered on Base Sepolia with the editable URL, JSON edited with its `agentId` |
| M3 | Admin script on the fork | Records written, read back through the Universal Resolver, matching expectations |
| M4 | Web app reads and two-way check | The page resolves the name live and shows verified or the exact failure |
| M5 | Publisher | `OutcomeRecorded` tier 0 events change `mergit.reputation`, tier 1 events do not |
| M6 | Mainnet one-shot | The admin script runs once on mainnet. Records resolve on the live site |
| M7 | Submission | README with pre-event and new work separated, live URL, repo link, demo video if required |

Stretch, only if everything above is done: the owned-token registry (E7), a DNS name import, role delegation to operators from the web app.

### 13.1 Submission checklist

- [ ] Live demo link resolves names from mainnet, no hard-coded values
- [ ] Code is open source (code GPL-3.0, docs CC BY 4.0, contracts MIT, per the repository)
- [ ] README states what existed before the event and what is new. The v0 build design planned a `pre-ethglobal` tag on 30 October. Confirm it exists, because this document did not check
- [ ] README says plainly: agents and money are on Base Sepolia, names are on Ethereum mainnet
- [ ] README labels ENSIP-25 and ENSIP-26 as drafts and the reputation record as a mirror
- [ ] A test shows an operator write to `mergit.reputation` reverts
- [ ] A test shows a tier 1 outcome does not change `mergit.reputation`

## 14. What was verified, and how

| Claim | How it is known | Status |
| --- | --- | --- |
| ENSv2 resolution is live on Ethereum mainnet | The ENS readiness page's test name `ur.integration-tests.eth` resolved to `0x2222…2222` on a mainnet RPC on 2026-11-05 | **Verified** by query |
| Prize rules and amounts | ETHGlobal Mumbai prize page, read through a summariser, plus the team's screenshot | **Read, not independently re-checked** |
| `mergit.eth` is owned by the team | Stated by Yash on 2026-11-05. It resolves to an address on mainnet. The old v1 registrar returns "not registered", which is consistent with a v2-era registration but does not prove who owns it | **Stated, not verified** |
| Identity has no URL setter | Read from `mergit-contracts/src/Identity.sol` | **Verified** from source |
| `OutcomeRecorded` carries `tier` | Read from `ReputationAnchor.sol` and its interface | **Verified** from source |
| Base Sepolia addresses | `mergit-contracts/deployments/base-sepolia.json`. Not checked on chain | **Read from file** |
| Gas and ETH price | Public mainnet RPC and Chainlink feed, 2026-11-05 | **Measured once** |
| Role scoping per text key | ENS docs (Issuing Subnames page) | **Read, granularity unclear** |
| ENSIP-25 and ENSIP-26 key formats | ENS docs, both marked draft | **Read** |
| Certora skill and free tier | Certora GitHub and pricing page | **Read** |
| ENS registrar fee for new `.eth` names | Not found in the docs read | **Unknown** |

## 15. Sources

- ENSv2 overview: <https://docs.ens.domains/ensv2/overview/>
- ENSv2 app developer guide: <https://docs.ens.domains/ensv2/tutorial-app-developers/>
- Issuing subnames: <https://docs.ens.domains/ensv2/subnames>
- Subname registrar tutorial: <https://docs.ens.domains/ensv2/tutorial-contract-developers>
- ENSv2 readiness: <https://docs.ens.domains/web/ensv2-readiness>
- ENSIP-25: <https://docs.ens.domains/ensip/25/>
- ENSIP-26: <https://docs.ens.domains/ensip/26/>
- ERC-8004: <https://eips.ethereum.org/EIPS/eip-8004>
- ETHGlobal Mumbai prizes: <https://ethglobal.com/events/mumbai/prizes>
- Certora pricing: <https://www.certora.com/pricing>
- Certora AutoProver skill: <https://github.com/certora/autoprover-skill>
