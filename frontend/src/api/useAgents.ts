import { useEffect, useState } from "react";
import { errorMessage, listAgents } from "./client";
import type { AgentInfo } from "./types";

/** The deployed agents a requester may pick for a task. */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    listAgents().then(
      (list) => {
        // Anything but a list is not the agents service answering; names then fall back to ids.
        if (active) setAgents(Array.isArray(list) ? list : null);
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return { agents, error };
}

/** An agent's display name, falling back to its id when the roster has not loaded or does not list it. */
export function agentName(agents: AgentInfo[] | null, agentId: string): string {
  return agents?.find((a) => a.agent_id === agentId)?.name ?? `Agent ${agentId}`;
}
