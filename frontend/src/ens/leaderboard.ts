import type { AgentInfo } from "../api/types";
import type { MirrorState } from "../chain/ens/agentEns.ts";
import type { Mirror } from "../chain/ens/mirror.ts";
import type { AgentEnsState } from "../chain/useAgentEns";

export type Counts = { auditedStaked: number; verifiedStaked: number };

export type BoardRow = {
  agentId: string;
  /** The roster name, which is also the ENS label. */
  name: string;
  ensName: string;
  /** "ok" when the mirror was read; otherwise why there are no counts (none published yet, unreadable, rejected). */
  mirror: MirrorState["status"];
  /** Null when the mirror is not "ok": no counts is not the same claim as zero counts. */
  counts: Counts | null;
  asOfBlock: number | null;
};

/**
 * Only a name linked to the agent both ways can speak for it. A failed link (the name does not attest to the agent, or
 * the agent's file names another name) may be someone else's record, so it is not listed. A link that holds with the
 * operator unconfirmed or changed keeps the publisher's record, so it counts, and its badge says what is open.
 */
function linkOf(s: AgentEnsState | undefined): { ensName: string; mirror: MirrorState } | null {
  if (s?.state !== "ready" || s.value.badge === "not-verified") return null;
  return { ensName: s.value.name, mirror: s.value.mirror };
}

function mirrorOf(s: AgentEnsState | undefined): Mirror | null {
  const link = linkOf(s);
  return link?.mirror.status === "ok" ? link.mirror.mirror : null;
}

/**
 * Leaderboard rows from the platform's roster (never by listing ENS, HLD 8.3 step 5) and each agent's mirror. Ordered
 * by verified count, then audited count, then name. Counts, not the value density the router uses, so the order can
 * differ from the router's. A linked agent with no readable mirror (the publisher writes one only once the agent has a
 * counted outcome) is still listed, without counts, after the counted ones; a chosen category lists only counted ones.
 */
export function boardRows(
  agents: AgentInfo[],
  states: Record<string, AgentEnsState>,
  category: string | null,
): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const a of agents) {
    const link = linkOf(states[a.agent_id]);
    if (!link) continue;
    const base = { agentId: a.agent_id, name: a.name, ensName: link.ensName, mirror: link.mirror.status };
    if (link.mirror.status !== "ok") {
      if (category === null) rows.push({ ...base, counts: null, asOfBlock: null });
      continue;
    }
    const m = link.mirror.mirror;
    const c = category === null ? m : m.byCategory.find((x) => x.category === category);
    if (!c) continue;
    rows.push({
      ...base,
      counts: { auditedStaked: c.auditedStaked, verifiedStaked: c.verifiedStaked },
      asOfBlock: m.asOfBlock,
    });
  }
  const NONE = -1; // below any count, so agents without counts come last
  return rows.sort(
    (x, y) =>
      (y.counts?.verifiedStaked ?? NONE) - (x.counts?.verifiedStaked ?? NONE) ||
      (y.counts?.auditedStaked ?? NONE) - (x.counts?.auditedStaked ?? NONE) ||
      x.name.localeCompare(y.name),
  );
}

/** Every category any counted mirror has, sorted, for the filter. */
export function boardCategories(states: Record<string, AgentEnsState>): string[] {
  const all = new Set<string>();
  for (const s of Object.values(states)) for (const c of mirrorOf(s)?.byCategory ?? []) all.add(c.category);
  return [...all].sort();
}

/** A category stored as `keccak256(label)` with no known label is a long hash: shortened for a table cell. */
export const categoryLabel = (c: string): string => (/^0x[0-9a-f]{64}$/i.test(c) ? `${c.slice(0, 10)}…` : c);
