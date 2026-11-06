import { useEffect, useState } from "react";
import { DATA_MODE } from "../config/live";
import { loadAgentEns } from "./ens/agentEns.ts";
import { cachedEns } from "./ens/ensCache.ts";
import { labelForAgent } from "./ens/names.ts";
import { liveEnsClients, liveEnsConfig } from "./liveEns";
import { readFailure } from "./readFailure";
import type { AgentEnsState } from "./useAgentEns";

/** One loader for the whole app: at most three agents are read at a time, and each result is reused for a minute. */
const sharedEns = cachedEns((agent) => loadAgentEns(liveEnsClients(), liveEnsConfig(), agent), {
  concurrency: 3,
  ttlMs: 60_000,
});

/**
 * `useAgentEns` for pages that show many agents: the same result, read through one shared, bounded cache so a list of
 * N agents does not start N full reads at once on every mount. Display data only (E11).
 */
export function useAgentEnsCached(agent: { agentId: bigint; name: string } | null): AgentEnsState {
  const label = agent && DATA_MODE === "live" ? labelForAgent(agent.name) : null;
  const agentId = agent?.agentId;
  const key = label !== null && agentId !== undefined ? `${label}:${String(agentId)}` : null;
  const [result, setResult] = useState<{ key: string; state: AgentEnsState } | null>(null);

  useEffect(() => {
    if (key === null || label === null || agentId === undefined) return;
    let active = true;
    sharedEns({ agentId, label }).then(
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
