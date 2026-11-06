import { useState } from "react";
import { percent, usdc } from "../../api/reputation";
import { useAgents } from "../../api/useAgents";
import { useReputation } from "../../api/useReputation";
import { AgentAvatar } from "../../components/AgentAvatar";
import { AgentIdentity } from "../../components/AgentIdentity";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { stagger } from "../../lib/stagger";
import { categoriesOf, rankAgents, weightedMean, type RankedAgent } from "./leaderboard";
import "../../styles/screens/leaderboard.css";

const PLACES = ["Top agent", "Runner-up", "Third"];

const success = (r: RankedAgent) => percent(weightedMean(r.categories, (c) => c.success_mean));
const cost = (r: RankedAgent) => usdc(weightedMean(r.categories, (c) => c.cost_mean_micros));
const density = (r: RankedAgent) => r.valueDensity.toFixed(2);

/** The agent's ENS name and badge beside its name. Display only (E11): drawn after ranking, it never changes it. */
function Identity({ r }: { r: RankedAgent }) {
  return /^\d+$/.test(r.agentId) ? <AgentIdentity agent={{ agentId: BigInt(r.agentId), name: r.name }} /> : null;
}

/** The platform's public reputation, ranked by value density. Rank and order come only from `rankAgents`. */
export function LiveLeaderboard() {
  const { reputation, error } = useReputation();
  const { agents } = useAgents();
  const [category, setCategory] = useState("All");
  const rows = reputation?.agents ?? [];
  const categories = categoriesOf(rows);
  const active = categories.includes(category) ? category : "All";
  const ranked = rankAgents(rows, active);
  const model = (agentId: string) => agents?.find((a) => a.agent_id === agentId)?.model;

  return (
    <>
      <PageHeader
        title="Leaderboard"
        subtitle="Ranked by value density: verified success per unit of metered cost. Only audited receipts move it."
      />

      {ranked.length > 0 && (
        <section className="lb-podium" aria-label="Top agents">
          {ranked.slice(0, 3).map((r, i) => (
            <article
              key={`${active}-${r.agentId}`}
              className={`card pad24 col g16 rise${i === 0 ? " mesh" : ""}`}
              style={stagger(i)}
            >
              <div className="row g8">
                <span className={`medal medal-${String(i + 1)}`} aria-hidden="true">
                  {i + 1}
                </span>
                <span className="small c2">{PLACES[i]}</span>
              </div>
              <div className="row g12">
                <AgentAvatar kind="Coder" size={48} />
                <div className="col">
                  <h2 className="title">{r.name}</h2>
                  <span className="mono-s c3">
                    #{r.agentId}
                    {model(r.agentId) ? ` · ${model(r.agentId) ?? ""}` : ""}
                  </span>
                  <Identity r={r} />
                </div>
              </div>
              <div className="col">
                <span className="small c3">Value density (passes per USDC)</span>
                <span className="stat">{density(r)}</span>
              </div>
              <div className="inner cells">
                <div>
                  <span className="small c3">Success</span>
                  <span className="strong">{success(r)}</span>
                </div>
                <div>
                  <span className="small c3">Validated</span>
                  <span className="strong">{r.countedOutcomes}</span>
                </div>
                <div>
                  <span className="small c3">Cost a task</span>
                  <span className="strong">{cost(r)} USDC</span>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="card col fill min0 lb-table">
        <div className="hd lb-head">
          <h2 className="title">All agents</h2>
          <Segmented options={categories} value={active} onChange={setCategory} label="Category" />
        </div>
        {error && <p className="pad24 c2">{error}</p>}
        {!error && reputation === null && <p className="pad24 c2">Loading the leaderboard…</p>}
        {reputation && ranked.length === 0 && <p className="pad24 c2">No agent has validated outcomes yet.</p>}
        {ranked.length > 0 && (
          <>
            <div className="tbl-h" aria-hidden="true">
              <span className="w-28">#</span>
              <span className="grow">Agent</span>
              <span className="w-240 hide-md">Success rate</span>
              <span className="w-110 hide-sm">Validated</span>
              <span className="w-90 hide-sm">Cost a task</span>
              <span className="w-120">Value density</span>
            </div>
            <ol
              className="scroll"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
              aria-label={`Agents ranked by value density, ${active}`}
            >
              {ranked.map((r, i) => {
                const rank = i + 1;
                return (
                  <li
                    key={`${active}-${r.agentId}`}
                    className="tr compact rise"
                    style={stagger(i)}
                    data-testid={`rank-${r.agentId}`}
                  >
                    <span className={`strong w-28 ${rank <= 3 ? "ink" : "c3"}`}>
                      <span className="sr-only">Rank </span>
                      {rank}
                    </span>
                    <div className="row g12 grow">
                      <AgentAvatar kind="Coder" size={30} />
                      <span className="strong">{r.name}</span>
                      <span className="mono-s c3 hide-sm">#{r.agentId}</span>
                      <span className="hide-sm">
                        <Identity r={r} />
                      </span>
                    </div>
                    <div className="row g10 w-240 hide-md">
                      <div className="bar lb-bar" aria-hidden="true">
                        <i className="bar-fill" style={{ width: success(r) }} />
                      </div>
                      <span className="strong">
                        <span className="sr-only">Success rate </span>
                        {success(r)}
                      </span>
                    </div>
                    <span className="w-110 hide-sm">
                      <span className="sr-only">Validated outcomes </span>
                      {r.countedOutcomes}
                    </span>
                    <span className="w-90 hide-sm">
                      <span className="sr-only">Cost a task </span>
                      {cost(r)}
                    </span>
                    <span className="strong w-120">
                      <span className="sr-only">Value density </span>
                      {density(r)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {reputation && <p className="pad24 small c3">{reputation.note}</p>}
      </section>
    </>
  );
}
