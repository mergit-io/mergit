import { ApiError } from "../api/client";
import { getApprovalStatus, resolveApiUrl } from "./api";

/** The `human_approval_required` body a protected action's 428 carries (plan sec 1.7): everything the
 * browser needs to put a fresh World ID check in front of the human before the action it names is retried. */
export type ApprovalRequired = {
  approval_id: string;
  start_url: string;
  expires_at: string;
  summary: Record<string, unknown>;
};

const POLL_MS = 2000;

const notGiven = () => new ApiError(403, "World ID approval was not given — nothing was done.");
const blocked = () =>
  new ApiError(403, "Your browser blocked the World ID window. Allow popups for Mergit and try again.");

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
 * two seconds otherwise -- whichever answers first. Never outlives `expires_at`: once that passes, this
 * stops polling and treats the approval as denied, the same as the human saying no. */
function waitForOutcome(req: ApprovalRequired): Promise<"approved" | "denied"> {
  return new Promise((resolve) => {
    const expiresAt = Date.parse(req.expires_at);
    let settled = false;

    const finish = (outcome: "approved" | "denied") => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; approval_id?: unknown; status?: unknown } | null;
      if (!data || data.type !== "mergit-world-approval" || data.approval_id !== req.approval_id) return;
      finish(data.status === "approved" ? "approved" : "denied");
    };
    window.addEventListener("message", onMessage);

    const timer = window.setInterval(() => {
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        finish("denied");
        return;
      }
      void getApprovalStatus(req.approval_id).then(
        (s) => {
          if (s.status !== "pending") finish(s.status === "approved" ? "approved" : "denied");
        },
        () => undefined, // a missed poll is retried on the next tick
      );
    }, POLL_MS);
  });
}

/**
 * Runs a protected action, and when the API answers `human_approval_required` (plan sec 1.7), takes the
 * human through a fresh World ID check before retrying it once with the approval id attached.
 *
 * `confirm` renders the approval dialog and resolves once its own "Continue" button is clicked. The popup is
 * opened right here, in the very next step after that resolution -- nothing else is awaited in between -- so
 * it is still close enough to that click, as far as every major browser's popup blocker is concerned, to
 * count as the same user gesture. Opening it any later (after a network round trip, say) would be blocked.
 * A blocked popup (`window.open` returning `null`) is reported distinctly from a human saying no.
 */
export async function withHumanApproval<T>(
  run: (approvalId?: string) => Promise<T>,
  confirm: (req: ApprovalRequired) => Promise<boolean>,
): Promise<T> {
  let req: ApprovalRequired;
  try {
    return await run();
  } catch (error) {
    const required = approvalRequired(error);
    if (!required) throw error;
    req = required;
  }

  const ok = await confirm(req);
  if (!ok) throw notGiven();

  const popup = window.open(resolveApiUrl(req.start_url), "mergit-world-approval", "width=480,height=760");
  if (!popup) throw blocked();

  const outcome = await waitForOutcome(req);
  if (outcome !== "approved") throw notGiven();

  return run(req.approval_id);
}
