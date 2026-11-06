import type { AgentReputation } from "../../api/types";

/**
 * The live leaderboard's order. It comes only from the platform's reputation (`GET /v0/agents/reputation`): value
 * density over validated outcomes. ENS data is display-only (HLD E11) and must never reach this module.
 */

export type RankedAgent = {
  agentId: string;
  name: string;
  /** The rows the figures were taken from: that category's row, or every counted category for "All". */
  categories: AgentReputation[];
  valueDensity: number;
  countedOutcomes: number;
};

/** A row is evidence only when outcomes were counted; a prior is configuration, not a record. */
const counts = (r: AgentReputation): boolean =>
  r.counted_outcomes > 0 && !r.basis.startsWith("prior") && Number.isFinite(r.value_density_per_usdc);

/** The mean of `pick` over the rows, each weighted by its counted outcomes; 0 when nothing was counted. */
export function weightedMean(rows: AgentReputation[], pick: (r: AgentReputation) => number): number {
  const total = rows.reduce((n, r) => n + r.counted_outcomes, 0);
  return total === 0 ? 0 : rows.reduce((s, r) => s + pick(r) * r.counted_outcomes, 0) / total;
}

/** Agents with validated outcomes, best value density first; ties go to more counted outcomes, then by name. */
export function rankAgents(rows: AgentReputation[], category: string): RankedAgent[] {
  const grouped = new Map<string, AgentReputation[]>();
  for (const r of rows) {
    if (!counts(r) || (category !== "All" && r.category !== category)) continue;
    grouped.set(r.agent_id, [...(grouped.get(r.agent_id) ?? []), r]);
  }
  const ranked = [...grouped].map(([agentId, categories]): RankedAgent => ({
    agentId,
    name: categories[0]?.name ?? agentId,
    categories,
    valueDensity: weightedMean(categories, (r) => r.value_density_per_usdc),
    countedOutcomes: categories.reduce((n, r) => n + r.counted_outcomes, 0),
  }));
  return ranked.sort(
    (a, b) =>
      b.valueDensity - a.valueDensity ||
      b.countedOutcomes - a.countedOutcomes ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
  );
}

/** The category filter: "All", then every category in which some agent has a counted record, alphabetically. */
export function categoriesOf(rows: AgentReputation[]): string[] {
  return ["All", ...[...new Set(rows.filter(counts).map((r) => r.category))].sort()];
}
