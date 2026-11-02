import type { AgentInfo, Suggestion, SuggestionsResponse, TaskSuggestions } from "../../../api/types";
import { formatUsdc } from "../../../chain/funding";
import { MAX_PICKS, suggestedPicks } from "./draft";

const slotLabel = (slot: number) => (slot === 0 ? "Runs it" : `Retry ${String(slot)}`);

/**
 * `formatUsdc` rounds down to cents, which would print a real but tiny cost as $0.00; 10 000 micros is where
 * it first prints a cent. Rounding up first keeps a cost under one micro from reading as zero too.
 */
function dollars(micros: number): string {
  const units = BigInt(Math.max(0, Math.ceil(micros)));
  return units > 0n && units < 10_000n ? "under $0.01" : `$${formatUsdc(units)}`;
}

/** A posterior (or a draw from one) is never exactly 0 or 1, so the rounded figure isn't either. */
function percent(success: number): string {
  const rounded = Math.round(success * 100);
  return String(success > 0 && success < 1 ? Math.min(99, Math.max(1, rounded)) : rounded);
}

/**
 * A suggestion's numbers, and what they are. With no counted outcome both are only the starting estimate,
 * and a cost with nothing metered behind it (`cost_is_prior`) is too, so neither is shown as if measured. In
 * explore mode the numbers are one random draw, not the agent's estimate, so they are labelled as this
 * draw's (`drawn`) and the cost loses its "about".
 */
function evidence(pick: Suggestion, mode: SuggestionsResponse["mode"]): { drawn: boolean; text: string } {
  if (pick.counted_outcomes <= 0) return { drawn: false, text: "new, no audited record yet" };
  const drawn = mode === "explore";
  const outcomes = `${String(pick.counted_outcomes)} counted outcome${pick.counted_outcomes === 1 ? "" : "s"}`;
  const cost = pick.cost_is_prior
    ? "no metered cost yet"
    : `${drawn ? "" : "about "}${dollars(pick.assumed_cost_micros)} a run`;
  return { drawn, text: `${percent(pick.assumed_success)}% success · ${cost} · ${outcomes}` };
}

function Evidence({ pick, mode }: { pick: Suggestion; mode: SuggestionsResponse["mode"] }) {
  const { drawn, text } = evidence(pick, mode);
  return (
    <span className="small c2">
      {drawn && <span className="strong">This draw: </span>}
      {text}
    </span>
  );
}

/**
 * The control plane's advice for one task, under the manual picks: its suggested agents best first, then
 * every agent it left out with the reason it gave. "Use suggestion" only fills the pick slots above; the
 * requester can still change them, and nothing is sent until they approve.
 */
function Suggested({
  task,
  agents,
  suggestion,
  mode,
  noteId,
  onUse,
}: {
  task: string;
  agents: AgentInfo[];
  suggestion: TaskSuggestions;
  mode: SuggestionsResponse["mode"];
  noteId?: string;
  onUse: (picks: string[]) => void;
}) {
  const fill = suggestedPicks(suggestion, agents);
  const model = (agentId: string) => agents.find((a) => a.agent_id === agentId)?.model;

  return (
    <div className="col g8 lr-suggested">
      <div className="row between g8">
        <span className="row g8">
          <span className="cap">Suggested</span>
          {mode === "explore" && <span className="small c3">Random draw</span>}
        </span>
        {fill.length > 0 && (
          <button
            type="button"
            className="btn secondary compact"
            onClick={() => {
              onUse(fill);
            }}
          >
            Use suggestion
          </button>
        )}
      </div>
      {suggestion.picks.length > 0 ? (
        <ol className="col g6" aria-label={`${task}: suggested agents`}>
          {suggestion.picks.map((p) => (
            <li key={p.agent_id} className="inner pad-sm col g4">
              <div className="row between g8">
                <span className="small strong ellipsis">
                  {p.name}
                  {model(p.agent_id) && <span className="c3"> · {model(p.agent_id)}</span>}
                </span>
                {p.unproven && (
                  <span className="chip warn" aria-describedby={noteId}>
                    Unproven
                  </span>
                )}
              </div>
              <Evidence pick={p} mode={mode} />
            </li>
          ))}
        </ol>
      ) : (
        suggestion.reason && <p className="small c2">{suggestion.reason}</p>
      )}
      {suggestion.ineligible.length > 0 && (
        <div className="col g4">
          <span className="small c3">Not suggested</span>
          <ul className="col g4" aria-label={`${task}: not suggested`}>
            {suggestion.ineligible.map((a) => (
              <li key={a.agent_id} className="small c3">
                <span className="strong">{a.name}</span>: {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The requester's ordered agent picks for one task: the first runs it, the rest take over in order if a
 * check fails. An agent can only be picked once per task. When the control plane's suggestions for the
 * task have loaded, they are shown under the picks as advice; without them the picks work exactly the same.
 */
export function AgentPicks({
  task,
  agents,
  picks,
  onChange,
  suggestion,
  mode = "greedy",
  noteId,
}: {
  task: string;
  agents: AgentInfo[];
  picks: string[];
  onChange: (picks: string[]) => void;
  /** This task's entry in the suggestions answer; absent while loading or when it failed. */
  suggestion?: TaskSuggestions;
  mode?: SuggestionsResponse["mode"];
  /** The id of the answer's note, which explains what "unproven" costs; each Unproven badge points to it. */
  noteId?: string;
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
      {suggestion && (
        <Suggested task={task} agents={agents} suggestion={suggestion} mode={mode} noteId={noteId} onUse={onChange} />
      )}
    </div>
  );
}
