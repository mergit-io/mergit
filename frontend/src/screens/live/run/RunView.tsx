import { useState } from "react";
import { agentName } from "../../../api/useAgents";
import type { AgentInfo, PlanDetail, PlanTask, StepEvent } from "../../../api/types";
import { Icon } from "../../../components/Icon";
import { ProgressBadge } from "./badges";
import { ClosePlan } from "./ClosePlan";
import { PullRequestStep } from "./PullRequestStep";
import { attemptsOf, stuckTasks, taskProgress } from "./progress";
import { StepLog } from "./StepLog";
import { TaskFlow } from "./TaskFlow";
import { TaskDetail } from "./TaskDetail";

/** A funded plan as it runs: every task's state, the selected task's attempts, and the live step log. */
export function RunView({
  detail,
  steps,
  agents,
  onClosed,
}: {
  detail: PlanDetail;
  steps: StepEvent[];
  agents: AgentInfo[] | null;
  onClosed: () => void;
}) {
  const [selected, setSelected] = useState(detail.tasks[0]?.index ?? 0);
  const task = detail.tasks.find((t) => t.index === selected);
  const passed = detail.tasks.filter((t) => taskProgress(t, detail.attempts).kind === "passed").length;

  return (
    <>
      <RunBanner detail={detail} onClosed={onClosed} />
      {detail.state === "done" && <PullRequestStep planUuid={detail.plan_uuid} />}
      <section className="rw-grid">
        <div className="col g16 min0">
          <section className="card pad24 col g12" aria-labelledby="flow-title">
            <div className="row between">
              <h2 id="flow-title" className="title">
                Flow
              </h2>
              <span className="small c3">A task starts once every task above it has passed</span>
            </div>
            <TaskFlow detail={detail} agents={agents} selected={selected} onSelect={setSelected} />
          </section>
          <section className="card" aria-labelledby="tasks-title">
            <div className="hd">
              <h2 id="tasks-title" className="title">
                Tasks
              </h2>
              <span className="small c3">
                {passed} of {detail.tasks.length} passed their check
              </span>
            </div>
            {detail.tasks.map((t) => (
              <TaskRow
                key={t.index}
                task={t}
                detail={detail}
                agents={agents}
                selected={t.index === selected}
                onSelect={() => {
                  setSelected(t.index);
                }}
              />
            ))}
          </section>
          <StepLog steps={steps} attempts={detail.attempts} />
        </div>
        {task && (
          <TaskDetail
            key={task.index}
            task={task}
            attempts={detail.attempts}
            money={detail.money_events}
            steps={steps}
            agents={agents}
          />
        )}
      </section>
    </>
  );
}

function TaskRow({
  task,
  detail,
  agents,
  selected,
  onSelect,
}: {
  task: PlanTask;
  detail: PlanDetail;
  agents: AgentInfo[] | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const progress = taskProgress(task, detail.attempts);
  const latest = attemptsOf(task.index, detail.attempts).at(-1);
  const agentId = latest?.agent_id ?? task.agents?.[0];
  return (
    <button type="button" className="tr rw-row" aria-pressed={selected} onClick={onSelect}>
      <span className="mono-s c3 w-28">{task.index + 1}</span>
      <span className="strong grow ellipsis">{task.title}</span>
      <span className="small c2 hide-sm w-130 ellipsis">{agentId ? agentName(agents, agentId) : "—"}</span>
      <span className="mono-s c3 hide-sm w-110 ellipsis">
        {latest ? `attempt ${String(latest.attempt)} of ${String(task.agents?.length ?? 1)}` : ""}
      </span>
      <span className="w-110">
        <ProgressBadge progress={progress} />
      </span>
    </button>
  );
}

/** What the requester needs to know about the whole plan right now, if anything. */
function RunBanner({ detail, onClosed }: { detail: PlanDetail; onClosed: () => void }) {
  if (detail.state === "done") {
    return (
      <p className="card pad row g10 lr-banner" role="status">
        <Icon name="check" size={18} color="var(--mint)" />
        Every task passed its check.
      </p>
    );
  }
  if (detail.state === "closed") {
    return (
      <p className="card pad row g10 lr-banner" role="status">
        <Icon name="x" size={18} color="var(--ink3)" />
        This plan is closed. Its unspent funds go back to you.
      </p>
    );
  }
  // Not currently reachable (nothing transitions a plan here yet), but it's a real PlanState the
  // schema allows; without this the page would show no banner and no way to close a "Failed" plan.
  if (detail.state === "failed") {
    return (
      <div className="card pad col g10 lr-banner lr-banner-warn" role="alert">
        <span className="strong">
          <Icon name="hand" size={16} color="var(--amber)" /> This plan failed.
        </span>
        <span className="small c2">Close it to stop it and get its unspent funds back.</span>
        <ClosePlan planUuid={detail.plan_uuid} onClosed={onClosed} />
      </div>
    );
  }
  const stuck = stuckTasks(detail.tasks, detail.attempts);
  if (stuck.length === 0) return null;
  const names = stuck.map((t) => `task ${String(t.index + 1)}`).join(", ");
  return (
    <div className="card pad col g10 lr-banner lr-banner-warn" role="alert">
      <span className="strong">
        <Icon name="hand" size={16} color="var(--amber)" /> Needs you: {names} failed its check with every agent you
        picked.
      </span>
      <span className="small c2">
        Nothing more runs on its own. Close the plan to stop it and get its unspent funds back.
      </span>
      <ClosePlan planUuid={detail.plan_uuid} onClosed={onClosed} />
    </div>
  );
}
