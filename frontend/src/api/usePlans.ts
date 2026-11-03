import { useEffect, useState } from "react";
import { useAuth } from "../auth/context";
import { errorMessage, listPlans } from "./client";
import type { PlanSummary } from "./types";

/**
 * The signed-in requester's plans, newest first. Signed out, the dashboard still renders behind the Connect window,
 * and must not ask: the answer is a 401 that every signed-out visitor would see in their console.
 */
export function usePlans() {
  const { session } = useAuth();
  const signedIn = session !== null;
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    listPlans().then(
      (list) => {
        if (!active) return;
        // Anything but a list means this is not the plans service (a wrong address answering with a web page).
        if (Array.isArray(list)) setPlans(list);
        else setError("Mergit's API did not answer like the plans service. Check its address.");
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, [signedIn]);
  return { plans, error };
}
