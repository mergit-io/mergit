import type { Hex } from "viem";
import { ensNameOf } from "./registration.ts";
import { key } from "./writer-env.ts";

export type AddAgentArgs =
  | { mode: "dry-run"; configPath: string; label: string; description: string; agentId?: number; mainnetRpc: string; baseRpc: string; registrationsDir?: string; agentsTomlPath?: string }
  | { mode: "execute"; configPath: string; label: string; description: string; agentId?: number; mainnetRpc: string; baseRpc: string; registrationsDir?: string; agentsTomlPath?: string; privateKey: Hex };

export const USAGE = "usage: node src/add-agent-cli.ts <agents.json> --label <label> --description \"<text>\" [--agent-id N] [--execute]\n       (the label is the agent's platform name, e.g. mergit-coder-3, and needs an [agents.<label>] stanza in control-plane/agents.toml)";
export const MAX_DESCRIPTION = 300; // the description goes into an ENS text record and the registration file; keep it a short blurb

/**
 * A token that is exactly a raw private key (or any 32-byte hex value): refused on the command line, where shell history keeps it.
 * Whole tokens only, so a long run of letters that happen to be hex digits in a description is not mistaken for a key.
 */
const KEY_SHAPED = /(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/;

/**
 * Decides what the CLI is allowed to do. A dry run is the default and reads both chains; `--execute` also needs the owner key,
 * which is read from the environment only, never from an argument. `--agent-id N` is the rerun switch: the agent was already
 * registered (a previous run stopped after `registerAgent`), so registration is skipped and only the missing steps are done.
 * No error message ever contains the key or an RPC URL.
 */
export function parseAddAgentArgs(argv: string[], env: Record<string, string | undefined>): AddAgentArgs {
  // before anything else, and without echoing the argument: a pasted key must not land in an error message either
  if (argv.some((a) => KEY_SHAPED.test(a))) throw new Error("an argument looks like a private key. Never pass a key as an argument: put the owner key in ENS_OWNER_PRIVATE_KEY in the environment.");
  const positional: string[] = [];
  const value: Record<string, string> = {};
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    if (a === "--execute") {
      if (execute) throw new Error(`--execute given more than once. ${USAGE}`);
      execute = true;
    } else if (a === "--label" || a === "--description" || a === "--agent-id" || a === "--registrations-dir" || a === "--agents-toml") {
      if (a in value) throw new Error(`${a} given more than once. ${USAGE}`);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value. ${USAGE}`);
      value[a] = v;
      i++;
    } else throw new Error(`unknown option ${a}. ${USAGE}`);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  if (value["--label"] === undefined) throw new Error(`--label is required. ${USAGE}`);
  ensNameOf(value["--label"]); // the one-shot's own label rules (lowercase letters, digits, hyphens)
  const description = value["--description"];
  if (description === undefined || !description.trim()) throw new Error(`--description is required. ${USAGE}`);
  if (description.length > MAX_DESCRIPTION) throw new Error(`--description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}`);
  let agentId: number | undefined;
  if (value["--agent-id"] !== undefined) {
    const n = /^\d+$/.test(value["--agent-id"]) ? Number(value["--agent-id"]) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--agent-id must be a positive integer");
    agentId = n;
  }
  const mainnetRpc = env.ENS_MAINNET_RPC;
  const baseRpc = env.BASE_SEPOLIA_RPC;
  if (!mainnetRpc) throw new Error("set ENS_MAINNET_RPC to an Ethereum mainnet RPC URL");
  if (!baseRpc) throw new Error("set BASE_SEPOLIA_RPC to a Base Sepolia RPC URL");
  const base = { configPath: positional[0]!, label: value["--label"], description,
    ...(value["--registrations-dir"] !== undefined ? { registrationsDir: value["--registrations-dir"] } : {}),
    ...(value["--agents-toml"] !== undefined ? { agentsTomlPath: value["--agents-toml"] } : {}), ...(agentId !== undefined ? { agentId } : {}), mainnetRpc, baseRpc };
  if (!execute) return { mode: "dry-run", ...base };
  return { mode: "execute", ...base, privateKey: key(env, "ENS_OWNER_PRIVATE_KEY").key };
}
