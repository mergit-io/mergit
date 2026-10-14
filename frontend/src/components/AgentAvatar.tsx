import type { AgentKind } from "../mock/data";
import { Icon, type IconName } from "./Icon";

const AGENT_ICON: Record<AgentKind, IconName> = {
  Planner: "overview",
  Research: "search",
  Coder: "agents",
  Tester: "tick",
  Reviewer: "proofs",
  Proof: "cube",
};

/**
 * Round avatar in the agent's pastel wash, with its icon in the agent colour.
 * Decorative by default; pass `labelled` when no nearby text names the agent.
 */
export function AgentAvatar({ kind, size = 32, labelled }: { kind: AgentKind; size?: number; labelled?: boolean }) {
  const key = kind.toLowerCase();
  const a11y = labelled ? { role: "img", "aria-label": kind } : { "aria-hidden": true };
  return (
    <span className="av" title={kind} style={{ width: size, height: size, background: `var(--${key}-w)` }} {...a11y}>
      <Icon name={AGENT_ICON[kind]} size={Math.round(size / 2)} color={`var(--${key})`} />
    </span>
  );
}

export function AvatarStack({ agents, size = 26 }: { agents: AgentKind[]; size?: number }) {
  return (
    <span className="stack" role="img" aria-label={agents.join(", ")}>
      {agents.map((a) => (
        <AgentAvatar key={a} kind={a} size={size} />
      ))}
    </span>
  );
}
