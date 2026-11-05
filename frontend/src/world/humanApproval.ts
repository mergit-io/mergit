import { ApiError } from "../api/client";
import { getApprovalStatus } from "./api";
import { worldApprovalMessage } from "./reasons";

/** The `human_approval_required` body a protected action's 428 carries (plan sec 1.7): everything the
 * browser needs to put a fresh World ID check in front of the human before the action it names is retried. */
export type ApprovalRequired = {
  approval_id: string;
  start_url: string;
  expires_at: string;
  summary: Record<string, unknown>;
};

/** What `confirm` resolves to once the dialog's own button has been clicked. The dialog itself opens the
 * popup -- synchronously, inside that click -- and hands the result back here rather than this module
 * reconstructing it after an `await`: a browser's popup blocker only reliably honors `window.open` called
 * directly inside the gesture's own handler, not a later continuation (Safari in particular does not extend
 * the same leeway Chrome and Firefox give a same-tick promise resolution).
 *
 * `cancelled`, when given, is how the page stops waiting: the dialog stays up after "Continue" with its own
 * Cancel button, and aborting this signal gives up on the approval -- the action is not run. Without it the
 * only ways out of the wait would be World answering or `expires_at` (five minutes) passing, which is how a
 * closed popup used to leave the page on "Working…" for that long. */
export type ApprovalOutcome = { approved: false } | { approved: true; popup: Window | null; cancelled?: AbortSignal };

/** How the wait for the popup ended. `reason` is the API's own code (`different_human`, `world_unreachable`,
 * ...) whenever it gave one, so the person is told which it was (`reasons.ts`). */
type WaitResult = { status: "approved" } | { status: string; reason: string | null };

const POLL_MS = 2000;
/** How often to look at `popup.closed`. Only ever a hint to poll right away, never a verdict (see below). */
const CLOSED_CHECK_MS = 500;

const notGiven = () => new ApiError(403, "World ID approval was not given — nothing was done.");
const blocked = () =>
  new ApiError(403, "Your browser blocked the World ID window. Allow popups for Mergit and try again.");
/** A `failed` check (World unreachable, the sign-in never finished) is "try again", not a refusal: a 503,
 * the class plan sec 1.8 gives it. Everything else that is not `approved` is a 403. */
const ended = (status: string, reason: string | null) =>
  new ApiError(status === "failed" ? 503 : 403, worldApprovalMessage(status, reason), [], { status, reason });

/** Picks the `human_approval_required` shape out of a failed call's error, or `null` when this was some
 * other failure (a different 428, or not a 428 at all): only `ApiError` carries the parsed `detail` this
 * needs, and only a 428 from a World-gated action looks like this. */
export function approvalRequired(error: unknown): ApprovalRequired | null {
  if (!(error instanceof ApiError) || error.status !== 428) return null;
  const detail = error.detail;
  if (!detail || typeof detail !== "object") return null;
  const { code, approval_id, start_url, expires_at, summary } = detail as Record<string, unknown>;
  if (
    code !== "human_approval_required" ||
    typeof approval_id !== "string" ||
    typeof start_url !== "string" ||
    typeof expires_at !== "string"
  ) {
    return null;
  }
  return {
    approval_id,
    start_url,
    expires_at,
    summary: summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {},
  };
}

/** Waits for the approval the popup is handling to leave `pending`: a `postMessage` from the popup's own
 * page (same origin, plan sec 1.7) if it can still reach its opener, or a poll of the status endpoint every
 * two seconds otherwise -- whichever answers first. Ends early, as `cancelled`, when `cancelled` aborts.
 * Never outlives `expires_at`: once that passes, this stops polling and gives up, as `expired`.
 *
 * A popup reading `closed` is deliberately *not* treated as the end. A page World serves with a
 * Cross-Origin-Opener-Policy header severs the opener's handle, and `closed` then reads `true` while the
 * window is still open and the human is mid-check. So a closed popup only triggers one poll straight away
 * (it may have closed because it just finished); giving up is the person's call, with the Cancel button. */
function waitForOutcome(req: ApprovalRequired, popup: Window, cancelled?: AbortSignal): Promise<WaitResult> {
  return new Promise((resolve) => {
    const expiresAt = Date.parse(req.expires_at);
    let settled = false;
    let closedSeen = false;

    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      window.clearInterval(closedTimer);
      cancelled?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const poll = () =>
      Promise.resolve()
        .then(() => getApprovalStatus(req.approval_id))
        .then(
          (s) => {
            if (s.status === "approved") finish({ status: "approved" });
            else if (s.status !== "pending") finish({ status: s.status, reason: s.reason });
          },
          () => undefined, // a missed poll is retried on the next tick
        );

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; approval_id?: unknown; status?: unknown } | null;
      if (!data || data.type !== "mergit-world-approval" || data.approval_id !== req.approval_id) return;
      if (data.status === "approved") {
        finish({ status: "approved" });
        return;
      }
      // The popup's page only knows the status; the reason is on the approval itself. Ask once for it, and
      // say what is known if that ask fails -- the approval is not usable either way.
      const status = typeof data.status === "string" ? data.status : "denied";
      void Promise.resolve()
        .then(() => getApprovalStatus(req.approval_id))
        .then(
          (s) => {
            if (s.status === "approved") finish({ status: "approved" });
            else finish(s.status === "pending" ? { status, reason: null } : { status: s.status, reason: s.reason });
          },
          () => {
            finish({ status, reason: null });
          },
        );
    };

    const onAbort = () => {
      finish({ status: "cancelled", reason: "cancelled" });
      try {
        popup.close(); // ours to close; a no-op if World's page already severed the handle
      } catch {
        // nothing to do: the window is gone or no longer reachable from here
      }
    };

    window.addEventListener("message", onMessage);
    cancelled?.addEventListener("abort", onAbort);

    const timer = window.setInterval(() => {
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        finish({ status: "expired", reason: "expired" });
        return;
      }
      void poll();
    }, POLL_MS);

    const readsClosed = () => {
      try {
        return popup.closed;
      } catch {
        return false; // some browsers throw on a severed handle; that says nothing either way
      }
    };
    const closedTimer = window.setInterval(() => {
      if (readsClosed() && !closedSeen) {
        closedSeen = true;
        void poll();
      }
    }, CLOSED_CHECK_MS);

    if (cancelled?.aborted) onAbort();
  });
}

/**
 * Runs a protected action, and when the API answers `human_approval_required` (plan sec 1.7), takes the
 * human through a fresh World ID check before retrying it once with the approval id attached.
 *
 * `confirm` renders the approval dialog and resolves once one of its own buttons is clicked. Cancelling
 * resolves `{approved: false}` with no popup ever attempted. Approving opens the popup *inside that same
 * click* (the dialog's job, not this function's -- see `ApprovalOutcome`) and resolves with whatever
 * `window.open` returned, `null` included: this function never calls `window.open` itself, so it never has
 * to reconstruct, after an `await`, a result a real click already produced.
 *
 * `onWaitEnd` runs once the wait for World is over, however it ended, before the action is retried: the
 * caller's cue to take down its "Waiting for World ID…" state.
 */
export async function withHumanApproval<T>(
  run: (approvalId?: string) => Promise<T>,
  confirm: (req: ApprovalRequired) => Promise<ApprovalOutcome>,
  onWaitEnd?: () => void,
): Promise<T> {
  let req: ApprovalRequired;
  try {
    return await run();
  } catch (error) {
    const required = approvalRequired(error);
    if (!required) throw error;
    req = required;
  }

  const outcome = await confirm(req);
  if (!outcome.approved) throw notGiven();
  if (!outcome.popup) throw blocked();

  let result: WaitResult;
  try {
    result = await waitForOutcome(req, outcome.popup, outcome.cancelled);
  } finally {
    onWaitEnd?.();
  }
  if (result.status !== "approved") throw ended(result.status, "reason" in result ? result.reason : null);

  return run(req.approval_id);
}
