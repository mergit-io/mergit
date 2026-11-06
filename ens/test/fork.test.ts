import { test, after } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi } from "viem";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { ACCOUNTS, deployResolver, dnsName, startFork } from "./fork.ts";

const skip = !process.env.ENS_MAINNET_RPC && "ENS_MAINNET_RPC not set";
const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);

test("a resolver deployed through the factory on a mainnet fork stores and returns a text record", { skip }, async () => {
  const fork = await startFork();
  after(() => fork.stop());
  const resolver = await deployResolver(fork, ACCOUNTS.admin.address);
  assert.notEqual(await fork.pub.getCode({ address: resolver }), undefined, "no code at the proxy");

  const name = "a.mergit.eth";
  const hash = await fork.wallet(ACCOUNTS.admin).writeContract({
    address: resolver, abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(name), "k", "v"],
  });
  const receipt = await fork.pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");

  const raw = await fork.pub.readContract({
    address: resolver, abi: permissionedResolverAbi, functionName: "resolve",
    args: [dnsName(name), encodeFunctionData({ abi: textAbi, functionName: "text", args: [namehash(name), "k"] })],
  });
  assert.equal(decodeFunctionResult({ abi: textAbi, functionName: "text", data: raw }), "v");
});
