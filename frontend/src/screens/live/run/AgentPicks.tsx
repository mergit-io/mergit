import type { AgentInfo, Candidate } from "../../../api/types";
import { formatUsdc } from "../../../chain/funding";
import { Segmented } from "../../../components/Segmented";
import { Switch } from "../../../components/Switch";
import { MAX_PICKS } from "./draft";

const slotLabel = (slot: number) => (slot === 0 ? "Runs it" : `Retry ${String(slot)}`);

const MODE_OPTIONS = ["Pick agents", "Let Mergit route"] as const;
type ModeOption = (typeof MODE_OPTIONS)[number];
const MODE: Record<ModeOption, "pick" | "auto"> = { "Pick agents": "pick", "Let Mergit route": "auto" };
const MODE_LABEL: Record<"pick" | "auto", ModeOption> = { pick: "Pick agents", auto: "Let Mergit route" };

/** The requester's choice for how one task gets its agents: a fixed pick order, or routed by reputation. */
export type RoutingChoice = { routing: "pick" | "auto"; explore: boolean; retryTolerant: boolean };

function ManualPicks({
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

/**
 * What a candidate is expected to cost, without presenting a prior as a measurement: an agent with no
 * metered cost on record shows as such, not as the router's starting estimate in dollars (final review m2,
 * the same rule as "new, no audited record yet" for its success rate). An agent whose mean cost is over the
 * task's budget says so, and that only an exploratory draw can still pick it (final review m1).
 */
function costLine(candidate: Candidate, explore: boolean): string {
  const measured = candidate.costs > 0;
  const cost = formatUsdc(BigInt(Math.round(candidate.cost_mean_micros)));
  if (candidate.within_budget) return measured ? `$${cost} expected` : "no metered cost yet";
  const over = measured
    ? `$${cost} expected, over this task's budget`
    : "no metered cost yet, starting estimate over budget";
  return `${over} · ${explore ? "only an exploratory pick tries it" : "not picked with exploring off"}`;
}

/** One ranked candidate: name, model, its track record (or "new" when it has none), and cost. */
function CandidateRow({ candidate, explore }: { candidate: Candidate; explore: boolean }) {
  const usable = candidate.eligible && (candidate.within_budget || explore);
  return (
    <li className={`inner pad-md col g4${usable ? "" : " c3"}`}>
      <div className="row between g8">
        <span className="small strong">
          {candidate.name} · {candidate.model}
        </span>
        {candidate.eligible ? (
          <span className="small c2">
            {candidate.outcomes === 0
              ? "new, no audited record yet"
              : `${String(Math.round(candidate.theta_mean * 100))}%`}
          </span>
        ) : (
          <span className="small c3">Not eligible</span>
        )}
      </div>
      <div className="row between g8">
        <span className="small c3">{candidate.eligible ? costLine(candidate, explore) : candidate.reason}</span>
      </div>
    </li>
  );
}

/**
 * The requester's agents for one task (plan task O3): either an ordered pick list (the first runs, the
 * rest are retries), or "Let Mergit route", which hands the choice to the control plane's reputation
 * router and shows the ranked candidates it would draw from.
 */
export function AgentPicks({
  task,
  agents,
  picks,
  onPicksChange,
  routing,
  onRoutingChange,
  candidates,
  candidatesError,
}: {
  task: string;
  agents: AgentInfo[];
  picks: string[];
  onPicksChange: (picks: string[]) => void;
  routing: RoutingChoice;
  onRoutingChange: (routing: RoutingChoice) => void;
  candidates?: Candidate[];
  candidatesError?: string;
}) {
  return (
    <div className="col g8">
      <span className="cap">Agents</span>
      <Segmented
        options={MODE_OPTIONS}
        value={MODE_LABEL[routing.routing]}
        onChange={(option) => {
          onRoutingChange({ ...routing, routing: MODE[option] });
        }}
        label={`${task}: routing`}
      />
      {routing.routing === "pick" ? (
        <ManualPicks task={task} agents={agents} picks={picks} onChange={onPicksChange} />
      ) : (
        <div className="col g8">
          <div className="row between">
            <span className="small c2">Explore new agents</span>
            <Switch
              checked={routing.explore}
              label={`${task}: explore new agents`}
              onChange={(explore) => {
                onRoutingChange({ ...routing, explore });
              }}
            />
          </div>
          <span className="small c3">
            {routing.explore
              ? "Mergit may try an under-observed agent instead of its top pick, to keep its reputations honest."
              : "Mergit always runs the agent with the best expected outcome."}
          </span>
          {candidatesError && <span className="small cr">{candidatesError}</span>}
          {candidates && (
            <ol className="col g6 lr-candidates">
              {candidates.map((c) => (
                <CandidateRow key={c.agent_id} candidate={c} explore={routing.explore} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
