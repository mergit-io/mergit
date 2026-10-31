import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { agentName, useAgents } from "../../api/useAgents";
import { PageHeader } from "../../components/PageHeader";
import { Spark } from "../../components/Spark";
import { listCommitments, type Commitment } from "../../chain/proofs";
import { LIVE } from "../../config/live";
import { useCountUp } from "../../hooks/useCountUp";
import { costTrend, receiptsByAgent, receiptsPerBlock, totalCost } from "./analytics";
import { BlockBars, ShareLegend, ShareRing } from "./charts";

const usd = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(4)}`;

function StatCard({
  label,
  value,
  format,
  sub,
  trend,
  color,
  index,
}: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  sub: string;
  trend: number[];
  color: string;
  index: number;
}) {
  const shown = useCountUp(value ?? 0, 1400 + index * 150);
  return (
    <div className="card pl-stat rise" style={{ animationDelay: `${String(index * 70)}ms` }}>
      <div className="col g4 min0">
        <span className="c2">{label}</span>
        <span className="pl-stat-value">{value === null ? "…" : format(shown)}</span>
        <span className="small c3">{sub}</span>
      </div>
      <span className="lc-spark">
        {/* A flat line until there is something to plot, so the card keeps its shape. */}
        <Spark points={trend.length > 1 ? trend : [0, 0]} color={color} width={120} height={44} plain />
      </span>
    </div>
  );
}

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const dollars = (n: number) => `$${n.toFixed(4)}`;

/** Every receipt committed on chain, read straight from the ReceiptRegistry contract. */
export function LiveProofLedger() {
  const [rows, setRows] = useState<Commitment[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    listCommitments().then(setRows, () => {
      setError(`Could not read receipts from ${LIVE.chainName}. Try again in a moment.`);
    });
  }, []);

  const { agents } = useAgents();
  const list = rows ?? [];
  const blocks = receiptsPerBlock(list, 24);
  const costs = costTrend(list);
  const total = totalCost(list);
  const byAgent = receiptsByAgent(list, (id) => agentName(agents, id));
  const loaded = rows !== null;
  const cumulative = costs.map((_, i) => costs.slice(0, i + 1).reduce((a, b) => a + b, 0));

  return (
    <>
      <PageHeader
        title="Proofs"
        subtitle={`Receipts committed on ${LIVE.chainName}. Open one to verify it in your browser.`}
      />

      <section className="pl-stats" aria-label="Receipts so far">
        <StatCard
          index={0}
          label="Receipts committed"
          value={loaded ? list.length : null}
          format={count}
          sub={blocks.length > 0 ? `across ${String(blocks.length)} blocks` : "none yet"}
          trend={blocks.map((b) => b.receipts)}
          color="var(--chart-purple)"
        />
        <StatCard
          index={1}
          label="Metered cost"
          value={loaded ? total : null}
          format={dollars}
          sub="total, as committed"
          trend={cumulative}
          color="var(--chart-green)"
        />
        <StatCard
          index={2}
          label="Avg cost / receipt"
          value={loaded ? (list.length > 0 ? total / list.length : 0) : null}
          format={dollars}
          sub="per task attempt"
          trend={costs}
          color="var(--chart-yellow)"
        />
        <StatCard
          index={3}
          label="Agents"
          value={loaded ? new Set(list.map((c) => c.agentId)).size : null}
          format={count}
          sub="with a receipt on chain"
          trend={byAgent.map((p) => p.count)}
          color="var(--chart-rose)"
        />
      </section>

      <section className="pl-row">
        <div className="card pl-card rise" style={{ animationDelay: "200ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Receipts per block</h2>
              <span className="small c2">Latest blocks with a receipt, newest on the right</span>
            </div>
            {blocks.length > 0 && <span className="badge b-ok">live</span>}
          </div>
          <BlockBars blocks={blocks} slots={32} />
        </div>
        <div className="card pl-card rise" style={{ animationDelay: "280ms" }}>
          <div className="col">
            <h2 className="title">Work by agent</h2>
            <span className="small c2">Share of receipts committed</span>
          </div>
          <div className="pl-work">
            <ShareRing parts={byAgent} unit="receipts" />
            {byAgent.length > 0 ? (
              <ShareLegend parts={byAgent} />
            ) : (
              <p className="small c3 grow">Each agent's share shows here once it commits a receipt.</p>
            )}
          </div>
        </div>
      </section>
      <section className="card pad24">
        {error && <p className="c2">{error}</p>}
        {!error && rows === null && <p className="c2">Reading the chain…</p>}
        {rows?.length === 0 && <p className="c2">No receipts committed yet. Run a task to see its receipt here.</p>}
        {rows && rows.length > 0 && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Agent</th>
                <th scope="col">Metered cost</th>
                <th scope="col">Block</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.taskId}>
                  <td>
                    <Link className="mono" to={`/app/proofs/${c.taskId}`}>
                      {c.taskId.slice(0, 10)}…{c.taskId.slice(-6)}
                    </Link>
                  </td>
                  <td>Agent {c.agentId.toString()}</td>
                  <td>{usd(c.costMicros)}</td>
                  <td className="mono">{c.blockNumber.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
