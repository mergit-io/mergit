import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventLog, getAddress, keccak256, toHex, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { MAINNET } from "../src/deployments.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { loadConfig } from "../src/config.ts";
import { dnsName } from "../src/dns.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";
import { runOneShot } from "../src/oneshot.ts";
import { executeAddAgent, followUps, planAddAgent, identityAbi, type AddAgentContext, type ExecuteContext } from "../src/add-agent.ts";
import { ACCOUNTS, impersonate, startFork, type Fork } from "./fork.ts";

// The owner-triggered "add one agent" flow on forks of Ethereum mainnet AND Base Sepolia, with the real owner of mergit.eth
// impersonated on both (no key involved, nothing is sent to either real chain). The mainnet fork first runs the real one-shot
// for the two existing agents, so the new agent is added to the resolver the one-shot deployed.
const skip = (!process.env.ENS_MAINNET_RPC || !process.env.BASE_SEPOLIA_RPC) && "ENS_MAINNET_RPC and BASE_SEPOLIA_RPC not both set";
const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const DESC = "A third Mergit coding agent, added after the one-shot.";

type World = { main: Fork; base: Fork; resolver: Address; dir: string };
let worldP: Promise<World> | undefined;
const forks: Fork[] = [];
after(async () => { for (const f of forks) await f.stop(); });

const startTracked = async (opts?: Parameters<typeof startFork>[0]) => { const f = await startFork(opts); forks.push(f); return f; };
const startBase = () => startTracked({ upstream: process.env.BASE_SEPOLIA_RPC, chain: baseSepolia });
const currentResolver = (f: Fork) => f.pub.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "getResolver", args: ["mergit"] }) as Promise<Address>;

const AGENTS_JSON = (agents: unknown[]) => JSON.stringify({
  chainId: 84532, identity: IDENTITY, publisher: ACCOUNTS.publisher.address, editor: ACCOUNTS.mergit.address, agents,
}, null, 2) + "\n";
const EXISTING = [2, 3].map((n) => ({
  label: `mergit-coder-${n - 1}`, name: `mergit-coder-${n - 1}`, description: `Mergit coding agent ${n - 1}.`, profileUrl: `https://mergit.site/agents/mergit-coder-${n - 1}.mergit.eth`, agentId: n,
}));

/** Mainnet fork after the real one-shot for two agents (ids 2 and 3 exist on Base Sepolia already), plus a Base Sepolia fork. Shared by the tests below. */
function world(): Promise<World> {
  return (worldP ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "add-agent-world-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, AGENTS_JSON(EXISTING));
    const main = await startTracked();
    const base = await startBase();
    await impersonate(main, OWNER);
    await impersonate(base, OWNER);
    const r = await runOneShot({ pub: main.pub, wallet: main.wallet(OWNER), owner: OWNER }, loadConfig(path, { allowTestAddresses: true }));
    return { main, base, resolver: r.resolver, dir };
  })());
}

/** Fresh files for one test: its own agents.json copy, registration folder and key file location, all under a temp dir. */
function files(w: World, agents: unknown[] = EXISTING) {
  const dir = mkdtempSync(join(w.dir, "t-"));
  const agentsPath = join(dir, "agents.json");
  writeFileSync(agentsPath, AGENTS_JSON(agents));
  return { dir, agentsPath, registrationDir: join(dir, "registrations"), keyPathFor: (label: string) => join(dir, "home", ".config", "mergit", `agent-${label}.env`) };
}
const planCtx = (w: World, f: ReturnType<typeof files>): AddAgentContext => ({
  mainnet: w.main.pub, base: w.base.pub, cfg: loadConfig(f.agentsPath, { allowTestAddresses: true }), registrationDir: f.registrationDir,
});

test("the plan previews the id, URL, file path and the three records, reads only, and names the resolver mergit.eth points at", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const mainBlock = await w.main.pub.getBlockNumber({ cacheTime: 0 });
  const baseBlock = await w.base.pub.getBlockNumber({ cacheTime: 0 });
  const r = await planAddAgent(planCtx(w, f), { label: "mergit-coder-3", description: DESC });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  const p = r.plan;
  assert.equal(p.ensName, "mergit-coder-3.mergit.eth");
  assert.equal(p.owner, OWNER);
  assert.equal(p.resolver.toLowerCase(), w.resolver.toLowerCase());
  assert.equal(p.rerun, false);
  assert.equal(p.runtimeKey, null, "no key exists before --execute");
  assert.equal(p.metadataUri, "https://mergit.site/registrations/mergit-coder-3.json");
  assert.equal(p.registrationPath, join(f.registrationDir, "mergit-coder-3.json"));
  assert.ok(Number.isInteger(p.agentId) && p.agentId > 3, `preview id ${p.agentId} must follow the existing agents`);
  assert.deepEqual(p.records.map((x) => x.key), [agentRegistrationKey(IDENTITY, 84532, p.agentId), "agent-context", "agent-endpoint[web]"]);
  assert.equal(p.records[0]!.value, "1");
  assert.equal(p.records[1]!.value, `# mergit-coder-3\n\n${DESC}`);
  assert.equal(p.records[2]!.value, "https://mergit.site/agents/mergit-coder-3.mergit.eth");
  assert.equal(await w.main.pub.getBlockNumber({ cacheTime: 0 }), mainBlock, "a plan sends nothing to mainnet");
  assert.equal(await w.base.pub.getBlockNumber({ cacheTime: 0 }), baseBlock, "a plan sends nothing to Base");
  assert.equal(existsSync(f.registrationDir), false, "a plan writes no files");
});

test("a bad label, a label already in agents.json and a taken agent id are refused with a typed outcome", { skip }, async () => {
  const w = await world();
  const ctx = planCtx(w, files(w));
  const bad = await planAddAgent(ctx, { label: "Coder_3", description: DESC });
  assert.deepEqual([bad.ok, (bad as { code?: string }).code], [false, "invalid-label"]);
  const dup = await planAddAgent(ctx, { label: "mergit-coder-1", description: DESC });
  assert.deepEqual([dup.ok, (dup as { code?: string }).code], [false, "duplicate-label"]);
  assert.match((dup as { message: string }).message, /mergit-coder-1/);
  const dupId = await planAddAgent(ctx, { label: "mergit-coder-3", description: DESC, agentId: 2 });
  assert.deepEqual([dupId.ok, (dupId as { code?: string }).code], [false, "duplicate-agent-id"]);
});

test("a name that already carries one of the three records is refused (it would silently overwrite)", { skip }, async () => {
  const w = await world();
  const hash = await w.main.wallet(OWNER).writeContract({ address: w.resolver, abi: permissionedResolverAbi, functionName: "setText",
    args: [dnsName("ghost.mergit.eth"), "agent-endpoint[web]", "https://example.test/ghost"] } as never);
  assert.equal((await w.main.pub.waitForTransactionReceipt({ hash })).status, "success", "precondition: the owner can write on the resolver");
  const r = await planAddAgent(planCtx(w, files(w)), { label: "ghost", description: DESC });
  assert.deepEqual([r.ok, (r as { code?: string }).code], [false, "name-in-use"]);
});

test("an existing registration file is not overwritten for a new agent, but is fine for a rerun of an agent already registered", { skip }, async () => {
  const w = await world();
  const f = files(w);
  mkdirSync(f.registrationDir, { recursive: true });
  writeFileSync(join(f.registrationDir, "mergit-coder-3.json"), "{}\n");
  const r = await planAddAgent(planCtx(w, f), { label: "mergit-coder-3", description: DESC });
  assert.deepEqual([r.ok, (r as { code?: string }).code], [false, "registration-file-exists"]);
  assert.equal(readFileSync(join(f.registrationDir, "mergit-coder-3.json"), "utf8"), "{}\n");
});

test("a label with no [agents.<label>] stanza in agents.toml is refused: the platform name must exist first (the web app looks the ENS name up by it)", { skip }, async () => {
  const w = await world();
  const ctx = planCtx(w, files(w));
  const toml = '[agents.mergit-coder-1]\nprovider = "x"\n\n[agents.mergit-coder-30]\nprovider = "x"\n';
  const missing = await planAddAgent({ ...ctx, agentsToml: toml }, { label: "mergit-coder-3", description: DESC });
  assert.deepEqual([missing.ok, !missing.ok && missing.code], [false, "no-agent-stanza"]);
  assert.match((missing as { message: string }).message, /\[agents\.mergit-coder-3\]/);
  assert.match((missing as { message: string }).message, /add .*stanza.*first/i, "tells the owner to add the stanza first");
  const present = await planAddAgent({ ...ctx, agentsToml: toml + '\n[agents.mergit-coder-3]\nprovider = "x"\n' }, { label: "mergit-coder-3", description: DESC });
  assert.equal(present.ok, true);
  // the same rule applies to a rerun
  const rerun = await planAddAgent({ ...ctx, agentsToml: toml }, { label: "mergit-coder-3", description: DESC, agentId: 99_999_999 });
  assert.deepEqual([rerun.ok, !rerun.ok && rerun.code], [false, "no-agent-stanza"]);
});

test("--agent-id: the agent must exist, point at this label's registration URL and be operated by the owner", { skip }, async () => {
  const w = await world();
  const ctx = planCtx(w, files(w));
  // agent 1 is operated by someone else and has an empty URL
  const other = await planAddAgent(ctx, { label: "mergit-coder-3", description: DESC, agentId: 1 });
  assert.deepEqual([other.ok, (other as { code?: string }).code], [false, "agent-mismatch"]);
  const unknown = await planAddAgent(ctx, { label: "mergit-coder-3", description: DESC, agentId: 99_999_999 });
  assert.deepEqual([unknown.ok, (unknown as { code?: string }).code], [false, "agent-mismatch"]);
  // someone else registers an agent with exactly this label's URL: the URL matches but the operator is not the owner
  const alice = w.base.wallet(ACCOUNTS.alice);
  const hash = await alice.writeContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.alice.address, "https://mergit.site/registrations/stolen.json"] } as never);
  const receipt = await w.base.pub.waitForTransactionReceipt({ hash });
  const id = receipt.logs.map((l) => { try { return decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics }); } catch { return undefined; } }).find((e) => e?.eventName === "AgentRegistered")!.args as { agentId: bigint };
  const stolen = await planAddAgent(ctx, { label: "stolen", description: DESC, agentId: Number(id.agentId) });
  assert.deepEqual([stolen.ok, (stolen as { code?: string }).code], [false, "agent-mismatch"]);
  assert.match((stolen as { message: string }).message, /operator/i);
});

const UR = MAINNET.universalResolverV2;
const text = (f: Fork, name: string, key: string) => f.pub.getEnsText({ name, key, universalResolverAddress: UR });
const blocks = async (w: World) => [await w.main.pub.getBlockNumber({ cacheTime: 0 }), await w.base.pub.getBlockNumber({ cacheTime: 0 })];
const execCtx = (w: World, f: ReturnType<typeof files>, label: string, over: Partial<ExecuteContext> = {}): ExecuteContext => ({
  ...planCtx(w, f), mainnetWallet: w.main.wallet(OWNER), baseWallet: w.base.wallet(OWNER), agentsPath: f.agentsPath, keyPath: f.keyPathFor(label), ...over,
});
/** Wraps a wallet so `writeContract` calls are counted and can be made to fail for one function. */
function spy(w: ReturnType<Fork["wallet"]>, failOn?: string) {
  const calls: string[] = [];
  const wrapped = { ...w, writeContract: (args: { functionName: string }) => {
    calls.push(args.functionName);
    return args.functionName === failOn ? Promise.reject(new Error(`simulated ${failOn} failure`)) : w.writeContract(args as never);
  } } as typeof w;
  return { wallet: wrapped, calls };
}
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

test("happy path: --execute registers on Base, writes the file and the three records on the existing resolver, and nothing else moves", { skip }, async (t) => {
  const w = await world();
  const f = files(w);
  const label = "mergit-coder-3";
  const ctx = execCtx(w, f, label);
  const preview = await planAddAgent(planCtx(w, f), { label, description: DESC });
  assert.ok(preview.ok);
  const addressBefore = await w.main.pub.getEnsAddress({ name: "mergit.eth", universalResolverAddress: UR });
  const otherBefore = await Promise.all(["mergit-coder-1", "mergit-coder-2"].flatMap((l) => ["agent-context", "agent-endpoint[web]"].map((k) => text(w.main, `${l}.mergit.eth`, k))));
  const resolverBefore = await currentResolver(w.main);
  const agentsBefore = readFileSync(f.agentsPath, "utf8");

  const r = await executeAddAgent(ctx, { label, description: DESC });
  assert.equal(r.ok, true, json(r));
  if (!r.ok) return;
  t.diagnostic(`multicall gas ${r.steps.find((s) => s.step.startsWith("write"))!.gasUsed}`);

  // the id is the one in the AgentRegistered log, and it is the one that was previewed
  const regTx = r.steps.find((s) => s.step === "registerAgent on Base")!;
  const receipt = await w.base.pub.getTransactionReceipt({ hash: regTx.hash });
  const events = receipt.logs.flatMap((l) => { try { return [decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics })]; } catch { return []; } });
  const reg = events.find((e) => e.eventName === "AgentRegistered")!.args as { agentId: bigint; operator: Address; runtimeKey: Address; metadataURI: string };
  assert.equal(r.agentId, Number(reg.agentId));
  assert.equal(r.agentId, preview.ok ? preview.plan.agentId : -1);
  assert.equal(reg.operator, OWNER);
  assert.equal(reg.metadataURI, "https://mergit.site/registrations/mergit-coder-3.json");
  const onBase = (functionName: "operatorOf" | "runtimeKeyOf" | "tokenURI") => w.base.pub.readContract({ address: IDENTITY, abi: identityAbi, functionName, args: [BigInt(r.agentId)] });
  assert.equal(await onBase("operatorOf"), OWNER);
  assert.equal(await onBase("tokenURI"), reg.metadataURI);

  // the runtime key: only in a mode 600 file, named for the real id, and it is the key registered on chain
  assert.equal(statSync(ctx.keyPath).mode & 0o777, 0o600);
  const keyText = readFileSync(ctx.keyPath, "utf8");
  const key = new RegExp(`^MERGIT_AGENT_KEY_${r.agentId}=(0x[0-9a-f]{64})$`, "m").exec(keyText)?.[1] as `0x${string}`;
  assert.ok(key, "the key file names the real agent id");
  assert.equal(privateKeyToAccount(key).address, r.runtimeKey);
  assert.equal(await onBase("runtimeKeyOf"), r.runtimeKey);
  assert.ok(!json(r).includes(key) && !json(r).includes(key.slice(2)), "the result must not carry the key");

  // the registration file carries the real id
  const file = JSON.parse(readFileSync(join(f.registrationDir, "mergit-coder-3.json"), "utf8"));
  assert.deepEqual(file.registrations, [{ agentId: r.agentId, agentRegistry: `eip155:84532:${IDENTITY}` }]);
  assert.equal(file.description, DESC);

  // the three records read back through the Universal Resolver, and every row says ok
  const name = "mergit-coder-3.mergit.eth";
  assert.equal(await text(w.main, name, agentRegistrationKey(IDENTITY, 84532, r.agentId)), "1");
  assert.equal(await text(w.main, name, "agent-context"), `# mergit-coder-3\n\n${DESC}`);
  assert.equal(await text(w.main, name, "agent-endpoint[web]"), "https://mergit.site/agents/mergit-coder-3.mergit.eth");
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows.filter((x) => !x.ok), []);
  assert.deepEqual(r.steps.map((s) => s.step), ["registerAgent on Base", "write 3 agent records on the existing resolver"]);

  // everything that was there is unchanged
  assert.equal(await w.main.pub.getEnsAddress({ name: "mergit.eth", universalResolverAddress: UR }), addressBefore);
  assert.equal((await currentResolver(w.main)).toLowerCase(), resolverBefore.toLowerCase());
  assert.deepEqual(await Promise.all(["mergit-coder-1", "mergit-coder-2"].flatMap((l) => ["agent-context", "agent-endpoint[web]"].map((k) => text(w.main, `${l}.mergit.eth`, k)))), otherBefore);
  assert.equal(await text(w.main, "mergit-coder-1.mergit.eth", agentRegistrationKey(IDENTITY, 84532, 2)), "1");
  assert.equal(await text(w.main, "mergit-coder-2.mergit.eth", agentRegistrationKey(IDENTITY, 84532, 3)), "1");

  // agents.json: the same two-space JSON plus one entry carrying its id, trailing newline kept
  const after = readFileSync(f.agentsPath, "utf8");
  const parsed = JSON.parse(after);
  assert.equal(after, JSON.stringify(parsed, null, 2) + "\n");
  assert.equal(parsed.agents.length, 3);
  assert.deepEqual(parsed.agents[2], { label, name: label, description: DESC, profileUrl: "https://mergit.site/agents/mergit-coder-3.mergit.eth", agentId: r.agentId });
  assert.deepEqual(JSON.parse(agentsBefore).agents, parsed.agents.slice(0, 2));
  assert.equal(after.slice(0, agentsBefore.indexOf('"agents"')), agentsBefore.slice(0, agentsBefore.indexOf('"agents"')), "the header of the file is untouched");

  // the follow-ups name the roster entry, the key variable and the stake, and never carry the key
  const out = followUps({ plan: r.plan, agentId: r.agentId, runtimeKey: r.runtimeKey, keyPath: r.keyPath }).join("\n");
  assert.ok(!out.includes(key.slice(2)));
  assert.match(out, new RegExp(`"agent_id": "${r.agentId}"`));
  assert.match(out, new RegExp(`MERGIT_AGENT_KEY_${r.agentId}`));
  assert.match(out, /agents-base-sepolia\.json/);
  assert.match(out, /\[agents\.mergit-coder-3\]/);
  assert.match(out, /stake/i);
});

test("a rerun with the existing label is refused (the label is in agents.json now)", { skip }, async () => {
  const w = await world();
  const f = files(w, [...EXISTING, { label: "mergit-coder-3", name: "mergit-coder-3", description: DESC, profileUrl: "https://mergit.site/agents/mergit-coder-3.mergit.eth", agentId: 99 }]);
  const before = await blocks(w);
  const r = await executeAddAgent(execCtx(w, f, "mergit-coder-3"), { label: "mergit-coder-3", description: DESC });
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "duplicate-label"]);
  assert.deepEqual(await blocks(w), before);
});

test("a key that is not the on-chain owner is refused on either chain, before anything is sent or created", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const label = "mergit-coder-4";
  const before = await blocks(w);
  for (const over of [
    { mainnetWallet: w.main.wallet(ACCOUNTS.alice), baseWallet: w.base.wallet(ACCOUNTS.alice) }, // not the owner anywhere
    { baseWallet: w.base.wallet(ACCOUNTS.alice) }, // owner on mainnet, someone else on Base
    { mainnetWallet: w.main.wallet(ACCOUNTS.alice) }, // the other way round
  ]) {
    const ctx = execCtx(w, f, label, over);
    const r = await executeAddAgent(ctx, { label, description: DESC });
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "not-owner"]);
    assert.match((r as { message: string }).message, /Nothing was sent/);
    assert.deepEqual(await blocks(w), before, "nothing may be sent on either chain");
    assert.equal(existsSync(ctx.keyPath), false, "no key file may be created");
    assert.equal(existsSync(f.registrationDir), false);
  }
  assert.deepEqual(JSON.parse(readFileSync(f.agentsPath, "utf8")).agents.length, 2);
});

test("an owner without gas headroom on mainnet is refused before anything is sent or created", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const label = "mergit-coder-4";
  await w.main.pub.request({ method: "anvil_setBalance", params: [OWNER, "0x1"] } as never);
  try {
    const before = await blocks(w);
    const ctx = execCtx(w, f, label);
    const r = await executeAddAgent(ctx, { label, description: DESC });
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "insufficient-balance"]);
    assert.deepEqual(await blocks(w), before);
    assert.equal(existsSync(ctx.keyPath), false);
  } finally { await impersonate(w.main, OWNER); }
});

test("an existing key file is never overwritten or reused: the run fails clearly before registering anything", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const label = "mergit-coder-4";
  const ctx = execCtx(w, f, label);
  mkdirSync(join(f.dir, "home", ".config", "mergit"), { recursive: true });
  writeFileSync(ctx.keyPath, "MERGIT_AGENT_KEY_1=0xkeep\n");
  const before = await blocks(w);
  const r = await executeAddAgent(ctx, { label, description: DESC });
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "key-file-exists"]);
  assert.equal(readFileSync(ctx.keyPath, "utf8"), "MERGIT_AGENT_KEY_1=0xkeep\n");
  assert.deepEqual(await blocks(w), before);
});

test("rerun safety: after registerAgent landed and the ENS write failed, --agent-id completes the missing steps without a second registerAgent", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const label = "mergit-coder-5";
  const base1 = spy(w.base.wallet(OWNER));
  const flaky = spy(w.main.wallet(OWNER), "multicall");
  const r1 = await executeAddAgent(execCtx(w, f, label, { baseWallet: base1.wallet, mainnetWallet: flaky.wallet }), { label, description: DESC });
  assert.equal(r1.ok, false);
  if (r1.ok) return;
  assert.equal(r1.code, "ens-write-failed");
  assert.ok(r1.registeredAgentId && r1.registeredAgentId > 3, "the failure reports the id that was registered");
  assert.match(r1.message, new RegExp(`--agent-id ${r1.registeredAgentId}\\b`));
  assert.deepEqual(base1.calls, ["registerAgent"]);
  assert.equal(JSON.parse(readFileSync(f.agentsPath, "utf8")).agents.length, 2, "agents.json is only updated at the very end");
  assert.equal(await text(w.main, `${label}.mergit.eth`, "agent-endpoint[web]"), null, "no record was written");
  const keyFile = readFileSync(f.keyPathFor(label), "utf8");
  assert.match(keyFile, new RegExp(`^MERGIT_AGENT_KEY_${r1.registeredAgentId}=0x`));
  assert.ok(existsSync(join(f.registrationDir, `${label}.json`)), "the registration file was written before the ENS step");

  // a rerun without the flag cannot register again either: the leftover file stops it and points at --agent-id
  const baseBefore = await w.base.pub.getBlockNumber({ cacheTime: 0 });
  const noFlag = await executeAddAgent(execCtx(w, f, label), { label, description: DESC });
  assert.deepEqual([noFlag.ok, !noFlag.ok && noFlag.code], [false, "registration-file-exists"]);
  assert.match((noFlag as { message: string }).message, /--agent-id/);
  assert.equal(await w.base.pub.getBlockNumber({ cacheTime: 0 }), baseBefore);

  // the rerun with the id: nothing is sent on Base at all
  const baseBlock = await w.base.pub.getBlockNumber({ cacheTime: 0 });
  const base2 = spy(w.base.wallet(OWNER));
  const r2 = await executeAddAgent(execCtx(w, f, label, { baseWallet: base2.wallet }), { label, description: DESC, agentId: r1.registeredAgentId });
  assert.equal(r2.ok, true, json(r2));
  if (!r2.ok) return;
  assert.deepEqual(base2.calls, [], "no registerAgent on the rerun");
  assert.equal(await w.base.pub.getBlockNumber({ cacheTime: 0 }), baseBlock, "nothing was sent on Base");
  assert.equal(r2.agentId, r1.registeredAgentId);
  assert.equal(readFileSync(f.keyPathFor(label), "utf8"), keyFile, "the key file is untouched");
  assert.equal(r2.runtimeKey, await w.base.pub.readContract({ address: IDENTITY, abi: identityAbi, functionName: "runtimeKeyOf", args: [BigInt(r1.registeredAgentId!)] }));
  assert.deepEqual(r2.rows.filter((x) => !x.ok), []);
  assert.equal(await text(w.main, `${label}.mergit.eth`, agentRegistrationKey(IDENTITY, 84532, r1.registeredAgentId!)), "1");
  const agents = JSON.parse(readFileSync(f.agentsPath, "utf8")).agents;
  assert.equal(agents.length, 3);
  assert.equal(agents[2].agentId, r1.registeredAgentId);
  assert.equal(JSON.parse(readFileSync(join(f.registrationDir, `${label}.json`), "utf8")).registrations[0].agentId, r1.registeredAgentId);
});

test("if the id moves between the preview and the send, nothing is sent and the key file is removed; if it moves during the send, the id is reported and the key is kept", { skip }, async () => {
  const w = await world();
  const label = "mergit-coder-6";
  const alice = w.base.wallet(ACCOUNTS.alice);
  const squat = async () => { await w.base.pub.waitForTransactionReceipt({ hash: await alice.writeContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.alice.address, "https://mergit.site/registrations/squat.json"] } as never) }); };

  // (a) the id moves after the plan's preview, before the second simulation
  const fa = files(w);
  let sims = 0;
  const basePub = new Proxy(w.base.pub, { get: (t, p, rcv) => p === "simulateContract"
    ? async (a: unknown) => { const out = await (t as any).simulateContract(a); if (++sims === 1) await squat(); return out; }
    : Reflect.get(t, p, rcv) });
  const ca = execCtx(w, fa, label, { base: basePub as typeof w.base.pub });
  const before = await w.base.pub.getBlockNumber({ cacheTime: 0 });
  const ra = await executeAddAgent(ca, { label, description: DESC });
  assert.deepEqual([ra.ok, !ra.ok && ra.code], [false, "id-mismatch"]);
  assert.equal(existsSync(ca.keyPath), false, "nothing was sent for this agent, so its key file is removed");
  assert.equal(await w.base.pub.getBlockNumber({ cacheTime: 0 }), before + 1n, "only the squatter's transaction landed");

  // (b) the id moves after the second simulation, during the send
  const fb = files(w);
  const racing = { ...w.base.wallet(OWNER), writeContract: async (a: never) => { await squat(); return w.base.wallet(OWNER).writeContract(a); } } as ReturnType<Fork["wallet"]>;
  const cb = execCtx(w, fb, label, { baseWallet: racing });
  const rb = await executeAddAgent(cb, { label, description: DESC });
  assert.deepEqual([rb.ok, !rb.ok && rb.code], [false, "id-mismatch"]);
  assert.ok(!rb.ok && rb.registeredAgentId, "the real id is reported");
  assert.match((rb as { message: string }).message, new RegExp(`--agent-id ${(rb as { registeredAgentId: number }).registeredAgentId}\\b`));
  assert.ok(existsSync(cb.keyPath), "the agent exists on chain, so the key file is kept");
  assert.equal(JSON.parse(readFileSync(fb.agentsPath, "utf8")).agents.length, 2);
});

test("a simulated request is signed by the wallet's own (local) account, not sent as a bare address: the pattern executeAddAgent relies on for a real key", { skip }, async () => {
  const w = await world();
  const alice = w.base.wallet(ACCOUNTS.alice);
  const sim = await w.base.pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.alice.address, "https://mergit.site/registrations/signed-locally.json"], account: alice.account! });
  const hash = await alice.writeContract(sim.request as never);
  const receipt = await w.base.pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.from.toLowerCase(), ACCOUNTS.alice.address.toLowerCase());
  assert.equal(await w.base.pub.readContract({ address: IDENTITY, abi: identityAbi, functionName: "operatorOf", args: [sim.result] }), ACCOUNTS.alice.address);
});

test("the pure follow-ups never contain a key and tell the owner what is still manual", () => {
  const plan = { label: "mergit-x-1", metadataUri: "https://mergit.site/registrations/mergit-x-1.json", owner: OWNER, registrationPath: "/r/mergit-x-1.json" } as never;
  const out = followUps({ plan, agentId: 9, runtimeKey: ACCOUNTS.alice.address, keyPath: "/home/u/.config/mergit/agent-mergit-x-1.env" });
  const text = out.join("\n");
  assert.match(text, /agents-base-sepolia\.json/);
  assert.match(text, /\[agents\.mergit-x-1\]/);
  assert.match(text, /grep '\^MERGIT_AGENT_KEY_9=' \/home\/u\/\.config\/mergit\/agent-mergit-x-1\.env \| ssh/);
  const roster = JSON.parse(/\{[^}]*"agent_id"[^}]*\}/s.exec(text)![0]);
  assert.deepEqual(roster, { agent_id: "9", metadata_uri: "https://mergit.site/registrations/mergit-x-1.json", name: "mergit-x-1", operator: OWNER, runtime_key: ACCOUNTS.alice.address });
  assert.match(text, /stake vault/i);
});

test("mergit.eth must already point at a live resolver the one-shot filled: otherwise the plan says to run the one-shot first", { skip }, async () => {
  const w = await world();
  const m0 = await startTracked(); // a mainnet fork where the one-shot has NOT run
  await impersonate(m0, OWNER);
  const f = files(w);
  const ctx = { ...planCtx(w, f), mainnet: m0.pub };
  const notRun = await planAddAgent(ctx, { label: "mergit-coder-3", description: DESC });
  assert.deepEqual([notRun.ok, !notRun.ok && notRun.code], [false, "one-shot-not-run"]);
  assert.match((notRun as { message: string }).message, /one-shot/i);
  const hash = await m0.wallet(OWNER).writeContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), zeroAddress] } as never);
  assert.equal((await m0.pub.waitForTransactionReceipt({ hash })).status, "success");
  const blocksBefore = await m0.pub.getBlockNumber({ cacheTime: 0 });
  const none = await executeAddAgent({ ...execCtx(w, f, "mergit-coder-3"), mainnet: m0.pub, mainnetWallet: m0.wallet(OWNER) }, { label: "mergit-coder-3", description: DESC });
  assert.deepEqual([none.ok, !none.ok && none.code], [false, "no-resolver"]);
  assert.match((none as { message: string }).message, /one-shot/i);
  assert.equal(await m0.pub.getBlockNumber({ cacheTime: 0 }), blocksBefore);
});

// The CLI as a child process against the two forks (their local RPC URLs stand in for the real ones). Only dry runs and
// refusals are driven here: a real --execute needs the owner's private key, which no test has, so the library tests above
// cover it with the owner impersonated. Each run gets its own HOME so no key file can land in the real one.
const ENS_DIR = join(import.meta.dirname, "..");
function cli(w: World, args: string[], env: Record<string, string | undefined> = {}) {
  const t = mkdtempSync(join(w.dir, "cli-"));
  const tomlPath = join(t, "agents.toml");
  writeFileSync(tomlPath, ["mergit-coder-1", "mergit-coder-2", "mergit-coder-7"].map((l) => `[agents.${l}]\nprovider = "x"\n`).join("\n"));
  // hermetic: the stanza file and the registration folder are temp ones, so a test can never touch the repository's
  args = [...args, "--agents-toml", tomlPath, "--registrations-dir", join(t, "registrations")];
  const home = mkdtempSync(join(w.dir, "home-"));
  const r = spawnSync(process.execPath, ["src/add-agent-cli.ts", ...args], {
    cwd: ENS_DIR, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: home, ENS_MAINNET_RPC: w.main.rpcUrl, BASE_SEPOLIA_RPC: w.base.rpcUrl, ENS_OWNER_PRIVATE_KEY: undefined, ...env },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout, home, registrations: join(t, "registrations") };
}

test("CLI dry run prints the plan and sends nothing on either chain, creates no key file and writes no registration file", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const before = await blocks(w);
  // a key in the environment must not change a dry run: it is not even read
  const r = cli(w, [f.agentsPath, "--label", "mergit-coder-7", "--description", DESC], { ENS_OWNER_PRIVATE_KEY: generatePrivateKey() });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /mergit-coder-7\.mergit\.eth/);
  assert.match(r.stdout, /agent id.*\b\d+\b/i);
  assert.match(r.stdout, /https:\/\/mergit\.site\/registrations\/mergit-coder-7\.json/);
  assert.match(r.stdout, /agent-registration\[0x0001[0-9a-f]+\]\[\d+\] = 1/);
  assert.match(r.stdout, /agent-context/);
  assert.match(r.stdout, /agent-endpoint\[web\]/);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /agents-base-sepolia\.json/);
  assert.deepEqual(await blocks(w), before, "nothing may be sent on either chain");
  assert.equal(existsSync(join(r.home, ".config")), false, "no key file (or folder) in a dry run");
  assert.equal(existsSync(r.registrations), false, "no registration file in a dry run");
  assert.equal(JSON.parse(readFileSync(f.agentsPath, "utf8")).agents.length, 2);
});

test("CLI --execute with a key that is not the owner is refused, sends nothing, and no output contains the key or an RPC URL", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const key = generatePrivateKey();
  const before = await blocks(w);
  const r = cli(w, [f.agentsPath, "--label", "mergit-coder-7", "--description", DESC, "--execute"], { ENS_OWNER_PRIVATE_KEY: key });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not to the owner of mergit\.eth/);
  assert.equal(r.out.includes(key) || r.out.includes(key.slice(2)), false, "the key must never appear in any output");
  assert.equal(r.out.includes(w.main.rpcUrl) || r.out.includes(w.base.rpcUrl), false, "an RPC URL may carry a secret and must never appear in any output");
  assert.ok(r.out.includes(privateKeyToAccount(key).address), "the address is fine to show");
  assert.deepEqual(await blocks(w), before);
  assert.equal(existsSync(join(r.home, ".config")), false);
});

test("CLI refuses a label that has no stanza in agents.toml, naming the stanza to add first, and sends nothing", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const before = await blocks(w);
  const r = cli(w, [f.agentsPath, "--label", "mergit-coder-8", "--description", DESC]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[agents\.mergit-coder-8\]/);
  assert.match(r.out, /add .*stanza.*first/i);
  assert.deepEqual(await blocks(w), before);
  // the default location is control-plane/agents.toml of this repository
  const home = mkdtempSync(join(w.dir, "home-"));
  const d = spawnSync(process.execPath, ["src/add-agent-cli.ts", f.agentsPath, "--label", "mergit-no-such-agent", "--description", DESC, "--registrations-dir", join(home, "reg")],
    { cwd: ENS_DIR, encoding: "utf8", env: { ...process.env, HOME: home, ENS_MAINNET_RPC: w.main.rpcUrl, BASE_SEPOLIA_RPC: w.base.rpcUrl } });
  assert.equal(d.status, 1);
  assert.match(`${d.stdout}${d.stderr}`, /control-plane\/agents\.toml/);
});

test("CLI refuses bad input with exit 1 and a message: a duplicate label, --execute without the key, a key on the command line", { skip }, async () => {
  const w = await world();
  const f = files(w);
  const dup = cli(w, [f.agentsPath, "--label", "mergit-coder-1", "--description", DESC]);
  assert.equal(dup.status, 1);
  assert.match(dup.out, /mergit-coder-1 is already in agents\.json/);
  const noKey = cli(w, [f.agentsPath, "--label", "mergit-coder-7", "--description", DESC, "--execute"]);
  assert.equal(noKey.status, 1);
  assert.match(noKey.out, /ENS_OWNER_PRIVATE_KEY/);
  const pasted = "0x" + "cd".repeat(32);
  const onArgv = cli(w, [f.agentsPath, "--label", "mergit-coder-7", "--description", DESC, pasted]);
  assert.equal(onArgv.status, 1);
  assert.equal(onArgv.out.includes(pasted) || onArgv.out.includes("cd".repeat(32)), false, "a key pasted on the command line must not be echoed");
  const noEnv = cli(w, [f.agentsPath, "--label", "mergit-coder-7", "--description", DESC], { ENS_MAINNET_RPC: "" });
  assert.equal(noEnv.status, 1);
  assert.match(noEnv.out, /ENS_MAINNET_RPC/);
});
