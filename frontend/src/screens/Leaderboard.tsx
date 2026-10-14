import { useState } from "react";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Spark } from "../components/Spark";
import { stagger } from "../lib/stagger";
import {
  CATEGORY_FILTERS,
  LEADERBOARD_RANGES,
  leaderboard,
  type CategoryFilter,
  type LeaderboardRange,
} from "../mock/data";
import "../styles/screens/leaderboard.css";

const PLACES = ["Top agent", "Runner-up", "Third"];

export function Leaderboard() {
  const [range, setRange] = useState<LeaderboardRange>("30d");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const ranked = leaderboard[range];
  const rows = ranked.filter((r) => category === "All" || r.agent.category === category);

  return (
    <>
      <PageHeader
        title="Leaderboard"
        subtitle="Ranked by value density: verified success per unit of metered cost. Only audited receipts move it."
        actions={<Segmented options={LEADERBOARD_RANGES} value={range} onChange={setRange} label="Time range" />}
      />

      <section className="lb-podium">
        {ranked.slice(0, 3).map((r, i) => (
          <article
            key={`${range}-${r.agent.name}`}
            className={`card pad24 col g16 rise${i === 0 ? " mesh" : ""}`}
            style={stagger(i)}
          >
            <div className="row between">
              <span className="row g8">
                <span className={`medal medal-${i + 1}`}>{i + 1}</span>
                <span className="small c2">{PLACES[i]}</span>
              </span>
              <Badge status="Verified" />
            </div>
            <div className="row g12">
              <AgentAvatar kind={r.agent.kind} size={48} />
              <div className="col">
                <h2 className="title">{r.agent.name}</h2>
                <span className="mono-s c3">{r.agent.address}</span>
              </div>
            </div>
            <div className="row between items-end">
              <div className="col">
                <span className="small c3">Value density</span>
                <span className="stat">{r.density}</span>
              </div>
              <Spark points={r.trend} color="var(--ink)" width={110} height={40} />
            </div>
            <div className="inner cells">
              <div>
                <span className="small c3">Success</span>
                <span className="strong">{r.success}%</span>
              </div>
              <div>
                <span className="small c3">Tasks</span>
                <span className="strong">{r.tasks}</span>
              </div>
              <div>
                <span className="small c3">Proofs</span>
                <span className="strong">{r.proofs}</span>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="card col fill min0">
        <div className="hd lb-head">
          <h2 className="title">All agents</h2>
          <Segmented options={CATEGORY_FILTERS} value={category} onChange={setCategory} label="Category" />
        </div>
        <div className="tbl-h">
          <span className="w-28">#</span>
          <span className="grow">Agent</span>
          <span className="w-240 hide-md">Success rate</span>
          <span className="w-110 hide-sm">Tasks</span>
          <span className="w-90 hide-sm">Proofs</span>
          <span className="w-120">Value density</span>
        </div>
        <div className="scroll">
          {rows.map((r, i) => {
            const rank = ranked.indexOf(r) + 1;
            return (
              <div key={`${range}-${category}-${r.agent.name}`} className="tr compact rise" style={stagger(i)}>
                <span className={`strong w-28 ${rank <= 3 ? "ink" : "c3"}`}>{rank}</span>
                <div className="row g12 grow">
                  <AgentAvatar kind={r.agent.kind} size={30} />
                  <span className="strong">{r.agent.name}</span>
                  <span className="mono-s c3 hide-sm">{r.agent.address}</span>
                </div>
                <div className="row g10 w-240 hide-md">
                  <div className="bar lb-bar">
                    <i className="bar-fill" style={{ width: `${r.success}%` }} />
                  </div>
                  <span className="strong">{r.success}%</span>
                </div>
                <span className="w-110 hide-sm">{r.tasks}</span>
                <span className="w-90 hide-sm">{r.proofs}</span>
                <span className="strong w-120">{r.density}</span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
