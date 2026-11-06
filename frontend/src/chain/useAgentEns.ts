import { useEffect, useState } from "react";
import { DATA_MODE, LIVE } from "../config/live";
import { loadAgentEns, type AgentEns, type EnsClients } from "./ens/agentEns.ts";
import { labelForAgent } from "./ens/names.ts";
import { liveEnsClients, liveEnsConfig } from "./liveEns";
import { readFailure } from "./readFailure";

export type AgentEnsState =
  | { state: "loading" }
  /** The agent has no ENS name (its name is not a valid label), or the app is not in live mode. */
  | { state: "none" }
  | { state: "ready"; value: AgentEns }
  | { state: "error"; message: string };

type Agent = { agentId: bigint; name: string };

let clients: Promise<EnsClients> | undefined;
/** Mainnet, or (VITE_ENS_READER=stub, the e2e tests only) fixed chain answers that still go through the real check. */
function ensClients(): Promise<EnsClients> {
  clients ??=
    LIVE.ens.reader === "stub"
      ? import("./ens/stubClients.ts").then((m) => m.stubEnsClients(liveEnsConfig()))
      : Promise.resolve(liveEnsClients());
  return clients;
}

/**
 * One reading per agent is shared for `LIVE.ens.cacheTtlMs`: the same agent's badge appears in several places on a
 * page, and asking mainnet again for each would be the same answer at the price of a rate limit. A failure is not kept.
 */
const cache = new Map<string, { at: number; value: Promise<AgentEnsState> }>();

const keyOf = (agent: Agent | null) => {
  const label = agent && DATA_MODE === "live" ? labelForAgent(agent.name) : null;
  return agent && label !== null ? { key: `${label}:${String(agent.agentId)}`, label, agentId: agent.agentId } : null;
};

function load(k: { key: string; label: string; agentId: bigint }): Promise<AgentEnsState> {
  const hit = cache.get(k.key);
  if (hit && Date.now() - hit.at < LIVE.ens.cacheTtlMs) return hit.value;
  const value = ensClients()
    .then((c) => loadAgentEns(c, liveEnsConfig(), { agentId: k.agentId, label: k.label }))
    .then(
      (v): AgentEnsState => ({ state: "ready", value: v }),
      (): AgentEnsState => {
        cache.delete(k.key);
        return { state: "error", message: readFailure("the ENS records", "Ethereum") };
      },
    );
  cache.set(k.key, { at: Date.now(), value });
  return value;
}

/**
 * What ENS says about an agent: its records, the two-way check, the operator state and the reputation mirror (see
 * ens/agentEns.ts). Display data only: nothing that routes or submits work may read it (E11). The agent's name is its
 * ENS label only if it is already a valid label.
 */
export function useAgentEns(agent: Agent | null): AgentEnsState {
  const k = keyOf(agent);
  const key = k?.key ?? null;
  const [result, setResult] = useState<{ key: string; state: AgentEnsState } | null>(null);

  useEffect(() => {
    if (!k) return;
    let active = true;
    void load(k).then((state) => {
      if (active) setResult({ key: k.key, state });
    });
    return () => {
      active = false;
    };
    // k is rebuilt every render; its key says everything that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (key === null) return { state: "none" };
  return result?.key === key ? result.state : { state: "loading" };
}

/** The same reading for a list of agents (the leaderboard), keyed by `agentId`; an agent not answered yet is absent. */
export function useAgentsEns(agents: Agent[] | null): Record<string, AgentEnsState> {
  const [states, setStates] = useState<Record<string, AgentEnsState>>({});
  const joined = agents?.map((a) => `${String(a.agentId)}=${a.name}`).join("\n");
  useEffect(() => {
    if (!joined) return;
    let active = true;
    for (const line of joined.split("\n")) {
      const at = line.indexOf("=");
      const agentId = line.slice(0, at);
      const k = keyOf({ agentId: BigInt(agentId), name: line.slice(at + 1) });
      if (!k) continue; // no ENS name: answered below without a read
      void load(k).then((state) => {
        if (active) setStates((prev) => ({ ...prev, [agentId]: state }));
      });
    }
    return () => {
      active = false;
    };
  }, [joined]);
  const out: Record<string, AgentEnsState> = { ...states };
  for (const a of agents ?? []) if (!keyOf(a)) out[String(a.agentId)] = { state: "none" };
  return out;
}
