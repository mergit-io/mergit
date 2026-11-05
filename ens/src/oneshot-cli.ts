import { createPublicClient, createWalletClient, formatEther, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { MAINNET } from "./deployments.ts";
import { permissionedRegistryAbi } from "./abi/permissionedRegistry.ts";
import { loadConfig } from "./config.ts";
import { impersonate, startFork } from "./fork.ts";
import { assertNotAlreadyConfigured, runOneShot, verifyOneShot, type OneShotConfig, type OneShotResult } from "./oneshot.ts";
import { predictResolverAddress } from "./resolver-deploy.ts";
import { agentRecords } from "./oneshot-plan.ts";
import { parseArgs } from "./oneshot-args.ts";

const out = (s = "") => console.log(s);
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

let args;
try { args = parseArgs(process.argv.slice(2), process.env); } catch (e) { fail((e as Error).message); }
const { mode, configPath, rpc } = args!;
let cfg: OneShotConfig;
try { cfg = loadConfig(configPath, { allowTestAddresses: mode === "fork" }); } catch (e) { fail((e as Error).message); }
const unregistered = cfg!.agents.filter((a) => a.agentId === undefined).map((a) => a.label);
if (unregistered.length) fail(`config: these agents have no agentId yet: ${unregistered.join(", ")}. Register them on Base first and put the returned ids in the config (ens/RUNBOOK.md, step 1).`);

const readOwner = async (pub: PublicClient) => (await pub.readContract({ address: MAINNET.ethRegistry, abi: permissionedRegistryAbi, functionName: "findOwner", args: ["mergit"] })) as Address;
// Measured in the fork rehearsal of the three-agent example (1,437,255 gas, seven steps); it grows with the number and size of records.
const ESTIMATED_UNITS = 1_440_000n;
const HEADROOM = 2n; // the balance check wants twice the estimate at the current gas price, since the price moves

async function printPlan(pub: PublicClient, owner: Address, nRecords: number) {
  out(`Owner of mergit.eth (on chain): ${owner}`);
  out(`New resolver address (deterministic, saltNonce ${cfg.saltNonce ?? 0}): ${await predictResolverAddress(pub, owner, BigInt(cfg.saltNonce ?? 0))}`);
  out("  A rerun with the same saltNonce reuses this resolver if it was already deployed.");
  out(`Publisher key holder: ${cfg.publisher}`);
  out(`Editor key holder:    ${cfg.editor}`);
  out("\nSteps, in order (the name is only pointed at the new resolver at the very end):");
  ["deploy resolver", "grant publisher mergit.reputation", "grant publisher mergit.operator", "grant editor agent-context", "grant editor agent-endpoint[web]", `write ${nRecords} agent records`, "point mergit.eth at the resolver"]
    .forEach((s, i) => out(`  ${i + 1}. ${s}`));
  out("\nRecords:");
  for (const a of cfg.agents) for (const r of agentRecords(a, cfg.chain)) out(`  ${a.label}.mergit.eth  ${r.key.length > 40 ? r.key.slice(0, 22) + "..." + r.key.slice(-8) : r.key} = ${(() => { const v = r.value.replace(/\n+/g, " "); return v.length > 50 ? v.slice(0, 47) + "..." : v; })()}`);
}

function printResult(result: OneShotResult, rows: Awaited<ReturnType<typeof verifyOneShot>>) {
  out(`\nResolver: ${result.resolver}`);
  out("Steps:");
  for (const s of result.steps) out(`  ${s.step.padEnd(42)} gas ${s.gasUsed}  tx ${s.hash}`);
  out(`  total gas: ${result.steps.reduce((a, s) => a + s.gasUsed, 0n)}`);
  out("\nRead back through the ENSv2 Universal Resolver:");
  for (const r of rows) out(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}  ${r.key.length > 40 ? r.key.slice(0, 22) + "..." : r.key}${r.ok ? "" : `  got ${JSON.stringify(r.got)}`}`);
  if (rows.some((r) => !r.ok)) fail("\nVerification failed: not every record reads back.");
}

try {
  if (mode === "fork") {
    const fork = await startFork();
    try {
      const owner = await readOwner(fork.pub);
      await impersonate(fork, owner);
      await printPlan(fork.pub, owner, cfg.agents.length * 3);
      out("\nFORK RUN: a local copy of mainnet, the owner is impersonated, nothing is sent to mainnet.");
      const result = await runOneShot({ pub: fork.pub, wallet: fork.wallet(owner), owner }, cfg);
      printResult(result, await verifyOneShot(fork.pub, cfg, result.resolver));
    } finally { await fork.stop(); }
  } else {
    const pub = createPublicClient({ chain: mainnet, transport: http(rpc) }) as PublicClient;
    const owner = await readOwner(pub);
    await printPlan(pub, owner, cfg.agents.length * 3);
    try { await assertNotAlreadyConfigured(pub, cfg); } catch (e) { out(`\nWARNING: ${(e as Error).message}`); }
    const gasPrice = await pub.getGasPrice();
    const need = ESTIMATED_UNITS * gasPrice * HEADROOM;
    out(`\nEstimated gas: ${ESTIMATED_UNITS} units at ${Number(gasPrice) / 1e9} gwei = ${formatEther(ESTIMATED_UNITS * gasPrice)} ETH; the balance check requires ${formatEther(need)} ETH (${HEADROOM}x headroom).`);
    out(`Owner ETH balance: ${formatEther(await pub.getBalance({ address: owner }))}`);
    if (args!.mode === "mainnet-plan") {
      out("\nPLAN ONLY: nothing was sent. Add --execute (with ENS_OWNER_PRIVATE_KEY in the environment) to send these transactions for real.");
    } else {
      const account = privateKeyToAccount(args!.mode === "mainnet-execute" ? args!.privateKey : "0x");
      if (account.address !== owner) fail(`Refusing: the key in ENS_OWNER_PRIVATE_KEY belongs to ${account.address}, not to the owner of mergit.eth (${owner}).`);
      const balance = await pub.getBalance({ address: owner });
      if (balance < need) fail(`Refusing: the owner holds ${formatEther(balance)} ETH but the one-shot needs about ${formatEther(need)} ETH at current gas.`);
      out("\nEXECUTING ON MAINNET.");
      const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpc) });
      const result = await runOneShot({ pub, wallet, owner }, cfg);
      printResult(result, await verifyOneShot(pub, cfg, result.resolver));
    }
  }
} catch (e) { fail((e as Error).message); }
