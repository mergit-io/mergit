import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { MAINNET } from "./deployments.ts";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { verifiableFactoryAbi } from "./abi/verifiableFactory.ts";

/** Every role bit set (the factory docs' `0x1111...1111`): each role is one bit per nibble, admin roles are role << 128. */
export const ALL_ROLES = BigInt("0x" + "1".repeat(64));

/** The factory docs' salt: keccak256(abi.encode(keccak256("OwnedResolver"), owner, version)). The factory mixes in msg.sender. */
export function resolverSalt(owner: Address, nonce: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [keccak256(toHex("OwnedResolver")), owner, nonce],
  )));
}

/** The proxy address `deployResolverProxy` will produce for this deployer and nonce (CREATE2, so it is known before anything is sent). */
export async function predictResolverAddress(pub: PublicClient, deployer: Address, nonce: bigint): Promise<Address> {
  return (await pub.readContract({
    address: MAINNET.verifiableFactory, abi: verifiableFactoryAbi, functionName: "predictProxyAddress", args: [deployer, resolverSalt(deployer, nonce)],
  })) as Address;
}

/** Deploys a PermissionedResolver proxy through the VerifiableFactory; `owner` gets every role. Waits for the receipt. */
export async function deployResolverProxy(
  ctx: { pub: PublicClient; wallet: WalletClient }, owner: Address, nonce: bigint,
): Promise<{ address: Address; hash: Hex; gasUsed: bigint }> {
  const data = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] });
  const hash = await ctx.wallet.writeContract({
    address: MAINNET.verifiableFactory, abi: verifiableFactoryAbi, functionName: "deployProxy",
    args: [MAINNET.permissionedResolverImpl, resolverSalt(owner, nonce), data],
  } as never);
  let receipt;
  try { receipt = await ctx.pub.waitForTransactionReceipt({ hash }); }
  catch (e) { throw new Error(`deployProxy transaction ${hash} was sent but its receipt could not be confirmed: ${(e as Error).message}`, { cause: e }); }
  if (receipt.status !== "success") throw new Error(`deployProxy reverted (tx ${hash})`);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MAINNET.verifiableFactory.toLowerCase()) continue;
    const ev = decodeEventLog({ abi: verifiableFactoryAbi, data: log.data, topics: log.topics });
    if (ev.eventName === "ProxyDeployed") {
      const a = ev.args as unknown as Record<string, Address>;
      if (!a.proxyAddress) throw new Error("ProxyDeployed has no proxyAddress argument; the factory ABI changed");
      return { address: a.proxyAddress, hash, gasUsed: receipt.gasUsed };
    }
  }
  throw new Error(`deployProxy succeeded but no ProxyDeployed event was found (tx ${hash})`);
}
