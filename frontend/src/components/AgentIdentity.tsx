import { Link } from "react-router-dom";
import { agentPath } from "../app/agentRoute";
import { identityView, type AgentEnsState, type IdentityView, type Tone } from "../chain/ens/identityView.ts";
import { ensNameOf, labelForAgent } from "../chain/ens/names.ts";
import { useAgentEnsCached } from "../chain/useAgentEnsCached";
import { Icon, type IconName } from "./Icon";
import "../styles/agent-identity.css";

const TONE: Record<Tone, string> = { ok: "b-ok", weak: "b-n", warn: "b-wait", bad: "b-fail", none: "b-n" };
const ICON: Record<NonNullable<IdentityView["icon"]>, IconName> = {
  tick: "tick",
  clock: "clock",
  warn: "bell",
  fail: "x",
};

/** What `data-badge` says, for tests: the reader's badge once it is read, otherwise the state. */
const badgeOf = (state: AgentEnsState): string => (state.state === "ready" ? state.value.badge : state.state);

/**
 * The identity badge on its own: an icon plus a word, with the explaining sentence as its title and as screen-reader
 * text, so the state is never told by colour alone. It draws `identityView` and decides nothing itself.
 */
export function IdentityBadge({ state }: { state: AgentEnsState }) {
  const view = identityView(state);
  return (
    <span className={`badge ${TONE[view.tone]} ens-badge`} title={view.hint} data-badge={badgeOf(state)}>
      {view.icon && <Icon name={ICON[view.icon]} size={13} stroke={2.2} />}
      {view.label}
      <span className="sr-only">. {view.hint}</span>
    </span>
  );
}

/**
 * An agent's ENS name and identity badge, read through the shared, bounded cache. `pill` is one line for tables;
 * `block` adds the explaining sentence underneath. Display only: it never changes what can be picked or how anything is
 * ordered (E11).
 */
export function AgentIdentity({
  agent,
  variant = "pill",
}: {
  agent: { agentId: bigint; name: string };
  variant?: "pill" | "block";
}) {
  const state = useAgentEnsCached(agent);
  const view = identityView(state);
  const label = labelForAgent(agent.name);
  const name =
    view.link && label !== null ? (
      <Link to={agentPath(label)} className="mono ens-name">
        {ensNameOf(label)}
      </Link>
    ) : null;

  if (variant === "block") {
    return (
      <div className="ens-identity ens-block" data-badge={badgeOf(state)}>
        <div className="row g8 ens-line">
          {name}
          <IdentityBadge state={state} />
        </div>
        <p className="small c2" aria-hidden="true">
          {view.hint}
        </p>
      </div>
    );
  }
  return (
    <span className="ens-identity ens-pill" data-badge={badgeOf(state)}>
      {name}
      <IdentityBadge state={state} />
    </span>
  );
}
