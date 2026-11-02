import { useEffect, useState } from "react";
import { errorMessage, getReputation } from "./client";
import type { ReputationResponse } from "./types";

/** What the platform has seen each agent do and cost, from validated outcomes only. */
export function useReputation() {
  const [reputation, setReputation] = useState<ReputationResponse | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    getReputation().then(
      (r) => {
        // Anything but the documented shape is not the reputation service answering.
        if (active && Array.isArray((r as Partial<ReputationResponse> | null)?.agents)) setReputation(r);
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return { reputation, error };
}
