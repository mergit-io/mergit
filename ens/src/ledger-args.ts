import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { key } from "./writer-env.ts";

export type LedgerArgs =
  | { command: "snapshot"; baseRpc: string; configPath: string; outDir: string; uriBase: string; commitmentsPath?: string; termsPath?: string }
  | { command: "publish"; ensRpc: string; configPath: string; recordPath: string; execute: false }
  | { command: "publish"; ensRpc: string; configPath: string; recordPath: string; execute: true; privateKey: Hex };

export const LEDGER_USAGE =
  "usage: node src/ledger-cli.ts snapshot [--out DIR] [--uri-base https://...] [--commitments FILE] [--terms FILE]\n       node src/ledger-cli.ts publish --record FILE [--execute]";
const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "public", "ledger");

/** What the ledger command may do. `publish` is a dry run unless `--execute`; the key is read (and checked) only for `--execute` and is never echoed. */
export function parseLedgerArgs(argv: string[], env: Record<string, string | undefined>): LedgerArgs {
  const [command, ...rest] = argv;
  if (command !== "snapshot" && command !== "publish") throw new Error(LEDGER_USAGE);
  const value: Record<string, string> = {};
  let execute = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--execute" && command === "publish") execute = true;
    else if (command === "snapshot" && ["--out", "--uri-base", "--commitments", "--terms"].includes(a)) value[a] = rest[++i] ?? "";
    else if (command === "publish" && a === "--record") value[a] = rest[++i] ?? "";
    else throw new Error(`unknown option ${a}. ${LEDGER_USAGE}`);
  }
  if (!env.WRITER_CONFIG) throw new Error("WRITER_CONFIG is required");
  const configPath = env.WRITER_CONFIG;
  if (command === "snapshot") {
    if (!env.BASE_SEPOLIA_RPC) throw new Error("BASE_SEPOLIA_RPC is required");
    const uriBase = (value["--uri-base"] ?? "https://mergit.site/ledger").replace(/\/+$/, "");
    let https = false;
    try { https = new URL(uriBase).protocol === "https:"; } catch { /* refused below */ }
    if (!https) throw new Error("--uri-base must be an https URL");
    return { command, baseRpc: env.BASE_SEPOLIA_RPC, configPath, outDir: value["--out"] ?? DEFAULT_OUT, uriBase,
      ...(value["--commitments"] ? { commitmentsPath: value["--commitments"] } : {}), ...(value["--terms"] ? { termsPath: value["--terms"] } : {}) };
  }
  if (!value["--record"]) throw new Error(`--record FILE is required. ${LEDGER_USAGE}`);
  if (!env.ENS_MAINNET_RPC) throw new Error("ENS_MAINNET_RPC is required");
  const base = { command, ensRpc: env.ENS_MAINNET_RPC, configPath, recordPath: value["--record"] } as const;
  if (!execute) return { ...base, execute: false };
  return { ...base, execute: true, privateKey: key(env, "ENS_PUBLISHER_PRIVATE_KEY").key };
}
