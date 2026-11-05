import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { MAINNET } from "../src/deployments.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";
import { runOneShot, verifyOneShot, type OneShotConfig, type OneShotResult } from "../src/oneshot.ts";
import { predictResolverAddress } from "../src/resolver-deploy.ts";
import { ACCOUNTS, impersonate, startFork, type Fork } from "./fork.ts";

// Rehearsal of the mainnet one-shot on a fork, with the real owner of mergit.eth impersonated (no key involved).
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
const CHAIN = { chainId: 84532, identity: getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6") };
const cfg: OneShotConfig = {
  chain: CHAIN, publisher: ACCOUNTS.publisher.address, editor: ACCOUNTS.mergit.address,
  agents: [0, 1, 2].map((n) => ({
    label: `coder-${n}`, agentId: n + 2, name: `coder-${n}`,
    description: `Mergit coding agent number ${n}.`, profileUrl: `https://mergit.site/agents/coder-${n}.mergit.eth`,
  })),
};
const EXPECTED_STEPS = [
  "deploy resolver",
  "grant publisher mergit.reputation",
  "grant publisher mergit.operator",
  "grant editor agent-context",
  "grant editor agent-endpoint[web]",
  "write 9 agent records",
  "point mergit.eth at the resolver",
];

const currentResolver = (f: Fork) =>
  f.pub.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "getResolver", args: ["mergit"] }) as Promise<Address>;

async function writeText(f: Fork, resolver: Address, from: (typeof ACCOUNTS)[keyof typeof ACCOUNTS], name: string, key: string, value: string) {
  const hash = await f.wallet(from).writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(name), key, value] } as never);
  assert.equal((await f.pub.waitForTransactionReceipt({ hash })).status, "success");
}
async function refused(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => { assert.match(`${(e as Error).message}`, /EACUnauthorizedAccountRoles/); return true; });
}

let fork: Fork;
let result: OneShotResult;
let originalResolver: Address;
after(async () => { if (fork) await fork.stop(); }); // file-level: the first test's fork is reused by the second

test("the one-shot runs on a mainnet fork in the planned order and every record reads back through the Universal Resolver", { skip }, async () => {
  fork = await startFork();
  await impersonate(fork, OWNER);
  originalResolver = await currentResolver(fork);
  const predicted = await predictResolverAddress(fork.pub, OWNER, 0n);
  result = await runOneShot({ pub: fork.pub, wallet: fork.wallet(OWNER), owner: OWNER }, cfg);

  assert.deepEqual(result.steps.map((s) => s.step), EXPECTED_STEPS);
  assert.equal(result.resolver.toLowerCase(), predicted.toLowerCase(), "the resolver address must be known before anything is sent");
  assert.notEqual(result.resolver.toLowerCase(), originalResolver.toLowerCase());
  assert.equal((await currentResolver(fork)).toLowerCase(), result.resolver.toLowerCase());

  const rows = await verifyOneShot(fork.pub, cfg, result.resolver);
  assert.equal(rows.length, 9 + 1);
  assert.deepEqual(rows.filter((r) => !r.ok), [], "every record and the registry resolver must read back");
  assert.ok(rows.some((r) => r.key === agentRegistrationKey(CHAIN.identity, CHAIN.chainId, 2) && r.name === "coder-0.mergit.eth" && r.got === "1"));

  const total = result.steps.reduce((a, s) => a + s.gasUsed, 0n);
  const reportTotal = BigInt(JSON.parse(readFileSync(new URL("../gas-report.json", import.meta.url), "utf8")).totalOneShotUnits);
  assert.ok(total > reportTotal / 2n && total < reportTotal * 2n, `one-shot gas ${total} is far from the measured ${reportTotal}`);
});

test("after the one-shot the publisher and the editor can write only their keys, and nobody else can write anything", { skip }, async () => {
  const r = result.resolver;
  await writeText(fork, r, ACCOUNTS.publisher, "coder-0.mergit.eth", "mergit.reputation", '{"v":0}');
  await writeText(fork, r, ACCOUNTS.publisher, "coder-0.mergit.eth", "mergit.operator", ACCOUNTS.alice.address);
  await writeText(fork, r, ACCOUNTS.mergit, "coder-0.mergit.eth", "agent-endpoint[web]", "https://mergit.site/agents/changed");
  await writeText(fork, r, ACCOUNTS.mergit, "coder-1.mergit.eth", "agent-context", "# changed");
  await refused(writeText(fork, r, ACCOUNTS.alice, "coder-0.mergit.eth", "mergit.reputation", "x"));
  await refused(writeText(fork, r, ACCOUNTS.alice, "coder-1.mergit.eth", "agent-endpoint[web]", "x"));
  await refused(writeText(fork, r, ACCOUNTS.mergit, "coder-0.mergit.eth", "mergit.reputation", "x"));
  await refused(writeText(fork, r, ACCOUNTS.mergit, "coder-0.mergit.eth", agentRegistrationKey(CHAIN.identity, CHAIN.chainId, 2), "1"));
  await refused(writeText(fork, r, ACCOUNTS.publisher, "coder-0.mergit.eth", "agent-endpoint[web]", "x"));
  await refused(writeText(fork, r, ACCOUNTS.mergit, "coder-0.mergit.eth", "mergit.operator", "x")); // the editor may not write the operator record
  await refused(writeText(fork, r, ACCOUNTS.alice, "coder-0.mergit.eth", "mergit.operator", "x"));
});

test("if the multicall fails the run stops: it names the step, lists what was done and the resolver, and mergit.eth still points at the old resolver", { skip }, async () => {
  const f2 = await startFork();
  after(() => f2.stop());
  await impersonate(f2, OWNER);
  const before = await currentResolver(f2);
  const real = f2.wallet(OWNER);
  const flaky = {
    ...real,
    writeContract: (args: { functionName: string }) =>
      args.functionName === "multicall" ? Promise.reject(new Error("simulated revert")) : real.writeContract(args as never),
  } as typeof real;
  await assert.rejects(runOneShot({ pub: f2.pub, wallet: flaky, owner: OWNER }, cfg), (e: unknown) => {
    const m = (e as Error).message;
    assert.match(m, /one-shot: step "write 9 agent records" failed/);
    assert.match(m, /deploy resolver/);
    assert.match(m, /0x[0-9a-fA-F]{40}/, "the message must include the deployed resolver address");
    assert.match(m, /simulated revert/);
    return true;
  });
  assert.equal((await currentResolver(f2)).toLowerCase(), before.toLowerCase());
});

test("running the one-shot again on a configured name is refused before anything is sent (it would orphan the records on the current resolver)", { skip }, async () => {
  const before = await currentResolver(fork);
  const block = await fork.pub.getBlockNumber({ cacheTime: 0 });
  await assert.rejects(runOneShot({ pub: fork.pub, wallet: fork.wallet(OWNER), owner: OWNER }, { ...cfg, saltNonce: 7 }), /already configured/);
  assert.equal(await fork.pub.getBlockNumber({ cacheTime: 0 }), block, "no transaction may be sent");
  assert.equal((await currentResolver(fork)).toLowerCase(), before.toLowerCase());
});

test("a failed receipt wait still reports the resolver address and the tx hash, and a rerun reuses the deployed resolver and finishes", { skip }, async () => {
  const f3 = await startFork();
  after(() => f3.stop());
  await impersonate(f3, OWNER);
  const predicted = await predictResolverAddress(f3.pub, OWNER, 0n);
  const flakyPub = { ...f3.pub, waitForTransactionReceipt: () => Promise.reject(new Error("simulated receipt timeout")) } as typeof f3.pub;
  await assert.rejects(runOneShot({ pub: flakyPub, wallet: f3.wallet(OWNER), owner: OWNER }, cfg), (e: unknown) => {
    const m = (e as Error).message;
    assert.match(m, /one-shot: step "deploy resolver" failed/);
    assert.ok(m.toLowerCase().includes(predicted.toLowerCase()), "the message must name the resolver address");
    assert.match(m, /0x[0-9a-fA-F]{64}/, "the message must include the transaction hash");
    assert.match(m, /simulated receipt timeout/);
    return true;
  });
  assert.notEqual(await f3.pub.getCode({ address: predicted }), undefined, "the deploy transaction did land");

  const r2 = await runOneShot({ pub: f3.pub, wallet: f3.wallet(OWNER), owner: OWNER }, cfg);
  assert.equal(r2.resolver.toLowerCase(), predicted.toLowerCase());
  assert.equal(r2.steps[0].step, "reuse resolver (already deployed)");
  assert.deepEqual(r2.steps.slice(1).map((x) => x.step), EXPECTED_STEPS.slice(1));
  assert.deepEqual((await verifyOneShot(f3.pub, cfg, r2.resolver)).filter((r) => !r.ok), []);
});
