import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { mainnet } from "viem/chains";
import { readGate, type GateClient, type GateReport } from "./gate.ts";

const rpc = process.env.ENS_MAINNET_RPC;
if (!rpc) {
  console.error("gate: set ENS_MAINNET_RPC to an Ethereum mainnet RPC URL");
  process.exit(1);
}
const name = process.argv[2] ?? "mergit.eth";

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const bal = (b: GateReport["balances"]["owner"]) => (b ? `${formatEther(b.ethWei)} ETH, ${formatUnits(b.usdc, 6)} USDC` : "n/a");

try {
  const client = createPublicClient({ chain: mainnet, transport: http(rpc) }) as unknown as GateClient;
  const r = await readGate(client, name);
  console.log(JSON.stringify(r, replacer, 2));
  console.log(`\n## Gate report: ${r.name}\n`);
  console.log(`- ENS generation: **${r.generation}**`);
  console.log(`- Owner: ${r.owner ?? "none"}`);
  console.log(`- Resolves to: ${r.resolvedAddress ?? "none"}`);
  console.log(`- Expires: ${r.expiresAt?.toISOString() ?? "n/a"}`);
  console.log(`- Owner balance: ${bal(r.balances.owner)}`);
  console.log(`- Resolved-address balance: ${bal(r.balances.resolvedAddress)}`);
  console.log(`- Gas price: ${Number(r.gasPriceWei) / 1e9} gwei; ETH/USD ${r.ethUsd.price} (updated ${r.ethUsd.updatedAt.toISOString()}${r.ethUsd.stale ? ", STALE" : ""})`);
  console.log(`\nFindings:\n${r.findings.length ? r.findings.map((f) => `- ${f}`).join("\n") : "- none"}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
