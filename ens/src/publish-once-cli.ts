import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, mainnet } from "viem/chains";
import { newOutcomeCache, publishPass } from "./publisher.ts";
import { loadWriterConfig, parsePublishOnceEnv, redact } from "./writer-env.ts";

// One publish pass, no daemon: reads Base Sepolia, compares with ENS and writes mergit.reputation / mergit.operator.
// Default is a DRY RUN (nothing is sent). Add --execute to send the transaction with the publisher key.
//   node src/publish-once-cli.ts            dry run
//   node src/publish-once-cli.ts --execute  send it
let secrets: string[] = [];
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const unknown = args.filter((a) => a !== "--execute" && a !== "--dry-run");
if (unknown.length) { console.error(`unknown option ${unknown[0]}. usage: node src/publish-once-cli.ts [--dry-run | --execute]`); process.exit(1); }

try {
  const env = parsePublishOnceEnv(process.env);
  secrets = [env.ensRpc, env.baseRpc, env.publisherKey];
  const cfg = loadWriterConfig(env.configPath);
  const base = createPublicClient({ chain: baseSepolia, transport: http(env.baseRpc) }) as PublicClient;
  const ens = createPublicClient({ chain: mainnet, transport: http(env.ensRpc) }) as PublicClient;
  const account = privateKeyToAccount(env.publisherKey);
  console.log(`publisher account: ${account.address}`);
  if (execute) console.log(`publisher balance: ${(Number(await ens.getBalance({ address: account.address })) / 1e18).toString()} ETH`);
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(env.ensRpc) });
  const r = await publishPass({ base, ens, wallet }, { ...cfg, dryRun: !execute }, newOutcomeCache(cfg.fromBlock));
  console.log(`Base block read up to: ${r.asOfBlock}`);
  if (r.changed.length === 0) console.log("Nothing to write: ENS already matches Base.");
  for (const c of r.changed) console.log(`${execute ? "wrote" : "would write"}: ${c.label}.mergit.eth  ${c.key}`);
  if (!execute && r.changed.length) console.log("\nDRY RUN: nothing was sent. Run again with --execute to send it.");
  if (r.hash) console.log(`transaction: ${r.hash}`);
} catch (e) {
  console.error(redact((e as Error).message, secrets));
  process.exit(1);
}
