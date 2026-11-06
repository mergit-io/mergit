import type { ArkivDecision } from "../../../api/types";

/**
 * The decisions of the most recent explore draw on a plan, in task order, and how many older ones Arkiv also holds.
 *
 * Every explore call is a new draw and stays on Arkiv until it expires, so a plan collects several. Comparing all of
 * them with the picks on screen marked every older draw "does not match", which reads as tampering when it is only
 * history. One draw's rows are written in one Postgres transaction, so they share one `decided_at`: the latest value
 * is the latest draw.
 */
export function latestDraw(decisions: ArkivDecision[]): { latest: ArkivDecision[]; earlier: number } {
  const newest = decisions.reduce<string | undefined>(
    (max, d) => (max === undefined || d.decided_at > max ? d.decided_at : max),
    undefined,
  );
  if (newest === undefined) return { latest: [], earlier: 0 };
  const latest = decisions.filter((d) => d.decided_at === newest).sort((a, b) => a.task_index - b.task_index);
  return { latest, earlier: decisions.length - latest.length };
}
