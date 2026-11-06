import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex } from "viem";
import { MAINNET } from "../src/deployments.ts";
import { permissionedRegistryAbi } from "../src/abi/permissionedRegistry.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { ACCOUNTS, deployResolver, dnsName, impersonate, startFork, type Fork } from "./fork.ts";

// Does the records-only design (E3) actually resolve? Subnames are records on one resolver, with no registry entry of their own.
const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const MERGIT_OWNER = getAddress("0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D");
let fork: Fork;
before(async () => { if (!skip) fork = await startFork(); });
after(async () => { if (fork) await fork.stop(); });

test("a record on coder-0.mergit.eth resolves through the ENSv2 Universal Resolver once mergit.eth points at our resolver", { skip }, async () => {
  const resolver = await deployResolver(fork, ACCOUNTS.admin.address);
  const before = await fork.pub.getEnsText({ name: "coder-0.mergit.eth", key: "agent-endpoint[web]", universalResolverAddress: MAINNET.universalResolverV2 }).catch((e) => `ERR:${(e as Error).name}`);
  assert.notEqual(before, "https://mergit.site/agents/coder-0", "the record must not resolve before it is written");

  await fork.pub.waitForTransactionReceipt({ hash: await fork.wallet(ACCOUNTS.admin).writeContract({
    address: resolver, abi: permissionedResolverAbi, functionName: "setText",
    args: [dnsName("coder-0.mergit.eth"), "agent-endpoint[web]", "https://mergit.site/agents/coder-0"],
  } as never) });
  await impersonate(fork, MERGIT_OWNER);
  await fork.pub.waitForTransactionReceipt({ hash: await fork.wallet(MERGIT_OWNER).writeContract({
    address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "setResolver", args: [BigInt(keccak256(toHex("mergit"))), resolver],
  } as never) });

  const after = await fork.pub.getEnsText({ name: "coder-0.mergit.eth", key: "agent-endpoint[web]", universalResolverAddress: MAINNET.universalResolverV2 });
  assert.equal(after, "https://mergit.site/agents/coder-0");
});
