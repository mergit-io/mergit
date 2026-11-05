import { useEffect, useState } from "react";
import { useAuth } from "../auth/context";
import { fetchWorldConfig, type IdkitConfig } from "./api";
import { TrialVerify } from "./TrialVerify";

/**
 * The World ID check, offered where a credits-funded approval was refused with `428 world_proof_required`
 * (`routes_plans.approve_plan`): the account has free credits to spend -- typically a trial started before
 * World ID was switched on -- but no World ID claim yet, and the plan choice dialog (`FundingChoice`) only
 * ever appears for accounts with no trial at all, so without this there would be no way to verify.
 *
 * It is the same check as the free trial's own (`TrialVerify`, posting the proof to `/v0/account/trial`),
 * which accepts a proof from an account whose trial is already running and keeps its original start date.
 * A person whose World ID another account already claimed is told so here, in the server's own words.
 */
export function VerifyForCredits({ onVerified }: { onVerified: () => void }) {
  const { refreshAccount } = useAuth();
  // undefined: still asking `/v0/world/config`; null: it could not be read.
  const [idkit, setIdkit] = useState<IdkitConfig | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchWorldConfig().then((config) => {
      if (!cancelled) setIdkit(config?.idkit ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (idkit === undefined) return null;
  if (!idkit?.enabled || idkit.rp_id === null) {
    return (
      <p className="small c3" role="status">
        The World ID check cannot be started from this page right now. Pay from your wallet instead, or reload and try
        again.
      </p>
    );
  }

  return (
    <div className="col g8">
      {error && (
        <p className="small cr" role="alert">
          {error}
        </p>
      )}
      <TrialVerify
        config={{ ...idkit, rp_id: idkit.rp_id }}
        label="Verify with World ID"
        disabled={busy}
        onStart={() => {
          setError(null);
          setBusy(true);
        }}
        onCancelled={() => {
          setBusy(false);
        }}
        onVerified={() => {
          void refreshAccount().finally(() => {
            setBusy(false);
            onVerified();
          });
        }}
        onError={(msg) => {
          setError(msg);
          setBusy(false);
        }}
      />
    </div>
  );
}
