import { useCallback, useEffect, useRef, useState } from "react";
import { withHumanApproval, type ApprovalOutcome, type ApprovalRequired } from "./humanApproval";

/** What the page renders while a World ID check is in front of the human: the request it is about, and
 * whether "Continue" has been clicked (so the page is now waiting on the World ID window). */
export type ApprovalPrompt = { req: ApprovalRequired; waiting: boolean };

/**
 * The page side of a World ID approval (plan sec 1.7) for any protected action: `guard(run)` runs the action
 * through `withHumanApproval`, and `prompt` says what `HumanApprovalDialog` should show meanwhile.
 *
 * The dialog stays up after "Continue to World ID", as "Waiting for World ID…" with a Cancel button, until
 * World answers. Cancel then gives up on the approval and the action is not run. Before this, the dialog
 * closed on "Continue" and the page sat on "Working…" with no way out but World answering or the approval
 * expiring five minutes later -- which is what closing the popup without finishing left people with.
 */
export function useHumanApproval() {
  const [prompt, setPrompt] = useState<ApprovalPrompt | null>(null);
  const answer = useRef<((outcome: ApprovalOutcome) => void) | null>(null);
  const waiting = useRef<AbortController | null>(null);

  const confirm = useCallback(
    (req: ApprovalRequired) =>
      new Promise<ApprovalOutcome>((resolve) => {
        answer.current = resolve;
        setPrompt({ req, waiting: false });
      }),
    [],
  );

  const waitEnded = useCallback(() => {
    waiting.current = null;
    setPrompt(null);
  }, []);

  // Leaving the page mid-wait gives the approval up too, so nothing is left polling for a page that is gone.
  useEffect(
    () => () => {
      waiting.current?.abort();
    },
    [],
  );

  /** The dialog's "Continue": `popup` is what its own click's `window.open` returned, `null` if blocked. */
  const approve = useCallback((popup: Window | null) => {
    const resolve = answer.current;
    answer.current = null;
    if (!popup) {
      setPrompt(null);
      resolve?.({ approved: true, popup: null });
      return;
    }
    const controller = new AbortController();
    waiting.current = controller;
    setPrompt((current) => current && { ...current, waiting: true });
    resolve?.({ approved: true, popup, cancelled: controller.signal });
  }, []);

  /** The dialog's Cancel: before "Continue" nothing was started; after it, stop waiting on World. */
  const cancel = useCallback(() => {
    if (waiting.current) {
      waiting.current.abort(); // `withHumanApproval` then calls `waitEnded`, which closes the dialog
      return;
    }
    const resolve = answer.current;
    answer.current = null;
    setPrompt(null);
    resolve?.({ approved: false });
  }, []);

  const guard = useCallback(
    <T>(run: (approvalId?: string) => Promise<T>) => withHumanApproval(run, confirm, waitEnded),
    [confirm, waitEnded],
  );

  return { prompt, guard, approve, cancel };
}
