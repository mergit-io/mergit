import { useState } from "react";
import { IDKitRequestWidget, proofOfHuman, selfieCheck, type IDKitResult } from "@worldcoin/idkit";
import { startTrial } from "../auth/accountApi";
import { fetchRpContext, type IdkitConfig } from "./api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The "Start free" button once World ID's one-human free-trial check (`config`, from `/v0/world/config`'s
 * `idkit`) is both configured and *usable* -- `FundingChoice` only renders this when `config.rp_id` is
 * present (see below); otherwise it keeps rendering today's plain button and never mounts this at all.
 *
 * A fresh RP context is signed server-side (`POST /v0/world/rp-context`) right as the button is pressed,
 * not held in state from an earlier mount: it carries a short (five-minute) expiry and is meant for one
 * attempt. `handleVerify` is IDKit's own "check this with your backend before closing the widget" hook -- it
 * *is* the `POST /v0/account/trial` call, so a rejected or already-claimed proof shows inside IDKit's own
 * widget as a failed check, not as a second request after the modal already closed successfully.
 *
 * ## A real gap in today's backend contract (not fixed here -- no Python touched)
 *
 * `@worldcoin/idkit@4.6.0`'s `RpContext` requires `rp_id` (format `rp_<16 hex>`, checked by
 * `normalizeRpId` -- a missing or malformed one throws before the widget can open) and a field named
 * `signature`. `GET /v0/world/config` (Task 4) exposes only `enabled`/`app_id`/`action`/`preset`, and
 * `POST /v0/world/rp-context` (Task 4) returns `{sig, nonce, created_at, expires_at}` -- no `rp_id` anywhere,
 * and `sig` rather than `signature` (its own docstring's claim that this "matches IDKit's rp_context field
 * names exactly" does not hold for the installed 4.6.0 SDK). The `sig` → `signature` rename is harmless and
 * done below. `rp_id` has no source at all in the current contract, so `config.rp_id` is read defensively
 * (`world/api.ts`'s `parseIdkitConfig`) against a future response that adds it; until then this component is
 * simply never mounted, and the plain button is what every deployment sees. The fix is additive and
 * one-line (`"rp_id": settings.world_rp_id` in `routes_world.world_config`'s `idkit` dict) but is a backend
 * change, out of scope for this task.
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
          preset={config.preset === "proof_of_human" ? proofOfHuman() : selfieCheck()}
          handleVerify={(result: IDKitResult) => startTrial(result)}
          onSuccess={() => {
            setDone(true);
            onVerified();
          }}
          onError={(errorCode) => {
            onError(`World ID could not complete that check (${errorCode}).`);
          }}
        />
      )}
    </>
  );
}
