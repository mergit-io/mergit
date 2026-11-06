import { useState } from "react";
import { retryTask } from "../../../api/client";
import type { AgentInfo, PlanTask } from "../../../api/types";
import { Problems } from "./Problems";
import { useSubmit } from "./useSubmit";

/**
 * Sends one stuck task to an agent the requester chooses, instead of closing the whole plan. Offers an agent
 * this task has not had yet first; any deployed agent may be chosen.
 */
export function RetryTask({
  planUuid,
  task,
  agents,
  onRetried,
}: {
  planUuid: string;
  task: PlanTask;
  agents: AgentInfo[] | null;
  onRetried: () => void;
}) {
  const tried = new Set(task.agents ?? []);
  const fresh = agents?.find((a) => !tried.has(a.agent_id)) ?? agents?.[0];
  const [agentId, setAgentId] = useState(fresh?.agent_id ?? "");
  const { busy, problems, submit } = useSubmit();
  const chosen = agentId || fresh?.agent_id || "";

  const retry = () => {
    void submit(async () => {
      await retryTask(planUuid, task.index, chosen);
      onRetried();
    });
  };

  return (
    <div className="col g6">
      <span className="small strong">
        Task {task.index + 1}: {task.title}
      </span>
      <div className="row g8 lr-retry-row">
        <select
          className="lr-select lr-retry-select"
          aria-label={`Agent to retry task ${String(task.index + 1)} with`}
          value={chosen}
          disabled={busy || !agents}
          onChange={(e) => {
            setAgentId(e.target.value);
          }}
        >
          {(agents ?? []).map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.name} · {a.model}
              {tried.has(a.agent_id) ? " (tried)" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary compact" disabled={busy || !chosen} onClick={retry}>
          {busy ? "Retrying…" : "Retry with this agent"}
        </button>
      </div>
      <Problems items={problems} />
    </div>
  );
}
