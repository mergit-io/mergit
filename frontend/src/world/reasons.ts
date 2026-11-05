/**
 * What a World ID approval's `reason` means, in words the person can act on (plan sec 1.7/1.8). The API
 * gives a short stable code -- on the polled approval (`GET /v0/world/approvals/{id}`) when the check was
 * denied or failed, and on a `403 human_approval_invalid` when a finished approval could not be used -- and
 * a person should see which one it was, not one generic "approval was not given" for all of them:
 * "that is not the World ID linked to your account" and "World is down, try again" need different actions.
 *
 * No imports on purpose: `api/client.ts` uses this, and `world/humanApproval.ts` imports `api/client.ts`.
 */

const NOTHING_DONE = "Nothing was done.";
const TRY_AGAIN = "Nothing was done — try again.";
const TRY_LATER = "Nothing was done — try again in a moment.";

/** `[what happened, what to do]` per reason code. Codes not listed here still reach the person, verbatim. */
const REASONS: Record<string, readonly [string, string]> = {
  // Denied at the callback (`world/approvals.py` `record`): the token was genuine, the check was not passed.
  access_denied: ["You cancelled at World ID.", NOTHING_DONE],
  different_human: ["That World ID is not the one linked to your Mergit account.", NOTHING_DONE],
  linked_to_another_account: ["That World ID is already linked to a different Mergit account.", NOTHING_DONE],
  stale_auth_time: [
    "World ID did not sign you in fresh for this approval. Sign in again at World, not from a saved session.",
    TRY_AGAIN,
  ],
  missing_pop: ["World ID did not confirm you were present for this check.", TRY_AGAIN],
  acr_not_allowed: ["World ID did not report a verification Mergit accepts (Orb or Selfie Check).", NOTHING_DONE],
  nonce_mismatch: ["World ID answered for a different sign-in than this one.", TRY_AGAIN],
  replayed_jti: ["That World ID sign-in was already used for another approval.", TRY_AGAIN],
  // Failed at the callback: World itself could not be reached or did not finish (fail closed, plan sec 1.8).
  world_unreachable: ["World ID is unreachable right now.", TRY_LATER],
  jwks_unreachable: ["World ID is unreachable right now.", TRY_LATER],
  code_exchange_failed: ["World ID did not finish the sign-in.", TRY_AGAIN],
  no_code: ["World ID did not finish the sign-in.", TRY_AGAIN],
  // A finished approval that the protected action refused (`403 human_approval_invalid`).
  expired: ["The World ID approval expired before it was used.", TRY_AGAIN],
  used: ["That World ID approval was already used.", TRY_AGAIN],
  action_mismatch: [
    "What you approved with World ID changed after you approved it. Approve what is on screen now.",
    TRY_AGAIN,
  ],
  not_yours: ["That World ID approval belongs to a different request.", TRY_AGAIN],
  denied: ["World ID approval was not given.", NOTHING_DONE],
  failed: ["The World ID check did not finish.", TRY_AGAIN],
  // Only on this page: the person pressed Cancel while the World ID window was still open.
  cancelled: ["You cancelled the World ID check.", NOTHING_DONE],
};

/** The message for a World ID check that did not end in `approved`. `status` is the approval's own
 * (`denied`, `failed`, ...) and decides the wording when `reason` is missing or not one this page knows. */
export function worldApprovalMessage(status: string, reason: string | null | undefined): string {
  const known = reason ? REASONS[reason] : undefined;
  if (known) return `${known[0]} ${known[1]}`;
  const code = reason ? ` (${reason})` : "";
  if (status === "failed") return `World ID could not finish the check${code}. ${TRY_AGAIN}`;
  return `World ID approval was not given${code}. ${NOTHING_DONE}`;
}

/** The message for an API error body `{code: "human_approval_invalid", reason}`, or `null` for any other
 * body. Without this a 403 here reads as the generic 403 ("Only the requester who created this plan can do
 * that."), which is false: the requester is the one asking, it is the World ID approval that was refused. */
export function invalidApprovalMessage(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const { code, reason } = detail as { code?: unknown; reason?: unknown };
  if (code !== "human_approval_invalid") return null;
  return worldApprovalMessage("denied", typeof reason === "string" ? reason : null);
}

/** Why `/v0/account/trial` refused a World ID proof (`auth.py` `start_trial`'s `idkit.ProofRejected.reason`,
 * forwarded as `403 {code: "world_proof_rejected", reason}`). A different vocabulary from `REASONS` above:
 * this one is World's own verify-API response, not an Agent Pass approval outcome. */
const PROOF_REASONS: Record<string, string> = {
  world_rejected: "World ID could not verify that proof.",
  wrong_environment: "That proof was made for a different World ID environment.",
  wrong_action: "That proof was for a different action.",
  sybil_score: "World ID flagged that as not a unique human.",
  world_unreachable: "World ID is unreachable right now.",
  malformed_proof: "That proof was not in a shape World ID recognizes.",
  legacy_proof: "That was a World ID 3.0 proof, and Mergit only accepts World ID 4.0. Update World App first.",
  wrong_credential: "World ID verified a different kind of check than the one Mergit asks for.",
};

/** The `detail` of the 428 both `/v0/account/trial` and a credits-funded `/v0/plans/{id}/approve` answer
 * when this account has not yet proved, with World ID, the human behind it (`auth.py` `start_trial`,
 * `routes_plans.py` `approve_plan`). A bare string, unlike Agent Pass's `human_approval_required` object. */
export const WORLD_PROOF_REQUIRED = "world_proof_required";

/** The message for a `world_proof_required` body, or `null` for any other: without this the person reads
 * the raw code, or worse (before the server sent it) a false "the free credits were already used". */
export function worldProofRequiredMessage(detail: unknown): string | null {
  if (detail !== WORLD_PROOF_REQUIRED) return null;
  return "Free credits need a one-time World ID check on this account first. Nothing was approved.";
}

/** The message for a rejected World ID proof. `reason` codes not listed here still reach the person,
 * parenthesized, rather than disappearing behind one generic sentence. */
export function worldProofRejectedMessage(reason: string | null | undefined): string {
  const known = reason ? PROOF_REASONS[reason] : undefined;
  if (known) return `${known} Try again in a moment.`;
  return `World ID rejected that proof${reason ? ` (${reason})` : ""}. Try again in a moment.`;
}
