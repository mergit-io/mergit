import { useEffect, useState } from "react";
import { errorMessage, getCandidates } from "./client";
import type { TaskCandidates } from "./types";

/**
 * Ranked candidates per task for one plan (plan task O7/O8), fetched once on mount for the "Let Mergit
 * route" picker. A requester can still pick agents manually if this fails, so a failure is reported but
 * never thrown: the draft editor just shows a degraded (picks-only) task card.
 */
export function useCandidates(planUuid: string) {
  const [byIndex, setByIndex] = useState<Map<number, TaskCandidates> | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    getCandidates(planUuid).then(
      (res) => {
        if (active) setByIndex(new Map(res.tasks.map((t) => [t.index, t])));
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, [planUuid]);
  return { byIndex, error };
}
