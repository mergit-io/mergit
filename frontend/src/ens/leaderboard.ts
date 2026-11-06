import type { AgentInfo } from "../api/types";
import type { Mirror } from "../chain/ens/mirror.ts";
import type { AgentEnsState } from "../chain/useAgentEns";

export type Counts = { auditedStaked: number; verifiedStaked: number };

export type BoardRow = {
  agentId: string;
  /** The roster name, which is also the ENS label. */
  name: string;
  ensName: string;
  counts: Counts;
  asOfBlock: number;
};

/**
 * Only a name linked to the agent both ways can speak for it. A failed link (the name does not attest to the agent, or
 * the agent's file names another name) may be someone else's record, so its mirror is not counted. A link that holds
 * with the operator unconfirmed or changed keeps the publisher's record, so it counts, and its badge says what is open.
 */
function mirrorOf(s: AgentEnsState | undefined): { ensName: string; mirror: Mirror } | null {
  if (s?.state !== "ready" || s.value.badge === "not-verified" || s.value.mirror.status !== "ok") return null;
  return { ensName: s.value.name, mirror: s.value.mirror.mirror };
}

/**
 * Leaderboard rows from the platform's roster (never by listing ENS, HLD 8.3 step 5) and each agent's mirror. Ordered
 * by verified count, then audited count, then name. Counts, not the value density the router uses, so the order can
 * differ from the router's.
 */
export function boardRows(
  agents: AgentInfo[],
  states: Record<string, AgentEnsState>,
  category: string | null,
): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const a of agents) {
    const got = mirrorOf(states[a.agent_id]);
    if (!got) continue;
    const c = category === null ? got.mirror : got.mirror.byCategory.find((x) => x.category === category);
    if (!c) continue;
    rows.push({
      agentId: a.agent_id,
      name: a.name,
      ensName: got.ensName,
      counts: { auditedStaked: c.auditedStaked, verifiedStaked: c.verifiedStaked },
      asOfBlock: got.mirror.asOfBlock,
    });
  }
  return rows.sort(
    (x, y) =>
      y.counts.verifiedStaked - x.counts.verifiedStaked ||
      y.counts.auditedStaked - x.counts.auditedStaked ||
      x.name.localeCompare(y.name),
  );
}

/** Every category any counted mirror has, sorted, for the filter. */
export function boardCategories(states: Record<string, AgentEnsState>): string[] {
  const all = new Set<string>();
  for (const s of Object.values(states)) for (const c of mirrorOf(s)?.mirror.byCategory ?? []) all.add(c.category);
  return [...all].sort();
}

/** A category stored as `keccak256(label)` with no known label is a long hash: shortened for a table cell. */
export const categoryLabel = (c: string): string => (/^0x[0-9a-f]{64}$/i.test(c) ? `${c.slice(0, 10)}…` : c);
