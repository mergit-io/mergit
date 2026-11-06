import { useEffect, useState } from "react";
import { DATA_MODE, LIVE } from "../config/live";
import { loadLedger, type LedgerState } from "./ens/ledger.ts";
import { fetchTextSafely } from "./ens/safeFetch.ts";
import { liveEnsClients } from "./liveEns";

export type LedgerHookState = { state: "loading" } | { state: "off" } | { state: "ready"; value: LedgerState };

/**
 * The final ledger committed in `mergit.ledger` on `mergit.eth`, with its file fetched through the guarded fetch and
 * its hash checked (chain/ens/ledger.ts). Display data only (E11). Live mode only: elsewhere nothing is fetched.
 */
export function useLedger(): LedgerHookState {
  const live = DATA_MODE === "live";
  const [value, setValue] = useState<LedgerState | null>(null);

  useEffect(() => {
    if (!live) return;
    let active = true;
    const ens = liveEnsClients().ens;
    loadLedger(
      {
        getEnsText: (args) => ens.getEnsText(args),
        fetchText: (url) => fetchTextSafely(url, { what: "The ledger file" }),
      },
      { universalResolver: LIVE.ens.universalResolver, chainId: LIVE.chainId, anchor: LIVE.ens.anchor },
    ).then(
      (state) => {
        if (active) setValue(state);
      },
      () => {
        // loadLedger does not throw; this only guards against a bug turning into an unhandled rejection.
        if (active) setValue({ status: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [live]);

  if (!live) return { state: "off" };
  return value === null ? { state: "loading" } : { state: "ready", value };
}
