import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { formatUsdc } from "../chain/funding";
import { Icon } from "../components/Icon";
import { resolveApiUrl } from "./api";
import type { ApprovalRequired } from "./humanApproval";

/** The popup's window name (so a second click reuses it instead of opening another) and size. */
const POPUP_TARGET = "mergit-world-approval";
const POPUP_FEATURES = "width=480,height=760";

/** A 64-character diff hash or a long repo URL has no spaces to break at; without this it runs off the dialog. */
const WRAP = { overflowWrap: "anywhere" } as const;

type TaskSummary = { index?: unknown; title?: unknown; agents?: unknown; budget_usdc_units?: unknown };

function isTaskSummary(value: unknown): value is TaskSummary {
  return value !== null && typeof value === "object";
}

function usdcLine(units: unknown): string | null {
  if (typeof units !== "string" && typeof units !== "number") return null;
  try {
    return `${formatUsdc(BigInt(units))} USDC`;
  } catch {
    return null;
  }
}

/**
 * What a fresh World ID check is about to approve (plan sec 1.7), read straight out of the `summary` the
 * 428 carried: a plan's goal, per-task agents and budget, and funding; or a pull request's repo and the
 * exact diff it would open. `summary` is arbitrary JSON and differs by action, so everything here is read
 * defensively and simply left out when a field isn't the shape expected.
 *
 * World's own sign-in screen only ever asks "are you human, right now" -- it never shows what is being
 * approved. This dialog is the one place that does, before the popup opens.
 *
 * "Continue to World ID" opens the popup itself, synchronously inside its own click handler, and hands the
 * result (including a blocked `null`) to `onApprove`: a popup blocker only reliably honors `window.open`
 * called directly inside the gesture that triggered it, not a later `await`-ed continuation.
 *
 * After that the dialog stays up, `waiting`, until World answers: "Waiting for World ID…" and a Cancel button
 * (`onCancel` again), so a person who closed the World ID window, or changed their mind, is never left
 * waiting on a page that cannot tell (a closed popup is not reliably detectable, see `humanApproval.ts`).
 */
export function HumanApprovalDialog({
  req,
  waiting = false,
  onApprove,
  onCancel,
}: {
  req: ApprovalRequired;
  waiting?: boolean;
  onApprove: (popup: Window | null) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { summary } = req;
  const goal = typeof summary.goal === "string" ? summary.goal : null;
  const repoUrl = typeof summary.repo_url === "string" ? summary.repo_url : null;
  const funding = typeof summary.funding === "string" ? summary.funding : null;
  const total = usdcLine(summary.total_budget_usdc_units);
  const diffHash = typeof summary.diff_sha256 === "string" ? summary.diff_sha256 : null;
  const tasks = Array.isArray(summary.tasks) ? summary.tasks.filter(isTaskSummary) : [];

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  // "Continue" is gone once waiting, and focus with it; keep it in the dialog, where Cancel is.
  useEffect(() => {
    if (waiting) dialogRef.current?.focus();
  }, [waiting]);

  // Rendered into <body>, not where the caller sits: the page content around it carries an entrance
  // animation on `transform`, which makes it the containing block for anything `position: fixed` inside it.
  // In place, the backdrop then centres the dialog on the whole page instead of the screen, and on a long,
  // scrolled page the dialog -- and its Cancel -- can end up out of view.
  return createPortal(
    <div className="connect-backdrop">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-approval-title"
        aria-describedby="world-approval-desc"
      >
        <div className="row g12">
          <Icon name="check" size={20} />
          <h2 id="world-approval-title" className="connect-title">
            {waiting ? "Waiting for World ID…" : "Confirm with World ID"}
          </h2>
        </div>
        {waiting ? (
          <p id="world-approval-desc" className="small c2 connect-desc" role="status">
            Finish the check in the World ID window. This page carries on by itself once World answers. Closed that
            window, or changed your mind? Cancel — nothing is done unless World approves.
          </p>
        ) : (
          <p id="world-approval-desc" className="small c2 connect-desc">
            World&rsquo;s own screen will not show this — check it here before you continue.
          </p>
        )}
        <div className="col g4 small">
          {goal && (
            <div>
              <span className="c3">Goal </span>
              {goal}
            </div>
          )}
          {repoUrl && (
            <div>
              <span className="c3">Repo </span>
              <span className="mono" style={WRAP}>
                {repoUrl}
              </span>
            </div>
          )}
          {funding && (
            <div>
              <span className="c3">Funding </span>
              {funding}
            </div>
          )}
          {total && (
            <div>
              <span className="c3">Total budget </span>
              {total}
            </div>
          )}
          {diffHash && (
            <div>
              <span className="c3">Diff </span>
              <span className="mono" style={WRAP}>
                {diffHash}
              </span>
            </div>
          )}
          {tasks.length > 0 && (
            <ul className="col g4">
              {tasks.map((task, i) => (
                <li key={typeof task.index === "number" ? task.index : i}>
                  {typeof task.title === "string" ? task.title : `Task ${String(i + 1)}`}
                  {" — "}
                  <span className="c3">
                    {Array.isArray(task.agents) && task.agents.length > 0 ? task.agents.join(", ") : "no agent"} ·{" "}
                    {usdcLine(task.budget_usdc_units) ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="row g8">
          {!waiting && (
            <button
              type="button"
              className="btn primary compact"
              onClick={() => {
                onApprove(window.open(resolveApiUrl(req.start_url), POPUP_TARGET, POPUP_FEATURES));
              }}
            >
              Continue to World ID
            </button>
          )}
          <button type="button" className="btn secondary compact" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
