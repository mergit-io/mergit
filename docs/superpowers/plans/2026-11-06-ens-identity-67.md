# ENS Agent Identity (#67) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything in issue #67 that needs no wallet of ours: the ENSIP-25 key builder, the ERC-8004 registration JSON generator, and the one-shot admin script that is rehearsed on a mainnet fork and can be run for real by the `mergit.eth` owner.

**Architecture:** Pure functions (key, JSON, call list) with unit tests; one runner that performs the one-shot (deploy resolver, grant two key roles to two accounts, one batched record write, point `mergit.eth` at the resolver) against any viem wallet; a fork test that runs it with the owner impersonated and reads every record back through the ENSv2 Universal Resolver; a CLI that defaults to the fork and refuses to touch mainnet without an explicit flag and a key from the environment. Registering agents on Base Sepolia (M2) needs a funded wallet of the user's, so it is a runbook, not code.

**Tech Stack:** Node 24 (type-stripping, erasable syntax only), viem 2.57, `node:test`, anvil. Package: `ens/` (from the #66 plan).

**Spec:** `docs/HLD-ens-integration.md` (E3, E4, E9, E10, E12, sections 6, 8.1, 9, 12), GitHub issue #67, ENSIP-25 (<https://docs.ens.domains/ensip/25/>), ERC-8004 (<https://eips.ethereum.org/EIPS/eip-8004>). Reuses the verified resolver ABI and harness from `docs/superpowers/plans/2026-11-06-ens-gate-m0-m1.md`.

## Global Constraints

- Work on `main`; no branches or PRs. **Never run git write commands**; print commit commands for the user, with no `Co-Authored-By` trailer.
- All code under `ens/`, which is outside every CI path filter (no CI, no deploy).
- Mainnet is **never written by Claude**. The mainnet path reads the owner key from `ENS_OWNER_PRIVATE_KEY` only when the user runs it, never logs it, and refuses to run without `--execute`. Fork runs use impersonation (no key).
- RPC URLs come from the environment (`ENS_MAINNET_RPC`); never hard-coded.
- Deployed resolver API (verified): `setText(bytes name, string key, string value)` with a DNS-encoded name; `grantSetterRoles(bytes setter, address account)`; `multicall(bytes[])`; `initialize((address,uint256)[] grants, bytes[] calls)`. Registry: `setResolver(uint256 anyId, address resolver)` with `anyId = uint256(keccak256("mergit"))`.
- ENSIP-25: key `agent-registration[<ERC-7930 registry>][<agentId>]`, value `"1"`, `agentId` must not contain `[` or `]`. ERC-7930 layout: `0001` + `0000` + chain-ref length (1 byte) + chain ref (minimal big-endian bytes) + address length `14` + 20-byte address. The HLD's value for Identity `0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6` on chain 84532 is `0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6`.
- ERC-8004 registration file `type`: `https://eips.ethereum.org/EIPS/eip-8004#registration-v1`. `agentRegistry` is `eip155:<chainId>:<identityAddress>`.
- Role policy (decision O9, option (a)): publisher account holds key `mergit.reputation` only; editor account holds `agent-context` and `agent-endpoint[web]` only; operators hold nothing. The `mergit.eth` owner is the resolver's admin and the only holder of `agent-registration[...]` writes.
- `agent-endpoint[web]` must be a URL anyone can open. The route is agreed with #71; until then it is configuration, not code.

## Review Focus

1. **Chain id needing more than one byte** (Base mainnet 8453 = `0x2105`): the ERC-7930 chain-reference length byte and bytes must be minimal, not fixed at 3. (Task 1)
2. **Agent id or label with bracket characters, uppercase or a dot** (`coder.0`, `A`, `x]`): refused with a message, never silently encoded into a bad key or name. (Tasks 1, 2)
3. **Registration JSON before the agent id is known** (HLD 8.1 step 1): `registrations` is absent, not `[]` with a placeholder id. (Task 2)
4. **Mainnet run without `--execute` or without a key**: prints the plan and exits non-zero or zero without sending anything; it must never prompt for or echo a key. (Task 5)
5. **A step that fails midway on mainnet** (resolver deployed, grants sent, multicall reverts): the runner stops and reports which step and the addresses so far, and never continues to `setResolver`, so the live name never points at an empty resolver. (Task 4)

---

### Task 1: ENSIP-25 key builder

**Files:** Create `ens/src/ensip25.ts`; Test `ens/test/ensip25.test.ts`

**Interfaces:**
- Produces: `erc7930Address(chainId: number, address: Address): Hex` and `agentRegistrationKey(registry: Address, chainId: number, agentId: string | number | bigint): string`.

- [ ] **Step 1: Write failing tests** with these exact assertions: `erc7930Address(84532, "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6") === "0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6"`; `erc7930Address(1, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432") === "0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432"` (ENSIP-25's worked example); `erc7930Address(8453, <any address>)` starts with `0x0001000002` followed by `2105` and `14`; `agentRegistrationKey(<84532 Identity>, 84532, 5n)` equals `agent-registration[<84532 value>][5]`; `agentRegistrationKey(0x8004A1…, 1, 167)` equals ENSIP-25's `agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]`; ids `"a[b"`, `"x]"` and `""` throw; chain id `0` and a non-address throw.
- [ ] **Step 2: Run and see it fail** (`node --test test/ensip25.test.ts` in `ens/`; module missing).
- [ ] **Step 3: Implement** both functions in `ens/src/ensip25.ts` (chain reference as the minimal big-endian bytes of the chain id).
- [ ] **Step 4: Run and see it pass.**

---

### Task 2: Registration JSON generator

**Files:** Create `ens/src/registration.ts`; Test `ens/test/registration.test.ts`

**Interfaces:**
- Produces: `type AgentInput = { label: string; agentId?: number; name: string; description: string; profileUrl: string; image?: string; supportedTrust?: string[] }`; `registrationFile(agent: AgentInput, chain: { chainId: number; identity: Address }): RegistrationFile`; `serializeRegistration(file: RegistrationFile): string`; `ensNameOf(label: string): string` returning `<label>.mergit.eth`.

- [ ] **Step 1: Write failing tests:** `type` equals the ERC-8004 value; `services` contains `{ name: "ENS", endpoint: "coder-0.mergit.eth", version: "v1" }` and `{ name: "web", endpoint: <profileUrl> }`; with `agentId: 2` and Identity on 84532, `registrations` equals `[{ agentId: 2, agentRegistry: "eip155:84532:0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" }]`; **without** `agentId` the `registrations` key is absent (`"registrations" in file === false`); `active` is `true`, `x402Support` is `false`; default `supportedTrust` is `["reputation"]`; labels `"A"`, `"coder.0"`, `""`, `"-x"`, and one longer than 63 characters throw; `serializeRegistration` returns 2-space JSON ending in a newline and round-trips through `JSON.parse`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** Label rule: lowercase letters, digits and hyphens, not starting or ending with a hyphen, 1 to 63 characters.
- [ ] **Step 4: Run and see it pass.**

---

### Task 3: One-shot call planner (pure)

**Files:** Create `ens/src/oneshot-plan.ts`; Test `ens/test/oneshot-plan.test.ts`

**Interfaces:**
- Consumes: `agentRegistrationKey` (Task 1), `ensNameOf` and `AgentInput` (Task 2), `dnsName` helper moved to `ens/src/dns.ts` (it currently lives in `ens/test/fork.ts`; the fork harness re-exports it).
- Produces: `type OneShotAgent = AgentInput & { agentId: number }`; `agentRecords(agent: OneShotAgent, chain: { chainId: number; identity: Address }): { key: string; value: string }[]` returning exactly three records in this order: the ENSIP-25 attestation (`"1"`), `agent-context` (the description as markdown), `agent-endpoint[web]` (the profile URL); `recordCalls(agents: OneShotAgent[], chain): Hex[]` returning one encoded `setText` per record using the DNS-encoded `<label>.mergit.eth`.

- [ ] **Step 1: Write failing tests:** three agents give nine calls; each call decodes (viem `decodeFunctionData` with the resolver ABI) to `setText` with the expected name, key and value; no call writes `mergit.reputation`; two agents with the same label, or the same `agentId`, throw; an agent with no `agentId` throws.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement**, and move `dnsName` into `ens/src/dns.ts`, re-exporting it from `ens/test/fork.ts` so existing tests keep working.
- [ ] **Step 4: Run the whole offline suite** (`npm test`) and see it pass.

---

### Task 4: One-shot runner and fork rehearsal

**Files:** Create `ens/src/oneshot.ts`; Test `ens/test/oneshot.test.ts`

**Interfaces:**
- Consumes: Task 3, the verified ABIs, `MAINNET`.
- Produces: `type OneShotConfig = { chain: { chainId: number; identity: Address }; agents: OneShotAgent[]; publisher: Address; editor: Address }`; `type StepResult = { step: string; hash: Hex; gasUsed: bigint }`; `type OneShotResult = { resolver: Address; steps: StepResult[] }`; `runOneShot(ctx: { pub: PublicClient; wallet: WalletClient; owner: Address }, cfg: OneShotConfig): Promise<OneShotResult>` performing, in order and awaiting each receipt: deploy the resolver proxy (owner is admin); grant `publisher` the key `mergit.reputation`; grant `editor` the keys `agent-context` and `agent-endpoint[web]`; one `multicall` of all record calls; `ETHRegistry.setResolver(uint256(keccak256("mergit")), resolver)`. On any failed step it throws `Error("one-shot: step <name> failed ...")` whose message lists the steps already completed and the resolver address if deployed, and it never reaches `setResolver`. `verifyOneShot(pub, cfg, resolver): Promise<{ key: string; name: string; ok: boolean; got: string | null }[]>` reading every record back through `getEnsText` with `universalResolverAddress: MAINNET.universalResolverV2`, plus a row for the registry's `getResolver("mergit")` equal to `resolver`.

- [ ] **Step 1: Write failing fork tests** (skipped without `ENS_MAINNET_RPC`): on a fork with the real owner `0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D` impersonated, `runOneShot` with three agents returns five or six steps in the order above and `verifyOneShot` returns all rows `ok`; afterwards the `publisher` account can write `mergit.reputation` on `coder-0.mergit.eth` and the `editor` can write `agent-endpoint[web]`, while a third account cannot write either and the editor cannot write `mergit.reputation` or an `agent-registration[...]` key; a step failure test makes the multicall revert (an agent list containing a record whose key is the empty string is rejected by the planner, so instead pass a wallet wrapper whose `multicall` call throws) and asserts the thrown message names `multicall`, includes the resolver address, and that `getResolver("mergit")` on the fork is **still the original resolver `0xcf0F7486cEa69a644630fA31744882d68f5BC80a`**.
- [ ] **Step 2: Run and see it fail** (module missing).
- [ ] **Step 3: Implement `runOneShot` and `verifyOneShot`.**
- [ ] **Step 4: Run and see it pass**; record each step's gas and compare with `ens/gas-report.json` (a deviation above 25% is a finding for the HLD).

---

### Task 5: Config loader, CLI, registration files, runbook

**Files:** Create `ens/src/config.ts`, `ens/src/oneshot-cli.ts`, `ens/src/registration-cli.ts`, `ens/agents.example.json`, `ens/RUNBOOK.md`; Test `ens/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(path: string): OneShotConfig` (reads JSON `{ chainId, identity, publisher, editor, agents: [...] }`, validates every address with viem `isAddress(strict)`, rejects duplicate labels and agent ids, a missing `profileUrl`, and a `profileUrl` that is not `https://`).

- [ ] **Step 1: Write failing tests** for `loadConfig`: the example file loads; a non-address `publisher`, a duplicate label, a duplicate `agentId`, a missing `profileUrl`, and an `http://` profile URL each throw an error naming the field.
- [ ] **Step 2: Run and see it fail**, then **Step 3: implement `loadConfig`** and `ens/agents.example.json` with three sample agents (`coder-0`..`coder-2`, agent ids 2 to 4, Base Sepolia Identity `0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6`, chain 84532, profile URLs `https://mergit.site/agents/<name>` marked in the runbook as the route to agree with #71, `publisher`/`editor` set to two placeholder addresses the user must replace).
- [ ] **Step 4: `oneshot-cli.ts`:** `node src/oneshot-cli.ts <config> --fork` starts a fork, impersonates the owner, runs and verifies, prints the steps with gas and the verify table, exits 1 if any row is not ok. `--mainnet` without `--execute` prints the plan (steps and calldata sizes) and exits 0 without sending; with `--execute` it requires `ENS_OWNER_PRIVATE_KEY` and `ENS_MAINNET_RPC`, derives the account, checks it equals the owner read from chain (refuse otherwise) and that its ETH balance covers the estimated gas, then runs and verifies. It never prints the key. **Registration files:** `registration-cli.ts <config> <outDir>` writes `<outDir>/<label>.json` for each agent using Task 2.
- [ ] **Step 5: Run the fork rehearsal for real:** `NODE_USE_ENV_PROXY=1 ENS_MAINNET_RPC=<url> node src/oneshot-cli.ts agents.example.json --fork` and read the table; and run `--mainnet` without `--execute` and confirm nothing is sent.
- [ ] **Step 6: `RUNBOOK.md`:** the user's steps for M2 (host the JSON, `cast send` the `registerAgent(address,string)` call on Base Sepolia, read back `agentId` and `tokenURI`, regenerate the JSON with the id), then the mainnet run (`--mainnet` first, then `--execute`), what to check afterwards in the ENS app, and what is still open (O5 host, #71 route, funding).

---

## Self-review

- **Spec coverage (#67):** registration JSON (Task 2), registration on Base Sepolia (runbook, needs the user's wallet), admin script on the fork with read-back (Tasks 3, 4), runbook for creating new agents by hand (Task 5), profile URL from #71 (configuration), role grants per #66 (Task 4). The `Depends on #66` item is satisfied by the role policy constant above.
- **Not built here, by design:** hosting the JSON (O5, the user's choice), registering agents on Base Sepolia (needs the user's funded wallet), and the mainnet run (needs ETH, O2).
- **Types:** `OneShotAgent`, `OneShotConfig`, `StepResult`, `OneShotResult`, `AgentInput`, `registrationFile`, `agentRecords`, `recordCalls`, `runOneShot`, `verifyOneShot`, `loadConfig` are each defined once and used with the same names later.
