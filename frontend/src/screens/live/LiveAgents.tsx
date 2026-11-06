import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAgents } from "../../api/useAgents";
import { byAgent, percent, usdc } from "../../api/reputation";
import { useReputation } from "../../api/useReputation";
import type { AgentInfo } from "../../api/types";
import { identityAbi } from "../../chain/abi";
import { publicClient } from "../../chain/client";
import { AgentIdentity } from "../../components/AgentIdentity";
import { PageHeader } from "../../components/PageHeader";
import { LIVE } from "../../config/live";

type Onchain = { operator: Address; runtimeKey: Address };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const EXPLORER: Record<number, string> = { 84532: "https://sepolia.basescan.org" };

function AddressLink({ address }: { address: Address }) {
  const base = EXPLORER[LIVE.chainId];
  return base ? (
    <a className="mono" href={`${base}/address/${address}`} target="_blank" rel="noreferrer">
      {short(address)}
    </a>
  ) : (
    <span className="mono">{short(address)}</span>
  );
}

/** Who owns each agent and which key signs its receipts, read from the Identity contract. */
function useOnchain(agents: AgentInfo[] | null) {
  const [info, setInfo] = useState<Record<string, Onchain | null>>({});
  useEffect(() => {
    if (!agents) return;
    let active = true;
    for (const a of agents) {
      const args = [BigInt(a.agent_id)] as const;
      Promise.all([
        publicClient.readContract({
          address: LIVE.contracts.identity,
          abi: identityAbi,
          functionName: "operatorOf",
          args,
        }),
        publicClient.readContract({
          address: LIVE.contracts.identity,
          abi: identityAbi,
          functionName: "runtimeKeyOf",
          args,
        }),
      ]).then(
        ([operator, runtimeKey]) => {
          if (active) setInfo((prev) => ({ ...prev, [a.agent_id]: { operator, runtimeKey } }));
        },
        () => {
          if (active) setInfo((prev) => ({ ...prev, [a.agent_id]: null }));
        },
      );
    }
    return () => {
      active = false;
    };
  }, [agents]);
  return info;
}

/** The agents deployed on this network: the roster the API serves, with identity read from the chain. */
export function LiveAgents() {
  const { agents, error } = useAgents();
  const onchain = useOnchain(agents);
  const { reputation } = useReputation();
  const seen = byAgent(reputation?.agents ?? []);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`The agents you can pick for a task. Owner and signing key are read from the Identity contract on ${LIVE.chainName}.`}
      />
      <section className="card pad24">
        {error && <p className="c2">{error}</p>}
        {!error && agents === null && <p className="c2">Loading agents…</p>}
        {agents?.length === 0 && <p className="c2">No agents are deployed yet.</p>}
        {agents && agents.length > 0 && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">ENS name</th>
                <th scope="col">Model</th>
                <th scope="col">Operator (paid)</th>
                <th scope="col">Receipt signing key</th>
                <th scope="col">Validated record</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const chain = onchain[a.agent_id];
                return (
                  <tr key={a.agent_id}>
                    <td>
                      <span className="strong">{a.name}</span> <span className="mono c3">#{a.agent_id}</span>
                    </td>
                    <td data-testid={`ens-${a.agent_id}`}>
                      {/^\d+$/.test(a.agent_id) ? (
                        <AgentIdentity agent={{ agentId: BigInt(a.agent_id), name: a.name }} />
                      ) : (
                        <span className="c3">No ENS name</span>
                      )}
                    </td>
                    <td className="mono">{a.model}</td>
                    <td>{chain ? <AddressLink address={chain.operator} /> : chain === null ? "unavailable" : "…"}</td>
                    <td>{chain ? <AddressLink address={chain.runtimeKey} /> : chain === null ? "unavailable" : "…"}</td>
                    <td data-testid={`record-${a.agent_id}`}>
                      {reputation === null ? (
                        "…"
                      ) : (seen.get(a.agent_id) ?? []).length === 0 ? (
                        <span className="c3">No validated outcomes yet</span>
                      ) : (
                        <div className="col g4">
                          {(seen.get(a.agent_id) ?? []).map((r) => (
                            <span key={r.category} className="small">
                              <span className="mono">{r.category}</span>: {percent(r.success_mean)} pass, about{" "}
                              {usdc(r.cost_mean_micros)} USDC a task, {r.value_density_per_usdc.toFixed(2)} passes per
                              USDC <span className="c3">({String(r.counted_outcomes)} validated)</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {reputation && (
          <p className="small c3">
            {reputation.note} Until an agent has validated outcomes, no figures are shown for it here: it would only be
            a configured starting point, not a record.
          </p>
        )}
      </section>
    </>
  );
}
