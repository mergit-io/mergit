import type { AgentReputation } from "../../../api/types";

/**
 * Agents with a validated track record in a category, most validated first: the ones to reuse before anyone creates
 * a new agent (HLD 8.3). From the platform's reputation (validated, staked outcomes only), never from ENS.
 */
export function withTrackRecord(rows: AgentReputation[], category: string): AgentReputation[] {
  return rows
    .filter((r) => r.category === category && r.counted_outcomes > 0)
    .sort((a, b) => b.counted_outcomes - a.counted_outcomes || a.name.localeCompare(b.name));
}
