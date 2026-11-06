import { Link } from "react-router-dom";
import { paths } from "../../../app/paths";
import { agentName } from "../../../api/useAgents";
import { EnsIdentity } from "../../../components/EnsIdentity";
import type { AgentInfo, Attempt, MoneyEvent, PendingDispatch, PlanTask, StepEvent } from "../../../api/types";
import { formatUsdc } from "../../../chain/funding";
import { OutcomeBadge, ProgressBadge, VerdictBadge } from "./badges";
import { phiCommand } from "./format";
import { attemptOutcome, attemptsOf, taskProgress, verdictFor, type TaskProgress, type Verdict } from "./progress";

function progressNote(progress: TaskProgress, agents: AgentInfo[] | null): string {
  switch (progress.kind) {
    case "waiting":
      return "Waits for the tasks it depends on, then for its budget to be locked in Escrow.";
    case "running":
      return `${agentName(agents, progress.attempt.agent_id)} is working on attempt ${String(progress.attempt.attempt)}.`;
    case "passed":
      return "Its check held. The task is done.";
    case "retrying": {
      const failed = `Attempt ${String(progress.failed.attempt)} did not pass its check.`;
      const next = agentName(agents, progress.nextAgent);
      if (progress.pending?.state === "escrowing") return `${failed} Locking the payment for ${next}'s attempt.`;
      if (progress.pending?.last_error)
        // The gateway holds a retry until the failed attempt's payment is back in the plan. An attempt that
        // ended without a receipt only gets it back at its deadline, 30 minutes after it was dispatched.
        return `${failed} ${next} starts once attempt ${String(progress.failed.attempt)}'s payment is back in the plan, up to 30 minutes after that attempt began.`;
      return `${failed} Retrying with ${next}.`;
    }
    case "stuck":
      return progress.givenUp
        ? `Attempt ${String(progress.givenUp.attempt)} could not be started${progress.givenUp.last_error ? `: ${progress.givenUp.last_error}` : "."}`
        : "Every agent you picked has tried this task and its check never held.";
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
  pending,
  money,
  steps,
  agents,
}: {
  task: PlanTask;
  attempts: Attempt[];
  pending: PendingDispatch[];
  money: MoneyEvent[];
  steps: StepEvent[];
  agents: AgentInfo[] | null;
}) {
  const progress = taskProgress(task, attempts, pending);
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
        <p className="small c2">{progressNote(progress, agents)}</p>
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
                  <OutcomeBadge outcome={attemptOutcome(a)} />
                </div>
                <EnsIdentity
                  agentId={a.agent_id}
                  name={agents ? (agents.find((x) => x.agent_id === a.agent_id)?.name ?? "") : null}
                />
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
