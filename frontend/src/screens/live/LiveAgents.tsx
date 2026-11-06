import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAgents } from "../../api/useAgents";
import { byAgent, percent, usdc } from "../../api/reputation";
import { useReputation } from "../../api/useReputation";
import type { AgentInfo, AgentReputation } from "../../api/types";
import { identityAbi } from "../../chain/abi";
import { publicClient } from "../../chain/client";
import { EnsIdentity } from "../../components/EnsIdentity";
import { PageHeader } from "../../components/PageHeader";
import { LIVE } from "../../config/live";
import "../../styles/screens/agents.css";

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

/** An address read from the Identity contract: a link once read, "unavailable" if the read failed, "…" before. */
function ChainAddress({ value, pick }: { value: Onchain | null | undefined; pick: (c: Onchain) => Address }) {
  if (value === undefined) return <span className="c3">…</span>;
  if (value === null) return <span className="c3">unavailable</span>;
  return <AddressLink address={pick(value)} />;
}

/**
 * Only categories with counted outcomes. A row with none holds the prior, which is configuration and not a measurement
 * (CLAUDE.md: no number may be presented as measured), so it is not shown as a record.
 */
const validated = (rows: AgentReputation[] | undefined): AgentReputation[] =>
  (rows ?? []).filter((r) => r.counted_outcomes > 0);

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
      {error && <p className="c2">{error}</p>}
      {!error && agents === null && <p className="c2">Loading agents…</p>}
      {agents?.length === 0 && <p className="c2">No agents are deployed yet.</p>}
      {agents && agents.length > 0 && (
        <ul className="ag-grid la-grid">
          {agents.map((a) => {
            const chain = onchain[a.agent_id];
            const record = validated(seen.get(a.agent_id));
            return (
              <li key={a.agent_id} className="card ag-card la-card" data-testid={`agent-${a.agent_id}`}>
                <div className="row g12 la-head">
                  <div className="col min0 grow">
                    <h3 className="title la-name">{a.name}</h3>
                    <span className="mono small c3">Agent #{a.agent_id}</span>
                  </div>
                  <span className="mono small la-model" title={a.model}>
                    {a.model}
                  </span>
                </div>

                <EnsIdentity agentId={a.agent_id} name={a.name} showReason />

                <dl className="la-facts">
                  <dt className="small c3">Owner (paid)</dt>
                  <dd>
                    <ChainAddress value={chain} pick={(c) => c.operator} />
                  </dd>
                  <dt className="small c3">Signs receipts</dt>
                  <dd>
                    <ChainAddress value={chain} pick={(c) => c.runtimeKey} />
                  </dd>
                </dl>

                <div className="col g6 la-record" data-testid={`record-${a.agent_id}`}>
                  {reputation === null ? (
                    <span className="small c3">…</span>
                  ) : record.length === 0 ? (
                    <span className="small c3">No validated outcomes yet</span>
                  ) : (
                    record.map((r) => (
                      <div key={r.category} className="col g4 la-record-row">
                        <span className="row between g8 small">
                          <span className="mono strong">{r.category}</span>
                          <span className="c3">{String(r.counted_outcomes)} validated</span>
                        </span>
                        <span className="small c2">
                          {percent(r.success_mean)} pass · about {usdc(r.cost_mean_micros)} USDC a task ·{" "}
                          {r.value_density_per_usdc.toFixed(2)} passes per USDC
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {reputation && (
        <p className="small c3 la-note">
          {reputation.note} Until an agent has validated outcomes, no figures are shown for it here: they would only be
          a configured starting point, not a record.
        </p>
      )}
    </>
  );
}
