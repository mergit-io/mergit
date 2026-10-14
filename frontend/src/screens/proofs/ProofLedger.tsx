import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { paths } from "../../app/paths";
import { Spark } from "../../components/Spark";
import { useCountUp } from "../../hooks/useCountUp";
import { prefersReducedMotion } from "../../lib/motion";
import { CHAIN_LABEL, me } from "../../mock/data";
import {
  activityGrid,
  hourly,
  LEDGER_FIRST_BLOCK,
  ledgerStats,
  proofsPerBlock,
  settlementTrace,
  totalTasks,
  workByAgent,
} from "../../mock/ledger";
import { RunsChart, WorkRing } from "./charts";
import "../../styles/screens/ledger.css";

const BLOCK_MS = 1000;
/** Settlement rows land as pending, then confirm one by one. */
const TRACE_LAND_MS = 450;
const TRACE_CONFIRM_MS = 650;

function formatStat(value: number, format: "int" | "usd3") {
  return format === "usd3" ? `$${value.toFixed(3)}` : Math.round(value).toLocaleString("en-US");
}

function StatCard({ stat, index }: { stat: (typeof ledgerStats)[number]; index: number }) {
  const value = useCountUp(stat.value, 2000 + index * 150);
  return (
    <div className="card pl-stat rise" style={{ animationDelay: `${String(index * 70)}ms` }}>
      <div className="col g4">
        <span className="c2">{stat.label}</span>
        <span className="pl-stat-value">{formatStat(value, stat.format)}</span>
        <span className="small cm">{stat.sub}</span>
      </div>
      <Spark points={[...stat.trend]} color={stat.color} width={150} height={44} plain />
    </div>
  );
}

function useTicker(start: number, ms: number) {
  const [n, setN] = useState(start);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      setN((x) => x + 1);
    }, ms);
    return () => {
      window.clearInterval(timer);
    };
  }, [ms]);
  return n;
}

/** How many settlement rows are visible and how many have confirmed. */
function useTraceReveal(count: number) {
  const [reduced] = useState(prefersReducedMotion);
  const [landed, setLanded] = useState(reduced ? count : 0);
  const [confirmed, setConfirmed] = useState(reduced ? count : 0);
  useEffect(() => {
    if (reduced) return;
    const timers = [
      ...Array.from({ length: count }, (_, i) =>
        window.setTimeout(
          () => {
            setLanded(i + 1);
          },
          1500 + i * TRACE_LAND_MS,
        ),
      ),
      ...Array.from({ length: count }, (_, i) =>
        window.setTimeout(
          () => {
            setConfirmed(i + 1);
          },
          1500 + TRACE_CONFIRM_MS * 1.5 + i * TRACE_CONFIRM_MS,
        ),
      ),
    ];
    return () => {
      timers.forEach((t) => {
        window.clearTimeout(t);
      });
    };
  }, [count, reduced]);
  return { landed, confirmed };
}

export function ProofLedger() {
  const block = useTicker(LEDGER_FIRST_BLOCK, BLOCK_MS);
  const { landed, confirmed } = useTraceReveal(settlementTrace.length);
  const maxBar = Math.max(...proofsPerBlock);

  return (
    <>
      <div className="page-head">
        <div className="col g4">
          <h1 className="heading pl-title">Proof ledger &amp; analytics</h1>
          <p className="c2">
            {me.repo} · last 7 days · live from the {CHAIN_LABEL}
          </p>
        </div>
        <span className="chip raised pl-block" aria-live="off">
          <i className="pl-live" /> <span className="mono">{CHAIN_LABEL}</span> ·{" "}
          <span className="mono">Block {block.toLocaleString("en-US")}</span>
        </span>
      </div>

      <section className="pl-stats" aria-label="This week">
        {ledgerStats.map((stat, i) => (
          <StatCard key={stat.label} stat={stat} index={i} />
        ))}
      </section>

      <section className="pl-row">
        <div className="card pl-card rise" style={{ animationDelay: "200ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Runs &amp; settled proofs</h2>
              <span className="small c2">Hourly, last 28h</span>
            </div>
            <div className="row g16 small c2" aria-hidden="true">
              <span className="row g6">
                <i className="pl-key" style={{ background: "var(--chart-purple)" }} /> Runs
              </span>
              <span className="row g6">
                <i className="pl-key" style={{ background: "var(--chart-green)" }} /> Proofs settled
              </span>
            </div>
          </div>
          <RunsChart labels={hourly.labels} runs={hourly.runs} proofs={hourly.proofs} />
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "280ms" }}>
          <div className="col">
            <h2 className="title">Work by agent</h2>
            <span className="small c2">Share of completed tasks</span>
          </div>
          <div className="pl-work">
            <WorkRing parts={workByAgent} total={totalTasks} />
            <ul className="pl-legend">
              {workByAgent.map((p, i) => (
                <li key={p.name} className="rise" style={{ animationDelay: `${String(900 + i * 220)}ms` }}>
                  <i className="pl-key" style={{ background: p.color }} />
                  <span className="grow">{p.name}</span>
                  <span className="strong">{p.share}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="pl-row pl-row3">
        <div className="card pl-card rise" style={{ animationDelay: "360ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Proofs per block</h2>
              <span className="small c2">Settlement throughput</span>
            </div>
            <span className="badge b-ok">live</span>
          </div>
          <div
            className="pl-bars"
            role="img"
            aria-label={`Proofs settled in each of the last ${String(proofsPerBlock.length)} blocks`}
          >
            {proofsPerBlock.map((n, i) => (
              <i
                key={i}
                className={i === proofsPerBlock.length - 1 ? "now" : ""}
                style={{ height: `${String((n / maxBar) * 100)}%`, animationDelay: `${String(700 + i * 60)}ms` }}
              />
            ))}
          </div>
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "440ms" }}>
          <div className="col">
            <h2 className="title">Agent activity</h2>
            <span className="small c2">Tasks per hour · 7 days</span>
          </div>
          <div className="pl-heat" role="img" aria-label="Agent activity heatmap, 7 days by 24 hours">
            {activityGrid.flatMap((row, r) =>
              row.map((level, c) => (
                <i
                  key={`${String(r)}-${String(c)}`}
                  className={`l${String(level)}`}
                  style={{ animationDelay: `${String(1200 + c * 45 + r * 20)}ms` }}
                />
              )),
            )}
          </div>
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "520ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Settlement trace</h2>
              <span className="small c2">On-chain receipts</span>
            </div>
            <span className="mono-s c3">gas</span>
          </div>
          <ol className="pl-trace">
            {settlementTrace.slice(0, landed).map((s, i) => {
              const done = i < confirmed;
              const row = (
                <>
                  <span className="mono cz w-120">{s.tx}</span>
                  <span className="grow ellipsis">
                    <span className="mono">{s.call}</span> <span className="small c3">· {s.agent}</span>
                  </span>
                  <span className={`mono ${done ? "cm" : "ca"}`}>{done ? `✓ ${s.gas}` : "pending"}</span>
                </>
              );
              return (
                <li key={s.tx} className="rise">
                  {s.proofId && done ? (
                    <Link to={paths.proof(s.proofId)} className="pl-trace-row" aria-label={`Open receipt ${s.tx}`}>
                      {row}
                    </Link>
                  ) : (
                    <div className="pl-trace-row">{row}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </section>
    </>
  );
}
