import { formatUsdc } from "../chain/funding";
import type { AgentReputation } from "./types";

/** A share as a whole percent: 0.6724 is "67%". */
export const percent = (share: number): string => `${String(Math.round(share * 100))}%`;

/** Costs arrive as USDC base units (millionths), as fractions, so they are rounded before they are shown. */
export function usdc(micros: number): string {
  return formatUsdc(BigInt(Math.max(0, Math.round(micros))));
}

/** The agent's figures grouped by agent id, each agent's categories in the order the API gave them. */
export function byAgent(rows: AgentReputation[]): Map<string, AgentReputation[]> {
  const grouped = new Map<string, AgentReputation[]>();
  for (const row of rows) grouped.set(row.agent_id, [...(grouped.get(row.agent_id) ?? []), row]);
  return grouped;
}
