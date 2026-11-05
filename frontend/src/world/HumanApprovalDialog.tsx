import { useEffect, useRef } from "react";
import { formatUsdc } from "../chain/funding";
import { Icon } from "../components/Icon";
import type { ApprovalRequired } from "./humanApproval";

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
 */
export function HumanApprovalDialog({
  req,
  onApprove,
  onCancel,
}: {
  req: ApprovalRequired;
  onApprove: () => void;
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

  return (
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
            Confirm with World ID
          </h2>
        </div>
        <p id="world-approval-desc" className="small c2 connect-desc">
          World&rsquo;s own screen will not show this — check it here before you continue.
        </p>
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
              <span className="mono">{repoUrl}</span>
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
              <span className="mono">{diffHash}</span>
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
          <button type="button" className="btn primary compact" onClick={onApprove}>
            Continue to World ID
          </button>
          <button type="button" className="btn secondary compact" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
