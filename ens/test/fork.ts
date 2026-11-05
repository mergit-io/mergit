import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, http, keccak256, toHex,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { mainnet } from "viem/chains";
import { MAINNET } from "../src/deployments.ts";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { verifiableFactoryAbi } from "../src/abi/verifiableFactory.ts";

// anvil's public test mnemonic: these accounts hold 10,000 ETH on every anvil chain and are worthless elsewhere.
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (addressIndex: number) => mnemonicToAccount(MNEMONIC, { addressIndex });
export const ACCOUNTS = { admin: account(0), publisher: account(1), alice: account(2), bob: account(3), mergit: account(4) } as const;

/** Every role bit set (the factory docs' `0x1111...1111`): each role is one bit per nibble, admin roles are role << 128. */
export const ALL_ROLES = BigInt("0x" + "1".repeat(64));

export type Fork = {
  rpcUrl: string;
  pub: PublicClient;
  /** A wallet for a local test account, or for any address that has been impersonated with `impersonate`. */
  wallet(account: HDAccount | Address): WalletClient;
  stop(): Promise<void>;
};

/** DNS wire-format name, as the resolver's `name` arguments expect. */
export const dnsName = (name: string): Hex => toHex(packetToBytes(name));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export async function startFork(): Promise<Fork> {
  const upstream = process.env.ENS_MAINNET_RPC;
  if (!upstream) throw new Error("startFork: ENS_MAINNET_RPC is not set");
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--fork-url", upstream, "--port", String(port), "--host", "127.0.0.1", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d));
  let exited = false;
  proc.once("exit", () => (exited = true));

  const pub = createPublicClient({ chain: mainnet, transport: http(rpcUrl) }) as PublicClient;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`anvil exited early: ${stderr.trim() || "no output"}`);
    try { await pub.getChainId(); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`anvil did not start within 60s: ${stderr.trim()}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    rpcUrl, pub,
    wallet: (acc) => createWalletClient({ account: acc, chain: mainnet, transport: http(rpcUrl) }),
    stop: async () => { if (!exited) { proc.kill(); await new Promise((r) => proc.once("exit", r)); } },
  };
}

let saltCounter = 0n;

/** Lets the fork send transactions as `address` (no key needed) and funds it with 10 ETH. Fork-only. */
export async function impersonate(fork: Fork, address: Address): Promise<void> {
  await fork.pub.request({ method: "anvil_impersonateAccount", params: [address] } as never);
  await fork.pub.request({ method: "anvil_setBalance", params: [address, "0x8ac7230489e80000"] } as never);
}

/** Deploys a fresh PermissionedResolver proxy through the VerifiableFactory; `owner` gets every role. */
export async function deployResolver(fork: Fork, owner: Address): Promise<Address> {
  return (await deployResolverDetailed(fork, owner)).address;
}

export async function deployResolverDetailed(fork: Fork, owner: Address): Promise<{ address: Address; gasUsed: bigint }> {
  const salt = BigInt(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [keccak256(toHex("OwnedResolver")), owner, saltCounter++],
  )));
  const data = encodeFunctionData({
    abi: permissionedResolverAbi, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }], []],
  });
  const hash = await fork.wallet(ACCOUNTS.admin).writeContract({
    address: MAINNET.verifiableFactory, abi: verifiableFactoryAbi, functionName: "deployProxy",
    args: [MAINNET.permissionedResolverImpl, salt, data],
  });
  const receipt = await fork.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`deployProxy reverted (tx ${hash})`);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MAINNET.verifiableFactory.toLowerCase()) continue;
    const ev = decodeEventLog({ abi: verifiableFactoryAbi, data: log.data, topics: log.topics });
    if (ev.eventName === "ProxyDeployed") {
      const a = ev.args as unknown as Record<string, Address> & Address[];
      return { address: (a.proxyAddress ?? a[3]) as Address, gasUsed: receipt.gasUsed };
    }
  }
  throw new Error(`deployProxy succeeded but no ProxyDeployed event was found (tx ${hash})`);
}
