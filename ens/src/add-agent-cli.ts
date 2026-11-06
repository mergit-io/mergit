import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, mainnet } from "viem/chains";
import { executeAddAgent, followUps, planAddAgent, type AddAgentContext, type AddAgentPlan } from "./add-agent.ts";
import { parseAddAgentArgs, type AddAgentArgs } from "./add-agent-args.ts";
import { loadConfig } from "./config.ts";
import { redact } from "./writer-env.ts";

// Adds ONE agent after the one-shot has already run (the one-shot refuses to run twice). A dry run unless --execute.
//   node src/add-agent-cli.ts agents.json --label <platform name> --description "<text>"             plan only, sends nothing
//   ENS_OWNER_PRIVATE_KEY=... node src/add-agent-cli.ts agents.json --label ... --description ... --execute
//   ... --agent-id N      rerun after a stop that came after registerAgent: registers nothing, does the missing steps
// The label is the agent's platform name and needs an [agents.<label>] stanza in control-plane/agents.toml first.
// --execute needs ENS_OWNER_PRIVATE_KEY (one wallet signs on both chains), ENS_MAINNET_RPC and BASE_SEPOLIA_RPC in the
// environment. The key is never accepted as an argument and never printed; neither is an RPC URL (they often carry a secret).
// The new runtime key goes to ~/.config/mergit/agent-<label>.env (mode 600, never overwritten); only its address is printed.
// (ens/RUNBOOK.md still says an append mode is not built; this is it.)
let secrets: string[] = [];
const out = (s = "") => console.log(redact(s, secrets));
const fail = (msg: string): never => { console.error(redact(msg, secrets)); process.exit(1); };

let args!: AddAgentArgs;
try { args = parseAddAgentArgs(process.argv.slice(2), process.env); } catch (e) { fail((e as Error).message); }
secrets = [args.mainnetRpc, args.baseRpc, ...(args.mode === "execute" ? [args.privateKey, args.privateKey.slice(2)] : [])];

const here = import.meta.dirname;
const registrationDir = resolve(args.registrationsDir ?? join(here, "..", "..", "frontend", "public", "registrations"));
const tomlPath = resolve(args.agentsTomlPath ?? join(here, "..", "..", "control-plane", "agents.toml"));
const keyPath = join(homedir(), ".config", "mergit", `agent-${args.label}.env`);
const short = (s: string) => { const v = s.replace(/\n+/g, " "); return v.length > 60 ? v.slice(0, 57) + "..." : v; };

function printPlan(p: AddAgentPlan) {
  out(`Agent:           ${p.label}   ENS name ${p.ensName}`);
  out(`Owner (operator, resolver admin): ${p.owner}`);
  out(`Agent id:        ${p.agentId}${p.rerun ? "  (--agent-id: already registered, verified)" : "  (preview of what registerAgent will return)"}`);
  out(`Runtime key:     ${p.runtimeKey ?? `(generated at --execute, saved to ${keyPath}, mode 600)`}`);
  out(`Metadata URI:    ${p.metadataUri}`);
  out(`Registration file: ${p.registrationPath}`);
  out(`Resolver (mergit.eth points at it; records are added here, nothing is replaced): ${p.resolver}`);
  out("\nRecords to write, one multicall:");
  for (const r of p.records) out(`  ${p.ensName}  ${r.key} = ${short(r.value)}`); // the full key: the owner is about to sign for it
  out("\nSteps with --execute: " + (p.rerun ? "" : "make runtime key; registerAgent on Base; ") + "write registration file; write the three records; read them back; append to agents.json.");
}

try {
  const cfg = loadConfig(args.configPath, { allowTestAddresses: true }); // publisher and editor are not used here
  let agentsToml = "";
  try { agentsToml = readFileSync(tomlPath, "utf8"); } catch (e) { fail(`cannot read ${tomlPath} (the platform's agent list): ${(e as Error).message}`); }
  const mainnetPub = createPublicClient({ chain: mainnet, transport: http(args.mainnetRpc) }) as PublicClient;
  const basePub = createPublicClient({ chain: baseSepolia, transport: http(args.baseRpc) }) as PublicClient;
  const ctx: AddAgentContext = { mainnet: mainnetPub, base: basePub, cfg, registrationDir, agentsToml };
  const input = { label: args.label, description: args.description, ...(args.agentId !== undefined ? { agentId: args.agentId } : {}) };

  if (args.mode === "dry-run") {
    const r = await planAddAgent(ctx, input);
    if (!r.ok) fail(`Refusing (${r.code}): ${r.message}`);
    else {
      printPlan(r.plan);
      out("\nFollow-ups after --execute (printed again with the real values):");
      followUps({ plan: r.plan, agentId: r.plan.agentId, runtimeKey: r.plan.runtimeKey, keyPath: null }).forEach((l) => out(l));
      out("\nDRY RUN: nothing was sent, no key file and no registration file was created. Add --execute (with ENS_OWNER_PRIVATE_KEY in the environment) to do it for real.");
    }
  } else {
    const account = privateKeyToAccount(args.privateKey);
    const planned = await planAddAgent(ctx, input);
    if (planned.ok) { printPlan(planned.plan); out("\nEXECUTING (mainnet and Base Sepolia)."); }
    const r = await executeAddAgent({
      ...ctx, agentsPath: args.configPath, keyPath,
      mainnetWallet: createWalletClient({ account, chain: mainnet, transport: http(args.mainnetRpc) }),
      baseWallet: createWalletClient({ account, chain: baseSepolia, transport: http(args.baseRpc) }),
    }, input);
    if (!r.ok) {
      if (r.done.length) { out("\nDone before the stop:"); r.done.forEach((d) => out(`  - ${d}`)); }
      for (const x of r.rows ?? []) out(`  ${x.ok ? "ok  " : "FAIL"} ${x.name}  ${x.key.length > 40 ? x.key.slice(0, 22) + "..." : x.key}${x.ok ? "" : `  got ${JSON.stringify(x.got)}`}`);
      if (r.registeredAgentId !== undefined) out(`\nThe agent exists on Base as id ${r.registeredAgentId}. Rerun the same command with --agent-id ${r.registeredAgentId}: it registers nothing and does only the missing steps.`);
      fail(`\nFAILED (${r.code}): ${r.message}`);
    } else {
      out(`\nAgent ${r.agentId} (${r.plan.ensName}) added. Runtime key address: ${r.runtimeKey}${r.keyPath ? `  (key in ${r.keyPath}, not printed)` : ""}`);
      for (const s of r.steps) out(`  ${s.step.padEnd(52)} gas ${s.gasUsed}  tx ${s.hash}`);
      out("\nRead back through the ENSv2 Universal Resolver:");
      for (const x of r.rows) out(`  ok   ${x.name}  ${x.key.length > 40 ? x.key.slice(0, 22) + "..." : x.key}`);
      out(`\nWrote ${r.registrationPath} and appended the agent (with its agentId) to ${r.agentsPath}.`);
      out("\nFollow-ups (nothing below was done for you):");
      followUps(r).forEach((l) => out(l));
    }
  }
} catch (e) { fail((e as Error).message); }
