import { keccak256, toHex, type Address, type Hex } from "viem";

export type Outcome = {
  taskId: Hex; agentId: bigint; category: Hex; success: boolean; costMicros: bigint; tier: number; source: number; blockNumber: bigint; logIndex: number;
};
type Split = { auditedStaked: number; verifiedStaked: number };
export type Counts = Split & { byCategory: Map<Hex, Split> };

const NOTE = "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth.";

/** One task has at most one counted outcome: the higher `source` wins (a challenge ruling over an audit verdict), then the later log. */
const beats = (a: Outcome, b: Outcome): boolean =>
  a.source !== b.source ? a.source > b.source : a.blockNumber !== b.blockNumber ? a.blockNumber > b.blockNumber : a.logIndex > b.logIndex;

/**
 * Counts per agent from `OutcomeRecorded` events. Only tier 0 (staked) counts (invariant 6). Each task counts once with its
 * winning outcome. `auditedStaked` is the number of counted tasks, `verifiedStaked` those that succeeded. The result does not
 * depend on the order of the input.
 */
export function foldOutcomes(outcomes: Outcome[]): Map<bigint, Counts> {
  const winner = new Map<string, Outcome>();
  for (const o of outcomes) {
    const key = o.taskId.toLowerCase();
    const cur = winner.get(key);
    if (!cur || beats(o, cur)) winner.set(key, o);
  }
  const out = new Map<bigint, Counts>();
  for (const o of winner.values()) {
    if (o.tier !== 0) continue;
    let c = out.get(o.agentId);
    if (!c) out.set(o.agentId, (c = { auditedStaked: 0, verifiedStaked: 0, byCategory: new Map() }));
    const cat = o.category.toLowerCase() as Hex;
    const s = c.byCategory.get(cat) ?? { auditedStaked: 0, verifiedStaked: 0 };
    c.byCategory.set(cat, s);
    for (const t of [c, s]) { t.auditedStaked += 1; if (o.success) t.verifiedStaked += 1; }
  }
  return out;
}

/** Categories are stored on chain as keccak256(label) and cannot be decoded: show a label only if it is in the known list. */
export function categoryLabel(category: Hex, known: string[]): string {
  const want = category.toLowerCase();
  return known.find((l) => keccak256(toHex(l)).toLowerCase() === want) ?? want;
}

/** The `mergit.reputation` text record (HLD 6.3): compact JSON with a fixed key order and sorted categories, so equal state gives an equal string. */
export function reputationRecord(counts: Counts, meta: { chainId: number; contract: Address; asOfBlock: bigint }, known: string[]): string {
  const byLabel = new Map<string, Split>();
  for (const [cat, s] of counts.byCategory) byLabel.set(categoryLabel(cat, known), s);
  const byCategory: Record<string, Split> = {};
  for (const label of [...byLabel.keys()].sort()) byCategory[label] = { auditedStaked: byLabel.get(label)!.auditedStaked, verifiedStaked: byLabel.get(label)!.verifiedStaked };
  return JSON.stringify({
    v: 0, mirror: true, source: { chainId: meta.chainId, contract: meta.contract }, asOfBlock: Number(meta.asOfBlock),
    auditedStaked: counts.auditedStaked, verifiedStaked: counts.verifiedStaked, byCategory, note: NOTE,
  });
}
