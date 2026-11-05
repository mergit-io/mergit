import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
// The web app's reader, loaded straight from the frontend source (plain Node: its modules import only viem and ./*.ts).
import { loadAgentEns, type EnsClients, type EnsConfig } from "../../frontend/src/chain/ens/agentEns.ts";
import { findRecordWriters, type WriterReads } from "../../frontend/src/chain/ens/writers.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { MAINNET } from "../src/deployments.ts";
import { dnsName } from "../src/dns.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";
import { publishPass, type PublisherConfig } from "../src/publisher.ts";
import { ACCOUNTS, deployResolver, impersonate, startFork, type Fork } from "./fork.ts";

// The frontend's ENS reader against real contracts: mainnet fork (ENS) and Base Sepolia fork (Identity, ReputationAnchor).
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const VALIDATOR = getAddress("0xb41263A86d0EB428Dd1895f7110060Da7EC89F55");
const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
const CAT = keccak256(toHex("test-repair"));
const NAME = "coder-0.mergit.eth";
const URI = "https://mergit.site/agents/coder-0.json";
const identityAbi = parseAbi([
  "function registerAgent(address runtimeKey, string metadataURI) returns (uint256 agentId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
]);
const recordAbi = parseAbi(["function record(bytes32 taskId, uint256 agentId, bytes32 category, bool success, uint256 costMicros, uint8 tier, uint8 source)"]);

let ensStart: bigint, ens: Fork, base: Fork, resolver: Address, agentId: bigint, publisherCfg: PublisherConfig, cfg: EnsConfig, clients: EnsClients;
const files = new Map<string, unknown>();
const goodFile = () => ({ services: [{ name: "ENS", endpoint: NAME }], registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:84532:${IDENTITY}` }] });

const adminWrite = async (key: string, value: string) =>
  ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(NAME), key, value] } as never) });

before(async () => {
  if (skip) return;
  ens = await startFork();
  ensStart = await ens.pub.getBlockNumber({ cacheTime: 0 });
  base = await startFork({ upstream: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chain: baseSepolia });
  await impersonate(base, VALIDATOR);
  await impersonate(ens, OWNER);
  resolver = await deployResolver(ens, ACCOUNTS.admin.address);
  for (const key of ["mergit.reputation", "mergit.operator"]) {
    const setter = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });
    await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter, ACCOUNTS.publisher.address] } as never) });
  }
  // the one-shot: records for the agent, then point mergit.eth at the resolver
  const sim = await base.pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.mergit.address, URI], account: ACCOUNTS.alice } as never);
  agentId = (sim as { result: bigint }).result;
  await base.pub.waitForTransactionReceipt({ hash: await base.wallet(ACCOUNTS.alice).writeContract((sim as { request: never }).request) });
  await adminWrite(agentRegistrationKey(IDENTITY, 84532, agentId), "1");
  await adminWrite("agent-context", "# coder-0\n\nA coding agent.");
  await adminWrite("agent-endpoint[web]", "https://mergit.site/agents/coder-0.mergit.eth");
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(OWNER).writeContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), resolver] } as never) });
  // two audited outcomes on Base, then a real publisher pass writes the mirror and the operator record
  for (const [n, success] of [[1, true], [2, false]] as const) {
    const hash = await base.wallet(VALIDATOR).writeContract({ address: ANCHOR, abi: recordAbi, functionName: "record", args: [`0x${n.toString(16).padStart(64, "0")}` as Hex, agentId, CAT, success, 1000n, 0, 0] } as never);
    await base.pub.waitForTransactionReceipt({ hash });
  }
  publisherCfg = { chain: { chainId: 84532, identity: IDENTITY, anchor: ANCHOR }, resolver, agents: [{ label: "coder-0", agentId: Number(agentId) }], knownCategories: ["test-repair"], fromBlock: (await base.pub.getBlockNumber({ cacheTime: 0 })) - 5n, confirmations: 0 };
  await publishPass({ base: base.pub, ens: ens.pub, wallet: ens.wallet(ACCOUNTS.publisher) }, publisherCfg);

  files.set(URI, goodFile());
  cfg = { identity: IDENTITY, chainId: 84532, universalResolver: MAINNET.universalResolverV2, registry: MAINNET.ethRegistry, anchor: ANCHOR };
  clients = {
    ens: { getEnsText: (a) => ens.pub.getEnsText(a), readContract: (a) => ens.pub.readContract(a as never) },
    base: { readContract: (a) => base.pub.readContract(a as never) },
    fetchJson: async (url) => {
      if (!files.has(url)) throw new Error("The registration file could not be fetched (404).");
      return files.get(url);
    },
  };
});
after(async () => { if (ens) await ens.stop(); if (base) await base.stop(); });

const load = () => loadAgentEns(clients, cfg, { agentId, label: "coder-0" });

test("a fully set-up agent reads as verified, with the owner and resolver read from mainnet and the mirror from the publisher", { skip }, async () => {
  const v = await load();
  assert.deepEqual(v.verification, { status: "verified" });
  assert.equal(v.badge, "verified");
  assert.equal(v.parentOwner, OWNER, "the owner of mergit.eth is read from the registry, not configured");
  assert.equal(v.resolver, resolver, "the resolver is read from the registry, not configured");
  assert.equal(v.records.endpointWeb, "https://mergit.site/agents/coder-0.mergit.eth");
  assert.equal(v.records.context, "# coder-0\n\nA coding agent.");
  assert.equal(v.operator.state, "current");
  assert.equal(v.operator.onEns, ACCOUNTS.alice.address);
  assert.equal(v.mirror.status, "ok");
  if (v.mirror.status === "ok") {
    assert.deepEqual([v.mirror.mirror.auditedStaked, v.mirror.mirror.verifiedStaked], [2, 1]);
    assert.deepEqual(v.mirror.mirror.byCategory, [{ category: "test-repair", auditedStaked: 2, verifiedStaked: 1 }]);
  }
  assert.deepEqual(v.unreadable, []);
});

test("a registration file that names a different ENS name is not verified", { skip }, async () => {
  files.set(URI, { ...goodFile(), services: [{ name: "ENS", endpoint: "coder-1.mergit.eth" }] });
  const v = await load();
  files.set(URI, goodFile());
  assert.equal(v.verification.status, "failed");
  assert.equal((v.verification as { reason: string }).reason, "name-mismatch");
  assert.equal(v.badge, "not-verified");
});

test("after the agent is sold on Base the badge becomes owner-changed, and a publisher pass makes it verified again with the new operator", { skip }, async () => {
  await impersonate(base, ACCOUNTS.alice.address);
  const hash = await base.wallet(ACCOUNTS.alice.address).writeContract({ address: IDENTITY, abi: identityAbi, functionName: "transferFrom", args: [ACCOUNTS.alice.address, ACCOUNTS.bob.address, agentId] } as never);
  assert.equal((await base.pub.waitForTransactionReceipt({ hash })).status, "success");
  const sold = await load();
  assert.deepEqual(sold.verification, { status: "verified" }, "the two-way check itself still passes");
  assert.equal(sold.operator.state, "changed");
  assert.equal(sold.operator.onBase, ACCOUNTS.bob.address);
  assert.equal(sold.operator.onEns, ACCOUNTS.alice.address);
  assert.equal(sold.badge, "owner-changed", "no tick for an agent sold since ENS was last updated");

  await publishPass({ base: base.pub, ens: ens.pub, wallet: ens.wallet(ACCOUNTS.publisher) }, publisherCfg);
  const refreshed = await load();
  assert.equal(refreshed.operator.state, "current");
  assert.equal(refreshed.operator.onEns, ACCOUNTS.bob.address);
  assert.equal(refreshed.badge, "verified");
});

test("an agent whose ENSIP-25 record is emptied is not verified", { skip }, async () => {
  await adminWrite(agentRegistrationKey(IDENTITY, 84532, agentId), "");
  const v = await load();
  assert.equal(v.verification.status, "failed");
  assert.equal((v.verification as { reason: string }).reason, "no-registration-record");
  assert.equal(v.badge, "not-verified");
  await adminWrite(agentRegistrationKey(IDENTITY, 84532, agentId), "1");
  assert.equal((await load()).badge, "verified");
});

test("a failing mainnet RPC gives a typed read-failed result, never a tick and never an exception", { skip }, async () => {
  const down: EnsClients = { ...clients, ens: { getEnsText: () => Promise.reject(new Error("HTTP request failed. 429")), readContract: () => Promise.reject(new Error("HTTP request failed. 429")) } };
  const v = await loadAgentEns(down, cfg, { agentId, label: "coder-0" });
  assert.equal(v.verification.status, "failed");
  assert.equal((v.verification as { reason: string }).reason, "read-failed");
  assert.equal(v.badge, "not-verified");
  assert.equal(v.parentOwner, null);
  assert.ok(v.unreadable.length >= 1);
});

test("a name the one-shot never wrote reads as not verified, not as an error", { skip }, async () => {
  const v = await loadAgentEns(clients, cfg, { agentId, label: "never-written" });
  assert.equal(v.verification.status, "failed");
  assert.equal((v.verification as { reason: string }).reason, "no-registration-record");
});

test("the account that last wrote each record is found from the resolver's logs: the publisher for its two keys, the owner-side admin for the rest", { skip }, async () => {
  const keys = ["mergit.reputation", "mergit.operator", "agent-endpoint[web]", "agent-context", agentRegistrationKey(IDENTITY, 84532, agentId), "mergit.never-written"];
  const head = await ens.pub.getBlockNumber({ cacheTime: 0 });
  const w = await findRecordWriters(ens.pub as unknown as WriterReads, resolver, NAME, keys, { fromBlock: ensStart, toBlock: head });
  assert.equal(w["mergit.reputation"]?.account, ACCOUNTS.publisher.address);
  assert.equal(w["mergit.operator"]?.account, ACCOUNTS.publisher.address);
  assert.equal(w["agent-endpoint[web]"]?.account, ACCOUNTS.admin.address);
  assert.equal(w["agent-context"]?.account, ACCOUNTS.admin.address);
  assert.equal(w[keys[4]!]?.account, ACCOUNTS.admin.address);
  assert.equal(w["mergit.never-written"], null, "a key nobody wrote is null, not a guess");
  // outside the window the answer is "not known"
  const outside = await findRecordWriters(ens.pub as unknown as WriterReads, resolver, NAME, ["mergit.reputation"], { fromBlock: ensStart, toBlock: ensStart });
  assert.equal(outside["mergit.reputation"], null);
});
