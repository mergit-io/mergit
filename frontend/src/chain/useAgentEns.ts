import { useEffect, useState } from "react";
import { DATA_MODE } from "../config/live";
import { loadAgentEns, type AgentEns } from "./ens/agentEns.ts";
import { labelForAgent } from "./ens/names.ts";
import { liveEnsClients, liveEnsConfig } from "./liveEns";
import { readFailure } from "./readFailure";

export type AgentEnsState =
  | { state: "loading" }
  /** The agent has no ENS name (its name is not a valid label), or the app is not in live mode. */
  | { state: "none" }
  | { state: "ready"; value: AgentEns }
  | { state: "error"; message: string };

/**
 * What ENS says about an agent: its records, the two-way check, the operator state and the reputation mirror (see
 * ens/agentEns.ts). Display data only: nothing that routes or submits work may read it (E11). The agent's name is its
 * ENS label only if it is already a valid label.
 */
export function useAgentEns(agent: { agentId: bigint; name: string } | null): AgentEnsState {
  const label = agent && DATA_MODE === "live" ? labelForAgent(agent.name) : null;
  const agentId = agent?.agentId;
  const key = label !== null && agentId !== undefined ? `${label}:${String(agentId)}` : null;
  const [result, setResult] = useState<{ key: string; state: AgentEnsState } | null>(null);

  useEffect(() => {
    if (key === null || label === null || agentId === undefined) return;
    let active = true;
    loadAgentEns(liveEnsClients(), liveEnsConfig(), { agentId, label }).then(
      (value) => {
        if (active) setResult({ key, state: { state: "ready", value } });
      },
      () => {
        if (active) setResult({ key, state: { state: "error", message: readFailure("the ENS records", "Ethereum") } });
      },
    );
    return () => {
      active = false;
    };
  }, [key, label, agentId]);

  if (key === null) return { state: "none" };
  return result?.key === key ? result.state : { state: "loading" };
}
