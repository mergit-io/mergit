import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, getAddress, namehash, parseAbi, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { editMessage, memoryNonceStore, type EditRequest } from "../src/edit-request.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";
import { handleEdit, newServiceState, type EditDeps } from "../src/writer-service.ts";
import { ACCOUNTS, deployResolver, impersonate, startFork, type Fork } from "./fork.ts";

// End to end on two real forks: operator signature -> operatorOf on Base -> role-limited editor key writes on mainnet.
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const identityAbi = parseAbi([
  "function registerAgent(address runtimeKey, string metadataURI) returns (uint256 agentId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
]);
const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const NAME = "coder-0.mergit.eth";

let ens: Fork, base: Fork, resolver: Address, agentId: bigint, deps: EditDeps;
before(async () => {
  if (skip) return;
  ens = await startFork();
  base = await startFork({ upstream: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chain: baseSepolia });
  resolver = await deployResolver(ens, ACCOUNTS.admin.address);
  for (const key of ["agent-context", "agent-endpoint[web]"]) {
    const setter = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });
    await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter, ACCOUNTS.mergit.address] } as never) });
  }
  const sim = await base.pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "registerAgent", args: [ACCOUNTS.mergit.address, "https://mergit.site/agents/coder-0.json"], account: ACCOUNTS.alice } as never);
  agentId = (sim as { result: bigint }).result;
  await base.pub.waitForTransactionReceipt({ hash: await base.wallet(ACCOUNTS.alice).writeContract((sim as { request: never }).request) });
  // the one-shot writes the agent-registration record; the service refuses to edit a name that lacks it
  await ens.pub.waitForTransactionReceipt({ hash: await ens.wallet(ACCOUNTS.admin).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText",
    args: [dnsName(NAME), agentRegistrationKey(IDENTITY, 84532, agentId), "1"] } as never) });
  deps = { base: base.pub as never, ens: ens.pub as never, wallet: ens.wallet(ACCOUNTS.mergit) as never, identity: IDENTITY, chainId: 84532, resolver,
    agents: [{ label: "coder-0", agentId: Number(agentId) }], seenNonces: memoryNonceStore(), startedAt: Math.floor(Date.now() / 1000) - 10,
    now: () => Math.floor(Date.now() / 1000), secrets: [], log: () => {}, state: newServiceState(), limits: { perAgentPerHour: 50, perHour: 500, requestsPerMinute: 1000 } };
});
after(async () => { if (ens) await ens.stop(); if (base) await base.stop(); });

const signed = async (who: typeof ACCOUNTS.alice, over: Partial<EditRequest>) => {
  const now = Math.floor(Date.now() / 1000);
  const request: EditRequest = { agentId: Number(agentId), key: "agent-endpoint[web]", value: "https://mergit.site/agents/new", nonce: "n" + Math.random().toString(36).slice(2),
    issuedAt: now - 1, expiresAt: now + 300, ...over };
  return { request, signature: await who.signMessage({ message: editMessage(request, { chainId: 84532, identity: IDENTITY }) }) };
};
async function text(key: string): Promise<string> {
  const raw = await ens.pub.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "resolve",
    args: [dnsName(NAME), encodeFunctionData({ abi: textAbi, functionName: "text", args: [namehash(NAME), key] })] });
  return decodeFunctionResult({ abi: textAbi, functionName: "text", data: raw });
}

test("the operator's signed edit is written by the editor key and resolves", { skip }, async () => {
  const res = await handleEdit(await signed(ACCOUNTS.alice, { value: "https://mergit.site/agents/changed" }), deps);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await text("agent-endpoint[web]"), "https://mergit.site/agents/changed");
  const ctx = await handleEdit(await signed(ACCOUNTS.alice, { key: "agent-context", value: "# coder-0\n\nnew text" }), deps);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
  assert.equal(await text("agent-context"), "# coder-0\n\nnew text");
});

test("someone who is not the operator is refused and the record is unchanged", { skip }, async () => {
  const before = await text("agent-endpoint[web]");
  const res = await handleEdit(await signed(ACCOUNTS.bob, { value: "https://evil.example/x" }), deps);
  assert.equal(res.status, 403);
  assert.equal(await text("agent-endpoint[web]"), before);
});

test("after the agent is transferred on Base, the previous owner is refused and the new owner is accepted", { skip }, async () => {
  await impersonate(base, ACCOUNTS.alice.address);
  const hash = await base.wallet(ACCOUNTS.alice.address).writeContract({ address: IDENTITY, abi: identityAbi, functionName: "transferFrom", args: [ACCOUNTS.alice.address, ACCOUNTS.bob.address, agentId] } as never);
  assert.equal((await base.pub.waitForTransactionReceipt({ hash })).status, "success");
  const before = await text("agent-endpoint[web]");
  const old = await handleEdit(await signed(ACCOUNTS.alice, { value: "https://alice.example/after-sale" }), deps);
  assert.equal(old.status, 403);
  assert.equal(await text("agent-endpoint[web]"), before);
  const fresh = await handleEdit(await signed(ACCOUNTS.bob, { value: "https://bob.example/new-owner" }), deps);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(await text("agent-endpoint[web]"), "https://bob.example/new-owner");
});
