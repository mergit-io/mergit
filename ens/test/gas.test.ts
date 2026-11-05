import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { encodeFunctionData, getAddress, keccak256, toHex, type Address } from "viem";
import { MAINNET } from "../src/deployments.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { estimateCostUsd } from "../src/gate.ts";
import { ACCOUNTS, deployResolverDetailed, dnsName, impersonate, startFork, type Fork } from "./fork.ts";

// M0/M1 gas measurement: the HLD's gas units were guesses. These are receipts from a mainnet fork.
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const MERGIT_OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D"); // owner of mergit.eth (gate report, 2026-11-06)
const ETH_USD = Number(process.env.ENS_ETH_USD ?? "2416"); // 2026-11-05 reading unless overridden
let fork: Fork;
before(async () => { if (!skip) fork = await startFork(); });
after(async () => { if (fork) await fork.stop(); });

const setter = (key: string) => encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("ignored.eth"), key, ""] });
const setText = (name: string, key: string, value: string) => encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(name), key, value] });

async function gas(hash: `0x${string}`): Promise<bigint> {
  const r = await fork.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
  return r.gasUsed;
}

test("measure gas units for the mainnet one-shot and write gas-report.json", { skip }, async () => {
  const forkBlock = Number(await fork.pub.getBlockNumber({ cacheTime: 0 })); // the block the fork started from, read before any transaction
  const admin = fork.wallet(ACCOUNTS.admin);
  const { address: resolver, gasUsed: deployProxy } = await deployResolverDetailed(fork, ACCOUNTS.admin.address);

  const grant = (key: string, to: Address) =>
    admin.writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "grantSetterRoles", args: [setter(key), to] } as never);
  const grantFirst = await gas(await grant("mergit.reputation", ACCOUNTS.publisher.address));
  const grantSecond = await gas(await grant("agent-endpoint[web]", ACCOUNTS.mergit.address));

  // a mergit.reputation record shaped like HLD 6.3 (source, counts, byCategory and the note)
  const json = JSON.stringify({ v: 0, mirror: true, source: { chainId: 84532, contract: "0xf9DBfF75887361A67269765DA6F8732b233Fda76" }, asOfBlock: 21000000,
    auditedStaked: 12, verifiedStaked: 11, byCategory: { "code-review": { auditedStaked: 7, verifiedStaked: 7 } },
    note: "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth." })
  assert.ok(Buffer.byteLength(json) >= 150, `the sample record is ${Buffer.byteLength(json)} bytes, expected at least 150`);
  // written by the publisher key, as in the real flow: first write to a new name, then an overwrite with changed counts
  const publisher = fork.wallet(ACCOUNTS.publisher);
  const writeRep = (value: string) => publisher.writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName("coder-9.mergit.eth"), "mergit.reputation", value] } as never);
  const setTextReputation = await gas(await writeRep(json));
  const setTextReputationOverwrite = await gas(await writeRep(json.replace('"auditedStaked":12', '"auditedStaked":13')));

  const calls = [0, 1, 2].flatMap((n) => [
    setText(`coder-${n}.mergit.eth`, "agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][" + n + "]", "1"),
    setText(`coder-${n}.mergit.eth`, "agent-context", "# coder-" + n + "\nA Mergit coding agent. Work is audited on chain."),
    setText(`coder-${n}.mergit.eth`, "agent-endpoint[web]", "https://mergit.site/agents/coder-" + n),
  ]);
  const multicall3Agents = await gas(await admin.writeContract({ address: resolver, abi: permissionedResolverAbi, functionName: "multicall", args: [calls] } as never));

  // the real tx on the real name: the owner points mergit.eth at the new resolver (impersonated on the fork, no key involved)
  await impersonate(fork, MERGIT_OWNER);
  const setResolver = await gas(await fork.wallet(MERGIT_OWNER).writeContract({
    address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), resolver],
  } as never));

  assert.ok(setTextReputationOverwrite < setTextReputation, "an overwrite of an existing record must cost less than the first write");
  const units = { deployProxy, grantSetterRolesFirst: grantFirst, grantSetterRolesSecond: grantSecond, setTextReputation, setTextReputationOverwrite, multicall3Agents, setResolver };
  for (const [k, v] of Object.entries(units)) assert.ok(v > 21_000n, `${k} gas ${v} is implausibly low`);
  assert.ok(multicall3Agents < 1_000_000n, `3-agent multicall used ${multicall3Agents} gas`);

  const total = deployProxy + grantFirst + grantSecond + multicall3Agents + setResolver;
  const lowGwei = 125_000_000n, highGwei = 5_000_000_000n;
  const report = {
    measuredAt: new Date().toISOString(), forkBlock, recordBytes: Buffer.byteLength(json),
    units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, Number(v)])), totalOneShotUnits: Number(total),
    ethUsdAssumed: ETH_USD,
    estimateUsd: { low: estimateCostUsd(total, lowGwei, ETH_USD), high: estimateCostUsd(total, highGwei, ETH_USD), lowGweiPrice: 0.125, highGweiPrice: 5 },
  };
  writeFileSync(new URL("../gas-report.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  assert.ok(report.estimateUsd.low > 0 && report.estimateUsd.high > report.estimateUsd.low);
});
