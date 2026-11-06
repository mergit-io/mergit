import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { MAINNET } from "../src/deployments.ts";

const rpc = process.env.ENS_MAINNET_RPC;

test("MAINNET lists the four ENSv2 contracts as checksummed addresses", () => {
  assert.deepEqual(Object.keys(MAINNET).sort(), [
    "ethRegistry",
    "permissionedResolverImpl",
    "universalResolverV2",
    "verifiableFactory",
  ]);
  for (const [name, address] of Object.entries(MAINNET)) {
    assert.ok(isAddress(address, { strict: true }), `${name} is not a valid address`);
    assert.equal(address, getAddress(address), `${name} is not checksummed`);
  }
});

test("every MAINNET address has contract code on chain", { skip: !rpc && "ENS_MAINNET_RPC not set" }, async () => {
  const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
  for (const [name, address] of Object.entries(MAINNET)) {
    const code = await client.getCode({ address });
    assert.ok(code && code !== "0x", `${name} (${address}) has no code on mainnet`);
  }
});
