import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, createWalletClient, http, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import type { HDAccount } from "viem/accounts";
import { testAccount } from "./test-accounts.ts";
import { mainnet } from "viem/chains";
import { deployResolverProxy } from "./resolver-deploy.ts";

// anvil's public test mnemonic: these accounts hold 10,000 ETH on every anvil chain and are worthless elsewhere.
const account = (addressIndex: number) => testAccount(addressIndex);
export const ACCOUNTS = { admin: account(0), publisher: account(1), alice: account(2), bob: account(3), mergit: account(4) } as const;

export { ALL_ROLES } from "./resolver-deploy.ts";

export type Fork = {
  rpcUrl: string;
  pub: PublicClient;
  /** A wallet for a local test account, or for any address that has been impersonated with `impersonate`. */
  wallet(account: HDAccount | Address): WalletClient;
  stop(): Promise<void>;
};

export { dnsName } from "./dns.ts";

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

export async function startFork(opts: { upstream?: string; chain?: Chain } = {}): Promise<Fork> {
  const upstream = opts.upstream ?? process.env.ENS_MAINNET_RPC;
  const chain = opts.chain ?? mainnet;
  if (!upstream) throw new Error("startFork: ENS_MAINNET_RPC is not set");
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--fork-url", upstream, "--port", String(port), "--host", "127.0.0.1", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d));
  let exited = false;
  proc.once("exit", () => (exited = true));

  const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`anvil exited early: ${stderr.trim() || "no output"}`);
    try { await pub.getChainId(); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`anvil did not start within 60s: ${stderr.trim()}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    rpcUrl, pub,
    wallet: (acc) => createWalletClient({ account: acc, chain, transport: http(rpcUrl) }),
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
  const { address, gasUsed } = await deployResolverProxy({ pub: fork.pub, wallet: fork.wallet(ACCOUNTS.admin) }, owner, saltCounter++);
  return { address, gasUsed };
}
