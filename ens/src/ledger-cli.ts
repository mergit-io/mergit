import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, mainnet } from "viem/chains";
import { parseLedgerArgs } from "./ledger-args.ts";
import { publishLedgerRecord } from "./ledger-publish.ts";
import { buildSnapshot, checkLedgerRecord, ledgerRecord, snapshotHash } from "./ledger-snapshot.ts";
import { fetchOutcomes, type LogClient } from "./outcome-source.ts";
import { loadWriterConfig, redact } from "./writer-env.ts";

// The final ledger: `snapshot` builds the file and the ENS record from Base Sepolia data (read-only);
// `publish` writes the record to mergit.eth on Ethereum mainnet (dry run unless --execute). See ens/RUNBOOK.md.
const identityAbi = parseAbi(["function operatorOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)"]);
let secrets: string[] = [];
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

try {
  const args = parseLedgerArgs(process.argv.slice(2), process.env);
  const cfg = loadWriterConfig(args.configPath);
  if (args.command === "snapshot") {
    secrets = [args.baseRpc];
    const base = createPublicClient({ chain: baseSepolia, transport: http(args.baseRpc) }) as PublicClient;
    const head = await base.getBlockNumber({ cacheTime: 0 });
    const depth = BigInt(cfg.confirmations ?? 5);
    const toBlock = head > depth ? head - depth : 0n;
    console.log(`reading Base Sepolia outcomes from block ${cfg.fromBlock} to ${toBlock} (head ${head}, ${depth} confirmations)...`);
    const outcomes = await fetchOutcomes(base as unknown as LogClient, cfg.chain.anchor, cfg.fromBlock, toBlock, { chunk: cfg.chunk });
    const agents = [];
    for (const a of cfg.agents) {
      const read = (functionName: "operatorOf" | "tokenURI") => base.readContract({ address: cfg.chain.identity, abi: identityAbi, functionName, args: [BigInt(a.agentId)] });
      agents.push({ agentId: a.agentId, operator: (await read("operatorOf")) as Address, metadataUri: (await read("tokenURI")) as string, label: a.label });
    }
    const text = buildSnapshot({
      chain: { id: cfg.chain.chainId, identity: cfg.chain.identity, anchor: cfg.chain.anchor }, range: { fromBlock: cfg.fromBlock, toBlock },
      agents, outcomes, knownCategories: cfg.knownCategories, createdAt: new Date().toISOString(),
      ...(args.commitmentsPath ? { commitments: readJson(args.commitmentsPath) } : {}), ...(args.termsPath ? { terms: readJson(args.termsPath) } : {}),
    });
    const name = `final-${toBlock}`;
    mkdirSync(args.outDir, { recursive: true });
    const file = join(args.outDir, `${name}.json`);
    writeFileSync(file, text);
    const hash = snapshotHash(text);
    const record = ledgerRecord({ chainId: cfg.chain.chainId, anchor: cfg.chain.anchor, identity: cfg.chain.identity, fromBlock: cfg.fromBlock, toBlock,
      outcomes: outcomes.length, agents: agents.length, hash, uri: `${args.uriBase}/${name}.json` });
    const recordFile = join(args.outDir, `${name}.record.json`);
    writeFileSync(recordFile, record + "\n");
    console.log(`\nsnapshot file: ${file}  (${text.length} bytes, ${outcomes.length} outcomes, ${agents.length} agents)`);
    console.log(`hash (keccak256 of the file): ${hash}`);
    console.log(`ENS record: ${record}`);
    console.log(`record file: ${recordFile}`);
    console.log(`\nNext: commit and deploy the site so ${args.uriBase}/${name}.json is live, then:\n  node src/ledger-cli.ts publish --record ${recordFile}            (dry run)\n  node src/ledger-cli.ts publish --record ${recordFile} --execute  (writes to mainnet)`);
  } else {
    secrets = [args.ensRpc, ...(args.execute ? [args.privateKey] : [])];
    const record = readFileSync(args.recordPath, "utf8").trim();
    checkLedgerRecord(record);
    const ens = createPublicClient({ chain: mainnet, transport: http(args.ensRpc) }) as PublicClient;
    const account = args.execute ? privateKeyToAccount(args.privateKey) : undefined;
    if (account) console.log(`publisher account: ${account.address}  balance: ${Number(await ens.getBalance({ address: account.address })) / 1e18} ETH`);
    const wallet = createWalletClient({ ...(account ? { account } : {}), chain: mainnet, transport: http(args.ensRpc) });
    const r = await publishLedgerRecord({ ens, wallet }, cfg.resolver, record, { dryRun: !args.execute });
    if (!r.changed) console.log("Nothing to write: mergit.ledger already holds this record.");
    else if (!args.execute) console.log(`DRY RUN: would write mergit.ledger on mergit.eth (resolver ${cfg.resolver}). Nothing was sent. Add --execute to send it.`);
    else console.log(`wrote mergit.ledger on mergit.eth. transaction: ${r.hash}`);
  }
} catch (e) {
  console.error(redact((e as Error).message, secrets));
  process.exit(1);
}
