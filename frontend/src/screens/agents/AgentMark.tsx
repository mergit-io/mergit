import { Icon } from "../../components/Icon";
import type { AgentLook } from "../../mock/registry";

/** Round icon in the agent's wash and colour. Decorative: a name is always next to it. */
export function AgentMark({ agent, size = 44 }: { agent: AgentLook; size?: number }) {
  return (
    <span
      className="av"
      aria-hidden="true"
      style={{ width: size, height: size, background: `var(--${agent.tone}-w)`, color: `var(--${agent.tone})` }}
    >
      <Icon name={agent.icon} size={Math.round(size * 0.42)} />
    </span>
  );
}
