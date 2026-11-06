import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { permissionedResolverAbi } from "./abi/permissionedResolver.ts";
import { dnsName } from "./dns.ts";
import { fetchOutcomes, type LogClient } from "./outcome-source.ts";
import { foldOutcomes, reputationRecord, type Outcome } from "./reputation-mirror.ts";
import { ensNameOf } from "./registration.ts";
import { agentRegistrationKey } from "./ensip25.ts";
import { readTextRecord } from "./resolver-read.ts";

export type PublisherConfig = {
  chain: { chainId: number; identity: Address; anchor: Address };
  resolver: Address;
  agents: { label: string; agentId: number }[];
  knownCategories: string[];
  fromBlock: bigint;
  chunk?: bigint;
  /** Blocks behind the Base head that a pass reads up to (default 5), so a lagging RPC node cannot make the cache skip blocks for good. */
  confirmations?: number;
  /** Work out what would be written and return it without sending a transaction. */
  dryRun?: boolean;
};
/** Outcomes fetched so far and the next block to read, kept in memory by the service so later passes fetch only new blocks. */
export type OutcomeCache = { outcomes: Outcome[]; next: bigint };
export const newOutcomeCache = (fromBlock: bigint): OutcomeCache => ({ outcomes: [], next: fromBlock });

export type PassResult = { asOfBlock: bigint; changed: { label: string; key: string }[]; hash: Hex | null };

const identityAbi = parseAbi(["function operatorOf(uint256 agentId) view returns (address)"]);

/** The mirror's counts without the block it was read at, so a record is only rewritten when the counts change. */
function withoutBlock(record: string): string {
  try { const o = JSON.parse(record); delete o.asOfBlock; return JSON.stringify(o); } catch { return record; }
}

/**
 * One publish pass. Reads outcomes from Base, folds them, reads each agent's current operator, compares with what the resolver
 * already holds, and sends ONE multicall of `setText` for only the records that differ (so an unchanged state costs nothing).
 * It writes `mergit.reputation` (only for agents with counted outcomes) and `mergit.operator`, nothing else. Any read failing
 * fails the whole pass before anything is sent.
 */
export async function publishPass(ctx: { base: PublicClient; ens: PublicClient; wallet: WalletClient }, cfg: PublisherConfig, cache?: OutcomeCache): Promise<PassResult> {
  const names = cfg.agents.map((a) => ({ ...a, name: ensNameOf(a.label) }));
  let head: bigint;
  try { head = await ctx.base.getBlockNumber({ cacheTime: 0 }); } catch (e) { throw new Error(`publisher: Base head failed: ${(e as Error).message}`, { cause: e }); }
  const depth = BigInt(cfg.confirmations ?? 5);
  const asOfBlock = head > depth ? head - depth : 0n;

  // fail loudly on a misconfigured resolver or agent list, before reading history or sending anything
  let code: string | undefined;
  try { code = await ctx.ens.getCode({ address: cfg.resolver }); } catch (e) { throw new Error(`publisher: resolver code check failed: ${(e as Error).message}`, { cause: e }); }
  if (!code || code === "0x") throw new Error(`publisher: no contract code at resolver ${cfg.resolver}`);
  const read = async (name: string, key: string): Promise<string> => {
    try { return await readTextRecord(ctx.ens, cfg.resolver, name, key); } catch (e) { throw new Error(`publisher: ${(e as Error).message}`, { cause: e }); }
  };
  for (const a of names) {
    const regKey = agentRegistrationKey(cfg.chain.identity, cfg.chain.chainId, a.agentId);
    if (!(await read(a.name, regKey))) throw new Error(`publisher: ${a.name} has no ${regKey} record: wrong label or agent id in the config?`);
  }
  const fresh = await fetchOutcomes(ctx.base as unknown as LogClient, cfg.chain.anchor, cache ? cache.next : cfg.fromBlock, asOfBlock, { chunk: cfg.chunk });
  const all = cache ? [...cache.outcomes, ...fresh] : fresh;
  if (cache) { cache.outcomes = all; cache.next = asOfBlock + 1n; } // the fetch succeeded, so these blocks are never read again
  const counts = foldOutcomes(all);

  const desired: { label: string; name: string; key: string; value: string }[] = [];
  for (const a of names) {
    let operator: string;
    try { operator = (await ctx.base.readContract({ address: cfg.chain.identity, abi: identityAbi, functionName: "operatorOf", args: [BigInt(a.agentId)] })) as string; }
    catch (e) { throw new Error(`publisher: operatorOf(${a.agentId}) failed: ${(e as Error).message}`, { cause: e }); }
    const c = counts.get(BigInt(a.agentId));
    if (c) desired.push({ label: a.label, name: a.name, key: "mergit.reputation", value: reputationRecord(c, { chainId: cfg.chain.chainId, contract: cfg.chain.anchor, asOfBlock }, cfg.knownCategories) });
    desired.push({ label: a.label, name: a.name, key: "mergit.operator", value: getAddress(operator) });
  }

  const changed: typeof desired = [];
  for (const d of desired) {
    const now = await read(d.name, d.key); // "" only when the record is unset; any other failure fails the pass
    const same = d.key === "mergit.reputation" ? withoutBlock(now) === withoutBlock(d.value) : now.toLowerCase() === d.value.toLowerCase();
    if (!same) changed.push(d);
  }
  if (changed.length === 0) return { asOfBlock, changed: [], hash: null };

  if (cfg.dryRun) return { asOfBlock, changed: changed.map((d) => ({ label: d.label, key: d.key })), hash: null };
  const calls = changed.map((d) => encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dnsName(d.name), d.key, d.value] }));
  const hash = await ctx.wallet.writeContract({ address: cfg.resolver, abi: permissionedResolverAbi, functionName: "multicall", args: [calls] } as never);
  const receipt = await ctx.ens.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`publisher: transaction ${hash} reverted`);
  return { asOfBlock, changed: changed.map((d) => ({ label: d.label, key: d.key })), hash };
}
