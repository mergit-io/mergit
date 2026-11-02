import type { AgentInfo } from "../../../api/types";
import { MAX_PICKS } from "./draft";

const slotLabel = (slot: number) => (slot === 0 ? "Runs it" : `Retry ${String(slot)}`);

/**
 * The requester's ordered agent picks for one task: the first runs it, the rest take over in order if a
 * check fails. An agent can only be picked once per task.
 */
export function AgentPicks({
  task,
  agents,
  picks,
  onChange,
}: {
  task: string;
  agents: AgentInfo[];
  picks: string[];
  onChange: (picks: string[]) => void;
}) {
  // One empty slot to pick into while the list is not full and an agent is left to pick.
  const open = picks.length < Math.min(MAX_PICKS, agents.length);
  const slots = open ? [...picks, ""] : picks;

  const choose = (slot: number, agentId: string) => {
    const next = agentId ? slots.map((p, i) => (i === slot ? agentId : p)) : slots.filter((_, i) => i !== slot);
    onChange(next.filter(Boolean));
  };

  return (
    <div className="col g8">
      <span className="cap">Agents</span>
      {slots.map((pick, slot) => (
        <label key={`${String(slot)}-${pick}`} className="row g10">
          <span className="small c2 w-60">{slotLabel(slot)}</span>
          <select
            className="lr-select grow"
            aria-label={`${task}: ${slotLabel(slot).toLowerCase()}`}
            value={pick}
            onChange={(e) => {
              choose(slot, e.target.value);
            }}
          >
            <option value="">{slot === 0 ? "Pick an agent" : "No retry"}</option>
            {agents
              .filter((a) => a.agent_id === pick || !picks.includes(a.agent_id))
              .map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name} · {a.model}
                </option>
              ))}
          </select>
        </label>
      ))}
      <span className="small c3">If a task&apos;s check fails, the next agent you picked takes over.</span>
    </div>
  );
}
