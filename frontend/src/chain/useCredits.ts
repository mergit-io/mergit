import { useCallback, useEffect, useState } from "react";
import { apiBase } from "./wallet";

export type Credits = {
  granted: bigint;
  spent: bigint;
  remaining: bigint;
  plansToday: number;
  /** The most one plan may cost when paid from credits, and how many plans a day; null from a gateway that does not say. */
  planCap: bigint | null;
  plansPerDay: number | null;
};

/**
 * The signed-in account's free credits, from Mergit's API (which asks the gateway for this account only). Credits
 * belong to the account, not to an address, so linking a wallet does not change them. `refresh` re-reads them, for
 * after a redeem code has been applied. Pass false while there is no session.
 */
export function useCredits(enabled: boolean) {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => {
    setRound((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(`${apiBase()}/v0/account/credits`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Free credits are unavailable right now.");
        const c = (await r.json()) as {
          granted_usdc_units: string;
          spent_usdc_units: string;
          remaining_usdc_units: string;
          plans_today: number;
          plan_cap_usdc_units?: string;
          plans_per_day?: number;
        };
        if (live) {
          setError(undefined);
          setCredits({
            granted: BigInt(c.granted_usdc_units),
            spent: BigInt(c.spent_usdc_units),
            remaining: BigInt(c.remaining_usdc_units),
            plansToday: c.plans_today,
            planCap: c.plan_cap_usdc_units === undefined ? null : BigInt(c.plan_cap_usdc_units),
            plansPerDay: c.plans_per_day ?? null,
          });
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [enabled, round]);
  return { credits, loading: !credits && !error, error, refresh };
}
