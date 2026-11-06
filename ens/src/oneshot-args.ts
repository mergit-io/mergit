import type { Hex } from "viem";

export type Args =
  | { mode: "fork"; configPath: string; rpc: string }
  | { mode: "mainnet-plan"; configPath: string; rpc: string }
  | { mode: "mainnet-execute"; configPath: string; rpc: string; privateKey: Hex };

export const USAGE = "usage: node src/oneshot-cli.ts <config.json> (--fork | --mainnet [--execute])";

/**
 * Decides what the CLI is allowed to do. Mainnet sends nothing unless `--execute` is present, and the owner key is read from
 * the environment only for `--execute`. No error message ever contains the key.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      if (!["--fork", "--mainnet", "--execute"].includes(a)) throw new Error(`unknown option ${a}. ${USAGE}`);
      flags.add(a);
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  if (flags.has("--fork") === flags.has("--mainnet")) throw new Error(USAGE);
  if (flags.has("--execute") && !flags.has("--mainnet")) throw new Error(`--execute is only valid with --mainnet. ${USAGE}`);
  const rpc = env.ENS_MAINNET_RPC;
  if (!rpc) throw new Error("set ENS_MAINNET_RPC to an Ethereum mainnet RPC URL");
  const configPath = positional[0];
  if (flags.has("--fork")) return { mode: "fork", configPath, rpc };
  if (!flags.has("--execute")) return { mode: "mainnet-plan", configPath, rpc };
  const key = env.ENS_OWNER_PRIVATE_KEY;
  if (!key) throw new Error("--execute needs ENS_OWNER_PRIVATE_KEY in the environment");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ENS_OWNER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key");
  return { mode: "mainnet-execute", configPath, rpc, privateKey: key as Hex };
}
