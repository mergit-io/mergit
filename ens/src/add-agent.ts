import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, getAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { MAINNET } from "./deployments.ts";
import { permissionedRegistryAbi } from "./abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { agentRegistrationKey } from "./ensip25.ts";
import { generateNamedKeys } from "./keygen.ts";
import { agentRecords, recordCalls, type OneShotAgent } from "./oneshot-plan.ts";
import { verifyOneShot, type OneShotConfig, type StepResult, type VerifyRow } from "./oneshot.ts";
import { ensNameOf } from "./registration.ts";
import { writeRegistrationFiles } from "./registration-files.ts";
import { isRevert, readTextRecord } from "./resolver-read.ts";

/** The slice of the Identity contract this flow uses. `AgentRegistered` is where the real id is read from, not the preview. */
export const identityAbi = parseAbi([
  "function registerAgent(address runtimeKey, string metadataURI) returns (uint256 agentId)",
  "function operatorOf(uint256 agentId) view returns (address)",
  "function runtimeKeyOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event AgentRegistered(uint256 indexed agentId, address indexed operator, address runtimeKey, string metadataURI)",
]);

export const DEFAULT_REGISTRATION_URL_BASE = "https://mergit.site/registrations";
const PROFILE_URL_BASE = "https://mergit.site/agents";
const MAINNET_CHAIN_ID = 1;
// Measured on a fork: one multicall of the three records (see the gas line the test prints). The balance check wants twice
// this at the current gas price, the same headroom the one-shot uses, since the price moves.
const ESTIMATED_UNITS = 450_000n;
const HEADROOM = 2n;

export type AddAgentContext = {
  mainnet: PublicClient;
  base: PublicClient;
  /** agents.json as loaded: the chain (Identity address and id) and the agents that exist already. */
  cfg: OneShotConfig;
  /** Where `<label>.json` is written (the site's `frontend/public/registrations`). */
  registrationDir: string;
  /** Public URL prefix of that folder; the metadata URI registered on chain is `<this>/<label>.json`. */
  registrationUrlBase?: string;
  /**
   * The text of control-plane/agents.toml. When given, the label must have an `[agents.<label>]` stanza: the web app shows
   * an agent under the ENS label equal to its platform name and never rewrites it, so a label the platform does not run
   * would be registered on chain and then read "not verified" forever.
   */
  agentsToml?: string;
};
/** `agentId` is the rerun switch: the agent is already registered on Base, so only the steps after `registerAgent` are done. */
export type AddAgentInput = { label: string; description: string; agentId?: number };

export type AddAgentPlan = {
  label: string;
  ensName: string;
  /** The agent as it will be appended to agents.json; `agentId` is the preview for a new agent and the real id for a rerun. */
  agent: OneShotAgent;
  agentId: number;
  rerun: boolean;
  owner: Address;
  resolver: Address;
  metadataUri: string;
  registrationPath: string;
  /** Null until the key exists: a dry run makes no key. For a rerun, the key registered on chain. */
  runtimeKey: Address | null;
  records: { key: string; value: string }[];
};

export type PlanFailureCode =
  | "invalid-label" | "no-agent-stanza" | "duplicate-label" | "duplicate-agent-id" | "wrong-chain" | "read-failed"
  | "no-resolver" | "one-shot-not-run" | "name-in-use" | "registration-file-exists" | "agent-mismatch" | "preview-failed";
export type PlanResult = { ok: true; plan: AddAgentPlan } | { ok: false; code: PlanFailureCode; message: string };

export const shortError = (e: unknown): string => {
  const x = e as { shortMessage?: string; message?: string };
  return (x?.shortMessage ?? String(x?.message ?? e)).split("\n")[0]!;
};

/**
 * Checks everything that can be checked without sending anything, in the order a user would fix things, and previews what
 * `--execute` would do: the id `registerAgent` will return, the file and URL, the runtime key (rerun only) and the three records.
 * Every refusal is a typed outcome; nothing here throws for a refusal and nothing here writes.
 */
export async function planAddAgent(ctx: AddAgentContext, input: AddAgentInput): Promise<PlanResult> {
  const fail = (code: PlanFailureCode, message: string): PlanResult => ({ ok: false, code, message });
  const { cfg } = ctx;
  let ensName: string;
  try { ensName = ensNameOf(input.label); } catch (e) { return fail("invalid-label", (e as Error).message); }
  if (ctx.agentsToml !== undefined && !new RegExp(`^\\[agents\\.${input.label}\\]`, "m").test(ctx.agentsToml)) {
    return fail("no-agent-stanza", `control-plane/agents.toml has no [agents.${input.label}] stanza. The label is the agent's platform name (the web app looks the ENS name up by it), so add that stanza (provider, model, system_prompt) first, then run this again.`);
  }
  if (cfg.agents.some((a) => a.label === input.label)) return fail("duplicate-label", `${input.label} is already in agents.json; pick another label (to finish a half-done add, use --agent-id instead).`);
  if (input.agentId !== undefined && cfg.agents.some((a) => a.agentId === input.agentId)) return fail("duplicate-agent-id", `agent id ${input.agentId} already belongs to another agent in agents.json.`);

  const rerun = input.agentId !== undefined;
  const metadataUri = `${(ctx.registrationUrlBase ?? DEFAULT_REGISTRATION_URL_BASE).replace(/\/+$/, "")}/${input.label}.json`;
  const registrationPath = join(ctx.registrationDir, `${input.label}.json`);
  const UR_OWNER = { address: MAINNET.ethRegistry, abi: permissionedRegistryAbi } as const;

  let owner: Address;
  let resolver: Address;
  try {
    if ((await ctx.mainnet.getChainId()) !== MAINNET_CHAIN_ID) return fail("wrong-chain", "ENS_MAINNET_RPC is not an Ethereum mainnet endpoint (chain id is not 1).");
    if ((await ctx.base.getChainId()) !== cfg.chain.chainId) return fail("wrong-chain", `BASE_SEPOLIA_RPC is not chain ${cfg.chain.chainId} (the chain in agents.json).`);
    owner = (await ctx.mainnet.readContract({ ...UR_OWNER, functionName: "findOwner", args: ["mergit"] })) as Address;
    resolver = (await ctx.mainnet.readContract({ ...UR_OWNER, functionName: "getResolver", args: ["mergit"] })) as Address;
  } catch (e) { return fail("read-failed", `reading mergit.eth from mainnet failed: ${shortError(e)}`); }

  // mergit.eth must already point at a live resolver, and it must be the one the one-shot filled: writing to any other
  // resolver would orphan the new records the next time the name is repointed.
  let code: string | undefined;
  try { code = resolver === zeroAddress ? undefined : await ctx.mainnet.getCode({ address: resolver }); } catch (e) { return fail("read-failed", `reading the resolver code failed: ${shortError(e)}`); }
  if (!code || code === "0x") return fail("no-resolver", `mergit.eth does not point at a resolver with code (registry says ${resolver}). Run the one-shot first (ens/RUNBOOK.md, section 2).`);
  try {
    const registered = cfg.agents.filter((a) => a.agentId !== undefined);
    let seen = registered.length === 0;
    for (const a of registered) {
      if (await readTextRecord(ctx.mainnet, resolver, ensNameOf(a.label), agentRegistrationKey(cfg.chain.identity, cfg.chain.chainId, a.agentId!))) { seen = true; break; }
    }
    if (!seen) return fail("one-shot-not-run", `none of the agents in agents.json has its agent-registration record on the current resolver of mergit.eth (${resolver}). Run the one-shot first (ens/RUNBOOK.md, section 2).`);
  } catch (e) { return fail("read-failed", (e as Error).message); }

  // the Base side: the id a new registration will get, or (rerun) proof that the given agent is this one
  let agentId: number;
  let runtimeKey: Address | null = null;
  try {
    if (rerun) {
      agentId = input.agentId!;
      const read = (functionName: "tokenURI" | "operatorOf" | "runtimeKeyOf") => ctx.base.readContract({ address: cfg.chain.identity, abi: identityAbi, functionName, args: [BigInt(agentId)] });
      let uri: string, operator: Address;
      try { [uri, operator, runtimeKey] = [(await read("tokenURI")) as string, (await read("operatorOf")) as Address, (await read("runtimeKeyOf")) as Address]; }
      catch (e) { if (isRevert(e)) return fail("agent-mismatch", `agent ${agentId} does not exist on chain ${cfg.chain.chainId}.`); throw e; }
      if (uri !== metadataUri) return fail("agent-mismatch", `agent ${agentId} has metadata URI ${JSON.stringify(uri)}, expected ${metadataUri}.`);
      if (!isAddressEqual(operator, owner)) return fail("agent-mismatch", `agent ${agentId} has operator ${operator}, not the owner of mergit.eth (${owner}).`);
    } else {
      // the runtime key does not matter for the id: any non-zero address previews the same registration
      const sim = await ctx.base.simulateContract({ address: cfg.chain.identity, abi: identityAbi, functionName: "registerAgent", args: [owner, metadataUri], account: owner });
      agentId = Number(sim.result);
    }
  } catch (e) { return fail(rerun ? "read-failed" : "preview-failed", `${rerun ? "reading" : "previewing"} the agent on Base failed: ${shortError(e)}`); }

  const agent: OneShotAgent = { label: input.label, name: input.label, description: input.description, profileUrl: `${PROFILE_URL_BASE}/${ensName}`, agentId };
  const records = agentRecords(agent, cfg.chain);
  if (!rerun) {
    try {
      for (const r of records) {
        if (await readTextRecord(ctx.mainnet, resolver, ensName, r.key)) return fail("name-in-use", `${ensName} already has a ${r.key.length > 40 ? r.key.slice(0, 22) + "..." : r.key} record on ${resolver}; adding the agent would overwrite it.`);
      }
    } catch (e) { return fail("read-failed", (e as Error).message); }
    if (existsSync(registrationPath)) return fail("registration-file-exists", `${registrationPath} already exists; it would be overwritten. If a previous run registered this agent and stopped, rerun with --agent-id <id> (the failure message named it); otherwise move the file away or pick another label.`);
  }
  return { ok: true, plan: { label: input.label, ensName, agent, agentId, rerun, owner: getAddress(owner), resolver: getAddress(resolver), metadataUri, registrationPath, runtimeKey, records } };
}

export type ExecuteContext = AddAgentContext & {
  /** Both wallets must be the owner of mergit.eth: it operates the agent on Base and holds every role on the resolver. */
  mainnetWallet: WalletClient;
  baseWallet: WalletClient;
  agentsPath: string;
  /** Where the new runtime key is written (`~/.config/mergit/agent-<label>.env`); never overwritten. */
  keyPath: string;
};

export type ExecFailureCode =
  | PlanFailureCode | "not-owner" | "insufficient-balance" | "base-unfunded" | "key-file-exists" | "key-failed" | "register-failed"
  | "id-mismatch" | "registration-file-failed" | "ens-write-failed" | "verify-failed" | "agents-json-failed";
export type ExecFailure = {
  ok: false; code: ExecFailureCode; message: string;
  /** Set once the agent exists on Base: rerun with `--agent-id` this, which registers nothing and does only the missing steps. */
  registeredAgentId?: number;
  done: string[];
  rows?: VerifyRow[];
};
export type ExecSuccess = {
  ok: true; plan: AddAgentPlan; agentId: number; runtimeKey: Address; keyPath: string | null; steps: StepResult[]; rows: VerifyRow[];
  registrationPath: string; agentsPath: string;
};
export type ExecResult = ExecSuccess | ExecFailure;

/**
 * The owner-triggered way to add one agent after the one-shot has run. In order: re-check everything (the plan), check the
 * signer and balances, make a fresh runtime key, `registerAgent` on Base and read the real id from the event, write the
 * registration file, write the three records on the EXISTING resolver in one multicall, read them back through the Universal
 * Resolver, and only then append the agent to agents.json. Every failure is a typed outcome that says what was already done.
 *
 * Rerun safety: nothing registers twice. A run that stopped after `registerAgent` reports the id; rerun with `agentId` set and
 * only the steps after registration are done (the key file is kept, never regenerated). A key file is deleted only when
 * nothing was sent yet; once a registration transaction was attempted it is kept, because the key may already be on chain.
 */
export async function executeAddAgent(ctx: ExecuteContext, input: AddAgentInput): Promise<ExecResult> {
  const done: string[] = [];
  const steps: StepResult[] = [];
  let registeredAgentId: number | undefined;
  const fail = (code: ExecFailureCode, message: string, extra: Partial<ExecFailure> = {}): ExecFailure =>
    ({ ok: false, code, message, ...(registeredAgentId !== undefined ? { registeredAgentId } : {}), done: [...done], ...extra });
  const planned = await planAddAgent(ctx, input);
  if (!planned.ok) return fail(planned.code, planned.message);
  const { plan } = planned;
  const cfg = ctx.cfg;

  // the key must belong to the on-chain owner of mergit.eth, on both chains: nothing is sent or created before this passes
  const isOwner = (w: WalletClient) => !!w.account && isAddressEqual(w.account.address, plan.owner);
  if (!isOwner(ctx.mainnetWallet) || !isOwner(ctx.baseWallet)) {
    return fail("not-owner", `Refusing: the signing key belongs to ${ctx.mainnetWallet.account?.address ?? "no account"} (mainnet) / ${ctx.baseWallet.account?.address ?? "no account"} (Base), not to the owner of mergit.eth (${plan.owner}). Nothing was sent.`);
  }
  try {
    const need = ESTIMATED_UNITS * (await ctx.mainnet.getGasPrice()) * HEADROOM;
    const balance = await ctx.mainnet.getBalance({ address: plan.owner });
    if (balance < need) return fail("insufficient-balance", `Refusing: the owner holds ${balance} wei on mainnet but the ENS write needs about ${need} wei at current gas (${HEADROOM}x headroom). Nothing was sent.`);
    if (!plan.rerun && (await ctx.base.getBalance({ address: plan.owner })) === 0n) return fail("base-unfunded", `Refusing: the owner has no ETH on chain ${cfg.chain.chainId} to pay for registerAgent. Nothing was sent.`);
  } catch (e) { return fail("read-failed", `checking balances failed: ${shortError(e)}`); }

  let runtimeKey: Address;
  let agent = plan.agent;
  let keyPath: string | null = null;
  if (plan.rerun) {
    runtimeKey = plan.runtimeKey!; // the plan read it from chain
    registeredAgentId = plan.agentId;
    if (existsSync(ctx.keyPath)) keyPath = ctx.keyPath;
    done.push(`agent ${plan.agentId} already registered (verified: URL and operator), registration skipped`);
  } else {
    if (existsSync(ctx.keyPath)) return fail("key-file-exists", `${ctx.keyPath} already exists; refusing to overwrite or reuse keys. If a previous run registered an agent, rerun with --agent-id <id>; otherwise move the file away.`);
    const keyName = `MERGIT_AGENT_KEY_${plan.agentId}`;
    try { runtimeKey = generateNamedKeys(ctx.keyPath, [keyName])[keyName]!; } catch (e) { return fail("key-failed", `could not create the key file: ${shortError(e)}`); }
    keyPath = ctx.keyPath;
    done.push(`runtime key ${runtimeKey} saved to ${keyPath} as ${keyName} (mode 600)`);
    // nothing is on chain until writeContract below, so a failure up to here may delete the key file safely
    const dropKey = () => { try { unlinkSync(ctx.keyPath); } catch { /* already gone */ } keyPath = null; done.pop(); };
    let request: unknown;
    try {
      const sim = await ctx.base.simulateContract({ address: cfg.chain.identity, abi: identityAbi, functionName: "registerAgent", args: [runtimeKey, plan.metadataUri], account: ctx.baseWallet.account! }); // the wallet's own account, so the request is signed by it (checked to be the owner above)
      if (Number(sim.result) !== plan.agentId) { dropKey(); return fail("id-mismatch", `registerAgent would now return id ${sim.result}, not the previewed ${plan.agentId} (someone registered in between). Nothing was sent; run the dry run again.`); }
      request = sim.request;
    } catch (e) { dropKey(); return fail("register-failed", `registerAgent would revert: ${shortError(e)}. Nothing was sent.`); }

    const kept = `The key file ${ctx.keyPath} was KEPT (the key may already be registered). Check Base for a registration by the owner before rerunning: if there is one, rerun with --agent-id <its id>; if there is none, delete the file and rerun.`;
    let hash: Hex;
    try { hash = await ctx.baseWallet.writeContract(request as never); } catch (e) { return fail("register-failed", `registerAgent failed: ${shortError(e)}. ${kept}`); }
    let receipt;
    try { receipt = await ctx.base.waitForTransactionReceipt({ hash }); } catch (e) { return fail("register-failed", `waiting for registerAgent transaction ${hash} failed: ${shortError(e)}. ${kept}`); }
    if (receipt.status !== "success") return fail("register-failed", `registerAgent transaction ${hash} reverted. ${kept}`);
    let realId: number | undefined;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== cfg.chain.identity.toLowerCase()) continue;
      try { const ev = decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics }); if (ev.eventName === "AgentRegistered") realId = Number(ev.args.agentId); } catch { /* another event */ }
    }
    if (realId === undefined) return fail("register-failed", `transaction ${hash} has no AgentRegistered event; find the id with tokenURI on the Identity contract. ${kept}`);
    registeredAgentId = realId;
    steps.push({ step: "registerAgent on Base", hash, gasUsed: receipt.gasUsed });
    done.push(`registered agent ${realId} on Base (tx ${hash})`);
    if (realId !== plan.agentId) {
      return fail("id-mismatch", `registered agent ${realId}, but ${plan.agentId} was previewed and the key file names MERGIT_AGENT_KEY_${plan.agentId}. Rename that variable in ${ctx.keyPath} to MERGIT_AGENT_KEY_${realId}, then rerun with --agent-id ${realId}.`);
    }
    agent = { ...plan.agent, agentId: realId };
  }

  try { writeRegistrationFiles({ ...cfg, agents: [agent] }, ctx.registrationDir); } catch (e) { return fail("registration-file-failed", `writing ${plan.registrationPath} failed: ${shortError(e)}`); }
  done.push(`wrote ${plan.registrationPath}`);

  // the owner holds every role on the resolver the one-shot deployed; if the write is refused, stop here and report, never work around it
  try {
    const sim = await ctx.mainnet.simulateContract({ address: plan.resolver, abi: permissionedResolverAbi, functionName: "multicall", args: [recordCalls([agent], cfg.chain)], account: ctx.mainnetWallet.account! } as never);
    const hash = await ctx.mainnetWallet.writeContract(sim.request as never);
    const receipt = await ctx.mainnet.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    steps.push({ step: `write ${agentRecords(agent, cfg.chain).length} agent records on the existing resolver`, hash, gasUsed: receipt.gasUsed });
  } catch (e) {
    return fail("ens-write-failed", `writing the records to ${plan.resolver} failed: ${shortError(e)}. Nothing else changed on mainnet. Rerun with --agent-id ${agent.agentId}.`);
  }
  done.push(`wrote the three records for ${plan.ensName}`);

  const rows = await verifyOneShot(ctx.mainnet, { chain: cfg.chain, publisher: cfg.publisher, editor: cfg.editor, agents: [agent] }, plan.resolver);
  if (rows.some((r) => !r.ok)) return fail("verify-failed", `the records did not all read back through the Universal Resolver. Rerun with --agent-id ${agent.agentId}.`, { rows });

  try {
    const raw = JSON.parse(readFileSync(ctx.agentsPath, "utf8"));
    raw.agents.push({ label: agent.label, name: agent.name, description: agent.description, profileUrl: agent.profileUrl, agentId: agent.agentId });
    writeFileSync(ctx.agentsPath, JSON.stringify(raw, null, 2) + "\n");
  } catch (e) { return fail("agents-json-failed", `the agent is fully registered and its records read back, but updating ${ctx.agentsPath} failed: ${shortError(e)}. Add the entry by hand (label, name, description, profileUrl, agentId ${agent.agentId}).`, { rows }); }
  done.push(`appended ${agent.label} (agentId ${agent.agentId}) to ${ctx.agentsPath}`);
  return { ok: true, plan, agentId: agent.agentId, runtimeKey, keyPath, steps, rows, registrationPath: plan.registrationPath, agentsPath: ctx.agentsPath };
}

/** What the owner still has to do by hand, as text (no other file is edited). Never contains the key, only the variable name and file. */
export function followUps(s: { plan: AddAgentPlan; agentId: number; runtimeKey: Address | null; keyPath: string | null }): string[] {
  const { plan } = s;
  const roster = { agent_id: String(s.agentId), metadata_uri: plan.metadataUri, name: plan.label, operator: plan.owner, runtime_key: s.runtimeKey ?? "<the runtime key address, printed by --execute>" };
  const keyVar = `MERGIT_AGENT_KEY_${s.agentId}`;
  const keyFile = s.keyPath ?? `~/.config/mergit/agent-${plan.label}.env`;
  return [
    `1. Publish the registration file: commit and deploy ${plan.registrationPath} so ${plan.metadataUri} is live (the URI registered on chain points at it).`,
    "2. Add this entry to mergit-contracts/deployments/agents-base-sepolia.json (inside \"agents\"):",
    ...JSON.stringify(roster, null, 2).split("\n").map((l) => `     ${l}`),
    `3. control-plane/agents.toml already has [agents.${plan.label}] (checked before anything was sent); deploy that file to the worker with the key below.`,
    `4. Give the worker host the runtime key ${keyVar} without printing it (then restart the worker):`,
    `     grep '^${keyVar}=' ${keyFile} | ssh <worker-host> 'cat >> <worker env file>'`,
    "   or copy the whole file with scp and append it there; the key stays only in files of mode 600.",
    `5. The stake vault must hold stake for the operator ${plan.owner} before this agent can take work.`,
  ];
}
