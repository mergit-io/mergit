import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, keccak256, namehash, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { newOutcomeCache, publishPass, type PublisherConfig } from "../src/publisher.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";
import { ACCOUNTS, deployResolver, impersonate, startFork, type Fork } from "./fork.ts";

const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const VALIDATOR = getAddress("0xb41263A86d0EB428Dd1895f7110060Da7EC89F55");
const CAT = keccak256(toHex("test-repair"));
const identityAbi = parseAbi([
  "function registerAgent(address runtimeKey, string metadataURI) returns (uint256 agentId)",
  "function operatorOf(uint256 agentId) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
]);
const recordAbi = parseAbi(["function record(bytes32 taskId, uint256 agentId, bytes32 category, bool success, uint256 costMicros, uint8 tier, uint8 source)"]);
const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const NAME = "coder-0.mergit.eth";

let ens: Fork, base: Fork, resolver: Address, agentId: bigint, cfg: PublisherConfig, taskN = 1;

before(async () => {
  if (skip) return;
  ens = await startFork();
  base = await startFork({ upstream: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chain: baseSepolia });
  await impersonate(base, VALIDATOR);
  resolver = await deployResolver(ens, ACCOUNTS.admin.address);
  for (const key of ["mergit.reputation", "mergit.operator"]) {
    const setter = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });
    const hash = await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter, ACCOUNTS.publisher.address] } as never);
    await ens.pub.waitForTransactionReceipt({ hash });
  }
  // register a new agent on the Base fork; alice is its operator
  const sim = await base.pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.mergit.address, "https://mergit.site/agents/coder-0.json"], account: ACCOUNTS.alice } as never);
  agentId = (sim as { result: bigint }).result;
  await base.pub.waitForTransactionReceipt({ hash: await base.wallet(ACCOUNTS.alice).writeContract((sim as { request: never }).request) });
  // the one-shot writes the agent-registration record (the owner holds root roles on the resolver); the publisher refuses names without it
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText",
    args: [dnsName(NAME), agentRegistrationKey(IDENTITY, 84532, agentId), "1"] } as never) });
  cfg = { chain: { chainId: 84532, identity: IDENTITY, anchor: ANCHOR }, resolver, agents: [{ label: "coder-0", agentId: Number(agentId) }],
    knownCategories: ["test-repair"], fromBlock: await base.pub.getBlockNumber({ cacheTime: 0 }), confirmations: 0 };
});
after(async () => { if (ens) await ens.stop(); if (base) await base.stop(); });

const ctx = () => ({ base: base.pub, ens: ens.pub, wallet: ens.wallet(ACCOUNTS.publisher) });
async function record(success: boolean, tier = 0, source = 0) {
  const hash = await base.wallet(VALIDATOR).writeContract({ address: ANCHOR, abi: recordAbi, functionName: "record",
    args: [`0x${(taskN++).toString(16).padStart(64, "0")}` as Hex, agentId, CAT, success, 1000n, tier, source] } as never);
  assert.equal((await base.pub.waitForTransactionReceipt({ hash })).status, "success");
}
async function text(key: string): Promise<string> {
  const raw = await ens.pub.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "resolve",
    args: [dnsName(NAME), encodeFunctionData({ abi: textAbi, functionName: "text", args: [namehash(NAME), key] })] });
  return decodeFunctionResult({ abi: textAbi, functionName: "text", data: raw });
}

test("outcomes recorded on Base are mirrored to mergit.reputation, the operator to mergit.operator, in one transaction using only those two keys", { skip }, async () => {
  await record(true); await record(false);
  const r = await publishPass(ctx(), cfg);
  assert.deepEqual(r.changed.map((c) => c.key).sort(), ["mergit.operator", "mergit.reputation"]);
  assert.ok(r.hash);
  const rep = JSON.parse(await text("mergit.reputation"));
  assert.equal(rep.auditedStaked, 2);
  assert.equal(rep.verifiedStaked, 1);
  assert.deepEqual(rep.byCategory, { "test-repair": { auditedStaked: 2, verifiedStaked: 1 } });
  assert.equal(rep.asOfBlock, Number(r.asOfBlock));
  assert.equal(rep.mirror, true);
  assert.equal(await text("mergit.operator"), ACCOUNTS.alice.address);
  const tx = await ens.pub.getTransaction({ hash: r.hash! });
  const outer = decodeFunctionData({ abi: permissionedResolverAbi, data: tx.input });
  assert.equal(outer.functionName, "multicall");
  const keys = (outer.args![0] as Hex[]).map((c) => (decodeFunctionData({ abi: permissionedResolverAbi, data: c }).args as unknown[])[1]);
  assert.deepEqual([...keys].sort(), ["mergit.operator", "mergit.reputation"], "the publisher writes only its two keys");
});

test("a second pass with nothing new sends no transaction, even though the Base head has moved", { skip }, async () => {
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  await record(true, 1); // a tier 1 outcome mines a Base block but changes nothing that counts
  const r = await publishPass(ctx(), cfg);
  assert.equal(r.hash, null);
  assert.deepEqual(r.changed, []);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before, "no ENS transaction may be sent");
});

test("a new tier 0 outcome changes only mergit.reputation", { skip }, async () => {
  await record(true);
  const r = await publishPass(ctx(), cfg);
  assert.deepEqual(r.changed.map((c) => c.key), ["mergit.reputation"]);
  const rep = JSON.parse(await text("mergit.reputation"));
  assert.deepEqual([rep.auditedStaked, rep.verifiedStaked], [3, 2]);
});

test("a challenge ruling that overturns an audited success is counted once and flips the result", { skip }, async () => {
  const taskId = `0x${(900).toString(16).padStart(64, "0")}` as Hex;
  for (const [success, source] of [[true, 0], [false, 1]] as const) {
    const hash = await base.wallet(VALIDATOR).writeContract({ address: ANCHOR, abi: recordAbi, functionName: "record", args: [taskId, agentId, CAT, success, 1000n, 0, source] } as never);
    await base.pub.waitForTransactionReceipt({ hash });
  }
  const r = await publishPass(ctx(), cfg);
  assert.deepEqual(r.changed.map((c) => c.key), ["mergit.reputation"]);
  const rep = JSON.parse(await text("mergit.reputation"));
  assert.deepEqual([rep.auditedStaked, rep.verifiedStaked], [4, 2], "one more task counted, as a failure");
});

test("after the agent is transferred on Base, the next pass changes only mergit.operator", { skip }, async () => {
  await impersonate(base, ACCOUNTS.alice.address);
  const hash = await base.wallet(ACCOUNTS.alice.address).writeContract({ address: IDENTITY, abi: identityAbi, functionName: "transferFrom", args: [ACCOUNTS.alice.address, ACCOUNTS.bob.address, agentId] } as never);
  assert.equal((await base.pub.waitForTransactionReceipt({ hash })).status, "success");
  const r = await publishPass(ctx(), cfg);
  assert.deepEqual(r.changed.map((c) => c.key), ["mergit.operator"]);
  assert.equal(await text("mergit.operator"), ACCOUNTS.bob.address);
});

test("if reading Base logs fails the pass writes nothing", { skip }, async () => {
  await record(true);
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  const broken = { ...base.pub, getLogs: () => Promise.reject(new Error("rpc down")) } as unknown as PublicClient;
  await assert.rejects(publishPass({ ...ctx(), base: broken }, cfg), /outcomes: logs for blocks .* failed: rpc down/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
});

test("an agent id that is not registered on Base fails the pass loudly instead of being skipped", { skip }, async () => {
  // the name carries a registration record (as the one-shot would write it) but no such agent exists on Base
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText",
    args: [dnsName("ghost.mergit.eth"), agentRegistrationKey(IDENTITY, 84532, 999999n), "1"] } as never) });
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  await assert.rejects(publishPass(ctx(), { ...cfg, agents: [...cfg.agents, { label: "ghost", agentId: 999999 }] }), /operatorOf\(999999\) failed/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
});

test("with an outcome cache, a later pass fetches only the blocks after the previous head and still counts everything", { skip }, async () => {
  const ranges: [bigint, bigint][] = [];
  const spying = { ...base.pub, getLogs: (a: { fromBlock: bigint; toBlock: bigint }) => { ranges.push([a.fromBlock, a.toBlock]); return (base.pub as any).getLogs(a); } } as unknown as PublicClient;
  const cache = newOutcomeCache(cfg.fromBlock);
  const first = await publishPass({ ...ctx(), base: spying }, cfg, cache);
  assert.ok(ranges.length >= 1 && ranges[0][0] === cfg.fromBlock, "the first pass reads from the configured start");
  ranges.length = 0;
  await record(true);
  const second = await publishPass({ ...ctx(), base: spying }, cfg, cache);
  assert.ok(second.asOfBlock > first.asOfBlock);
  assert.ok(ranges.length >= 1 && ranges.every(([from]) => from >= first.asOfBlock + 1n), `later passes must not re-read old blocks: ${JSON.stringify(ranges.map((r) => r.map(String)))}`);
  const rep = JSON.parse(await text("mergit.reputation"));
  assert.equal(rep.auditedStaked, 6, "the cached outcomes and the new one are all counted");
});

test("an ENS read failure that is not a revert fails the pass and sends nothing (it must not be read as 'unset' and rewritten)", { skip }, async () => {
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  const flaky = { ...ens.pub, readContract: () => Promise.reject(new Error("HTTP request failed. 429 rate limited")) } as unknown as PublicClient;
  await assert.rejects(publishPass({ ...ctx(), ens: flaky }, cfg), /publisher: reading .* failed: .*429/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
});

test("a resolver address with no contract code fails the pass before anything is sent", { skip }, async () => {
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  // not an anvil test account: some of those carry EIP-7702 delegation code on mainnet
  const empty = getAddress("0x" + keccak256(toHex("an address with no code")).slice(26));
  assert.equal(await ens.pub.getCode({ address: empty }), undefined, "precondition: the address has no code");
  await assert.rejects(publishPass(ctx(), { ...cfg, resolver: empty }), /no contract code/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
});

test("a configured agent whose name carries no agent-registration record for that id fails the pass (wrong label or id in the config)", { skip }, async () => {
  const before = await ens.pub.getBlockNumber({ cacheTime: 0 });
  await assert.rejects(publishPass(ctx(), { ...cfg, agents: [{ label: "coder-1", agentId: Number(agentId) }] }), /agent-registration/);
  assert.equal(await ens.pub.getBlockNumber({ cacheTime: 0 }), before);
});

test("a pass counts only blocks with enough confirmations: a fresh outcome is not counted until it is buried", { skip }, async () => {
  const c = { ...cfg, confirmations: 3 };
  const counted = async () => JSON.parse(await text("mergit.reputation")).auditedStaked as number;
  // baseline: bury every earlier outcome (earlier tests ran with confirmations 0), so the record already counts all of them at depth 3
  await base.pub.request({ method: "anvil_mine", params: ["0x3"] } as never);
  await publishPass(ctx(), c);
  const start = await counted();
  await record(true);
  const early = await publishPass(ctx(), c);
  assert.equal(await counted(), start, "the outcome sits in the head block, inside the confirmation depth");
  assert.equal(early.hash, null);
  await base.pub.request({ method: "anvil_mine", params: ["0x3"] } as never);
  const later = await publishPass(ctx(), c);
  assert.equal(await counted(), start + 1);
  assert.equal(later.asOfBlock, (await base.pub.getBlockNumber({ cacheTime: 0 })) - 3n, "asOfBlock is the confirmed block, not the head");
});
