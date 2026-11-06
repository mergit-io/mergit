import { parseAbiItem, type Address, type Hex } from "viem";
import type { Outcome } from "./reputation-mirror.ts";

export const outcomeRecordedEvent = parseAbiItem(
  "event OutcomeRecorded(bytes32 indexed taskId, uint256 indexed agentId, bytes32 category, bool success, uint256 costMicros, uint8 tier, uint8 source)",
);

/** The slice of viem's public client that `fetchOutcomes` uses, so a test can pass a stub. */
export type LogClient = {
  getLogs(args: { address: Address; event: typeof outcomeRecordedEvent; fromBlock: bigint; toBlock: bigint }): Promise<readonly unknown[]>;
};

// The public Base Sepolia RPC limits eth_getLogs to a 200-block range (measured 2026-11-06).
const DEFAULT_CHUNK = 200n;

function decode(raw: unknown): Outcome {
  const l = raw as { args?: Record<string, unknown>; blockNumber?: unknown; logIndex?: unknown };
  const a = l?.args;
  const ok = a && typeof a.taskId === "string" && typeof a.agentId === "bigint" && typeof a.category === "string"
    && typeof a.success === "boolean" && typeof a.tier === "number" && typeof a.source === "number"
    && typeof l.blockNumber === "bigint" && typeof l.logIndex === "number";
  if (!ok) throw new Error(`outcomes: malformed log at block ${String(l?.blockNumber)}`);
  return { taskId: a.taskId as Hex, agentId: a.agentId as bigint, category: a.category as Hex, success: a.success as boolean,
    tier: a.tier as number, source: a.source as number, blockNumber: l.blockNumber as bigint, logIndex: l.logIndex as number };
}

/** `OutcomeRecorded` events in [fromBlock, toBlock], fetched in chunks, ordered by block then log index. Any failing chunk rejects the whole call. */
export async function fetchOutcomes(client: LogClient, anchor: Address, fromBlock: bigint, toBlock: bigint, opts: { chunk?: bigint } = {}): Promise<Outcome[]> {
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  if (chunk <= 0n) throw new Error("outcomes: chunk must be positive");
  const out: Outcome[] = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n;
    let logs: readonly unknown[];
    try {
      logs = await client.getLogs({ address: anchor, event: outcomeRecordedEvent, fromBlock: from, toBlock: to });
    } catch (e) {
      throw new Error(`outcomes: logs for blocks ${from}-${to} failed: ${(e as Error).message}`, { cause: e });
    }
    for (const l of logs) out.push(decode(l));
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}
