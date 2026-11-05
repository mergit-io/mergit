import { useRef, useState } from "react";
import {
  CredentialRequest,
  IDKitErrorCodes,
  IDKitRequestWidget,
  selfieCheck,
  type IDKitResult,
} from "@worldcoin/idkit";
import { startTrial } from "../auth/accountApi";
import { fetchRpContext, type IdkitConfig } from "./api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The World ID button for the free trial's one-human check (`config`, from `/v0/world/config`'s `idkit`):
 * rendered only once that check is configured and usable -- `FundingChoice` (and `VerifyForCredits`) mount
 * this only when `config.rp_id` is present, which `/v0/world/config` sends whenever IDKit is configured.
 *
 * A fresh RP context is signed server-side (`POST /v0/world/rp-context`) right as the button is pressed,
 * not held in state from an earlier mount: it carries a short (five-minute) expiry and is meant for one
 * attempt. The server returns it as `{sig, nonce, created_at, expires_at}`; `@worldcoin/idkit@4.6.0`'s
 * `RpContext` wants the signature as `signature` and its own `rp_id` too, so both are filled in here.
 * `environment` is the server's `world_environment`, also from `/v0/world/config`: IDKit would otherwise
 * ask World App for a production proof, which a staging or sandbox server refuses (`wrong_environment`).
 *
 * `handleVerify` is IDKit's own "check this with your backend before closing the widget" hook -- it *is*
 * the `POST /v0/account/trial` call, so a rejected or already-claimed proof shows as a failed check, not
 * as a second request after the modal already closed successfully. IDKit swallows whatever `handleVerify`
 * throws and reports only `onError("failed_by_host_app")`, so the message Mergit's server gave (e.g. "the
 * free credits were already used by this person") is kept aside in `hostError` and shown instead.
 *
 * Only World ID 4.0 proofs are asked for, because the server accepts nothing else (a 3.0 proof's
 * nullifier differs from the same human's 4.0 one). IDKit's `proofOfHuman()` preset forces
 * `allow_legacy_proofs` back on whatever the widget is told (`compileRequest` in idkit-core), so the
 * Orb case asks for the `proof_of_human` credential directly; `selfieCheck()` is 4.0-only already.
 */
export function TrialVerify({
  config,
  label,
  disabled,
  onStart,
  onCancelled,
  onVerified,
  onError,
}: {
  config: IdkitConfig & { rp_id: string };
  label: string;
  disabled: boolean;
  /** The button was pressed and a fresh RP context is being asked for -- the parent's cue to show "busy"
   * the same way it would for the plain button's own click, before anything else has happened. */
  onStart: () => void;
  /** The widget closed without a proof ever being accepted (the person backed out, World App timed out, …).
   * Nothing was sent to the server; the plan choice dialog's other options must stay usable. */
  onCancelled: () => void;
  /** `POST /v0/account/trial` succeeded inside `handleVerify` and IDKit is closing the widget. */
  onVerified: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [done, setDone] = useState(false);
  // What `startTrial` said when it refused the proof: IDKit drops it on the floor (see above).
  const hostError = useRef<string | null>(null);
  const [rpContext, setRpContext] = useState<{
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  } | null>(null);

  const start = () => {
    onStart();
    setDone(false);
    setFetching(true);
    fetchRpContext(config.action)
      .then((ctx) => {
        setRpContext({
          rp_id: config.rp_id,
          nonce: ctx.nonce,
          created_at: ctx.created_at,
          expires_at: ctx.expires_at,
          signature: ctx.sig,
        });
        setOpen(true);
      })
      .catch((e: unknown) => {
        onError(message(e));
      })
      .finally(() => {
        setFetching(false);
      });
  };

  const handleVerify = async (result: IDKitResult) => {
    hostError.current = null;
    try {
      await startTrial(result);
    } catch (e) {
      hostError.current = message(e);
      throw e; // IDKit must still see the failure, or it would show (and report) a success
    }
  };

  const credential =
    config.preset === "proof_of_human"
      ? { constraints: CredentialRequest("proof_of_human") }
      : { preset: selfieCheck() };

  return (
    <>
      <button type="button" className="btn primary block" disabled={disabled || fetching} onClick={start}>
        {fetching ? "Starting…" : label}
      </button>
      {rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next && !done) onCancelled();
          }}
          app_id={config.app_id}
          action={config.action}
          rp_context={rpContext}
          allow_legacy_proofs={false}
          environment={config.environment ?? undefined}
          {...credential}
          handleVerify={handleVerify}
          onSuccess={() => {
            setDone(true);
            onVerified();
          }}
          onError={(errorCode) => {
            const fromMergit = errorCode === IDKitErrorCodes.FailedByHostApp ? hostError.current : null;
            onError(fromMergit ?? `World ID could not complete that check (${errorCode}).`);
          }}
        />
      )}
    </>
  );
}
