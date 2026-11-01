import { Link } from "react-router-dom";
import { paths } from "../../../app/paths";
import { agentName } from "../../../api/useAgents";
import type { AgentInfo, Attempt, MoneyEvent, NeedsRequester, PlanTask, StepEvent } from "../../../api/types";
import { formatUsdc } from "../../../chain/funding";
import { Badge } from "../../../components/Badge";
import { OutcomeBadge, ProgressBadge, VerdictBadge } from "./badges";
import { phiCommand } from "./format";
import { attemptOutcome, attemptsOf, taskProgress, verdictFor, type TaskProgress, type Verdict } from "./progress";

function progressNote(task: PlanTask, progress: TaskProgress, agents: AgentInfo[] | null): string {
  switch (progress.kind) {
    case "waiting":
      return task.routing === "auto"
        ? "Waits for the tasks it depends on, then for Mergit to route it to an agent and lock its budget in Escrow."
        : "Waits for the tasks it depends on, then for its budget to be locked in Escrow.";
    case "running":
      return `${agentName(agents, progress.attempt.agent_id)} is working on attempt ${String(progress.attempt.attempt)}.`;
    case "passed":
      return "Its check held. The task is done.";
    case "retrying":
      return progress.nextAgent === null
        ? `Attempt ${String(progress.failed.attempt)} did not pass its check. Mergit is routing a retry to another agent.`
        : `Attempt ${String(progress.failed.attempt)} did not pass its check. Retrying with ${agentName(agents, progress.nextAgent)}.`;
    case "stuck":
      switch (progress.reason) {
        case undefined:
          return "Every agent you picked has tried this task and its check never held.";
        case "over_budget":
          return progress.failed
            ? "Its check never held, and no agent Mergit can still route it to is expected to fit its budget."
            : "No agent Mergit can route it to is expected to fit its budget, so it has not started.";
        case "agents_exhausted":
          return "Every agent Mergit could route it to has tried this task and its check never held.";
        case "attempts_exhausted":
          return "This task used every attempt it is allowed and its check never held.";
      }
  }
}

/**
 * What else is known about one attempt. Steps are only ever streamed, so the count covers what this page
 * has seen, and is left out rather than shown as zero for an attempt that finished before it opened.
 */
function AttemptMeta({ steps, verdict, receipt }: { steps: number; verdict: Verdict | null; receipt: string | null }) {
  if (steps === 0 && !verdict && !receipt) return null;
  return (
    <div className="row g10 lr-attempt-meta">
      {steps > 0 && <span className="mono-s c3">{steps} steps seen live</span>}
      {verdict && <VerdictBadge verdict={verdict} />}
      {receipt && (
        <Link className="link small" to={receipt}>
          Receipt
        </Link>
      )}
    </div>
  );
}

/** Side panel for one task: its check, every attempt with its outcome, verdict and receipt. */
export function TaskDetail({
  task,
  attempts,
  needsRequester,
  money,
  steps,
  agents,
}: {
  task: PlanTask;
  attempts: Attempt[];
  needsRequester: NeedsRequester[];
  money: MoneyEvent[];
  steps: StepEvent[];
  agents: AgentInfo[] | null;
}) {
  const progress = taskProgress(task, attempts, needsRequester);
  const mine = attemptsOf(task.index, attempts);
  const stepCount = (taskId: string) => steps.filter((s) => s.task_id === taskId).length;

  return (
    <aside className="card pad col g16 rw-panel" aria-label={`Task ${String(task.index + 1)} details`}>
      <div className="col g6">
        <span className="mono-s c3">Task {task.index + 1}</span>
        <h2 className="title">{task.title}</h2>
        <div className="row g8">
          <ProgressBadge progress={progress} />
          <span className="mono-s c3">{formatUsdc(BigInt(task.budget_usdc_units))} USDC</span>
        </div>
        <p className="small c2">{progressNote(task, progress, agents)}</p>
      </div>

      <div className="col g6">
        <span className="cap c3">Check (Φ)</span>
        <pre className="inner code rw-pre">{phiCommand(task.phi)}</pre>
      </div>

      <div className="col g8">
        <span className="cap c3">Attempts</span>
        {mine.length === 0 && <p className="small c3">Not dispatched yet.</p>}
        <ol className="lr-attempts">
          {mine.map((a) => {
            const verdict = verdictFor(a.task_id, money);
            return (
              <li key={a.task_id} className="inner pad-md col g6">
                <div className="row between g8">
                  <span className="strong small">
                    Attempt {a.attempt} · {agentName(agents, a.agent_id)}
                  </span>
                  <div className="row g8">
                    {a.routing?.exploratory && <Badge status="Neutral" label="Exploratory pick" />}
                    <OutcomeBadge outcome={attemptOutcome(a)} />
                  </div>
                </div>
                <AttemptMeta
                  steps={stepCount(a.task_id)}
                  verdict={verdict}
                  receipt={a.receipt_root ? paths.proof(a.task_id) : null}
                />
                {a.notes && <p className="small c2">{a.notes}</p>}
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}
