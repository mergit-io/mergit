import { Link } from "react-router-dom";
import { paths } from "../app/paths";
import { labelForAgent } from "../chain/ens/names.ts";
import { useAgentEns, type AgentEnsState } from "../chain/useAgentEns";
import { DATA_MODE } from "../config/live";
import { ensBadgeView } from "../ens/badgeView";
import { Icon } from "./Icon";

/** The ENS verdict as a pill: an icon plus words, never colour alone. Only the read layer's `verified` draws a tick. */
export function EnsBadge({ state }: { state: AgentEnsState }) {
  const v = ensBadgeView(state);
  const kind = state.state === "ready" ? state.value.badge : state.state;
  return (
    <span className={`badge ${v.className}`} title={v.reason ?? undefined} data-ens-state={kind}>
      <Icon name={v.icon} size={13} stroke={2} />
      {v.label}
    </span>
  );
}

/**
 * An agent's ENS name and verdict, for any live screen that knows the agent (its Identity `agentId` and roster name,
 * which is also its ENS label). The name links to the public profile. Not shown on sample data, which has no real
 * names. Display only: nothing reads it back to pick or order agents (HLD E11).
 */
export function EnsIdentity({
  agentId,
  name,
  showReason = false,
}: {
  agentId: string;
  /** The roster name, or null while the roster is still loading (shown as checking, never as "no name"). */
  name: string | null;
  showReason?: boolean;
}) {
  const read = useAgentEns(name === null ? null : { agentId: BigInt(agentId), name });
  const state: AgentEnsState = name === null ? { state: "loading" } : read;
  if (DATA_MODE !== "live") return null;
  const label = name === null ? null : labelForAgent(name);
  const reason = ensBadgeView(state).reason;
  return (
    <span className="ens-id" data-testid={`ens-${agentId}`}>
      {state.state === "ready" && label && (
        <Link to={paths.agentProfile(label)} className="mono small ens-name">
          {state.value.name}
        </Link>
      )}
      <EnsBadge state={state} />
      {showReason && reason && <span className="small c3 ens-reason">{reason}</span>}
    </span>
  );
}
