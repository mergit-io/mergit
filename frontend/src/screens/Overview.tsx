import { paths } from "../app/paths";
import { useState } from "react";
import { Link } from "react-router-dom";
import { AgentAvatar, AvatarStack } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Spark } from "../components/Spark";
import { stagger } from "../lib/stagger";
import { countPhrase } from "../lib/words";
import { CHAIN_LABEL, activity, me, overviewStats, runs, weekSummary, type Status } from "../mock/data";
import { useApprovals } from "../state/approvals";
import "../styles/screens/overview.css";

const FILTERS = ["All", "Running", "Needs you", "Failed"] as const;
type Filter = (typeof FILTERS)[number];

const MATCH: Record<Filter, (status: Status) => boolean> = {
  All: () => true,
  Running: (s) => s === "Running",
  "Needs you": (s) => s === "Waiting",
  Failed: (s) => s === "Failed",
};

/** Pixels per task in the activity chart; the tallest day fits the 64px plot. */
const BAR_SCALE = 4;
const MIN_FAIL_BAR = 5;

export function Overview() {
  const [filter, setFilter] = useState<Filter>("All");
  const { items, waiting, resolve, dismiss } = useApprovals();
  const visible = runs.filter((r) => MATCH[filter](r.status));

  return (
    <>
      <PageHeader
        title={`Good morning, ${me.name}`}
        subtitle={`Your agents settled ${weekSummary.proofsSettled} proofs this week. ${countPhrase(waiting, "action")} ${
          waiting === 1 ? "is" : "are"
        } waiting on you.`}
        actions={
          <>
            <Button icon="clock">Last 7 days</Button>
            <Button variant="primary" icon="plus" to={paths.newRun}>
              New run
            </Button>
          </>
        }
      />

      <section className="ov-stats">
        <div className="card pad24 col between mesh ov-stat">
          <div className="row between">
            <Badge status="Verified" label="Verified receipts" />
            <Link to={paths.wallet} className="link">
              Open ledger <Icon name="arrowUp" size={14} />
            </Link>
          </div>
          <div className="col g4">
            <div className="row g10 items-base">
              <span className="ov-big">{weekSummary.proofsSettled}</span>
              <span className="title c2 medium">proofs settled on {CHAIN_LABEL}</span>
            </div>
            <div className="row g8 c2 small ov-latest">
              Latest <span className="mono ink">{weekSummary.latestTx}</span> at block{" "}
              {/* Grouped so the time wraps with its block on a phone; the gap matches the design. */}
              <span className="row g8">
                <span className="mono ink">{weekSummary.latestBlock}</span>, {weekSummary.latestAgo}
              </span>
            </div>
          </div>
          <div className="row g8">
            <AvatarStack agents={weekSummary.contributors} />
            <span className="small c2">
              {weekSummary.contributors.length} agents contributed, {weekSummary.silentFailures} silent failures
            </span>
          </div>
        </div>
        {overviewStats.map((s) => (
          <div key={s.label} className="card pad24 col between ov-stat">
            <div className="row between">
              <span className="c2 strong">{s.label}</span>
              <Icon name="arrowUp" size={16} color="var(--ink3)" />
            </div>
            <div className="row between items-end">
              <div className="col g4">
                <span className="stat">{s.value}</span>
                <span className={`small ${s.sub.startsWith("+") ? "cm" : "c3"}`}>{s.sub}</span>
              </div>
              <Spark points={s.trend} />
            </div>
          </div>
        ))}
      </section>

      <section className="ov-bottom fill">
        <div className="card col min0">
          <div className="hd">
            <h2 className="title">Recent runs</h2>
            <div className="row g12">
              <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter runs" />
              <Button variant="link">View all</Button>
            </div>
          </div>
          <div className="tbl-h">
            <span className="grow">Run</span>
            <span className="w-130 hide-md">Agents</span>
            <span className="w-90 hide-md">Apps</span>
            <span className="w-84 hide-sm">Started</span>
            <span className="w-130">Status</span>
          </div>
          <div className="scroll">
            {visible.map((r, i) => (
              <Link key={`${filter}-${r.id}`} to={paths.run(r.id)} className="tr rise" style={stagger(i)}>
                <div className="col grow">
                  <span className="strong ellipsis">{r.title}</span>
                  <span className="small c3">
                    <span className="mono-s">{r.id}</span>&nbsp;&nbsp;{r.source}
                  </span>
                </div>
                <span className="w-130 hide-md">
                  <AvatarStack agents={r.agents} />
                </span>
                <span className="w-90 row g4 hide-md">
                  {r.apps.map((a) => (
                    <span key={a} className="app-tag">
                      {a}
                    </span>
                  ))}
                </span>
                <span className="w-84 small c2 hide-sm">{r.started}</span>
                <span className="w-130">
                  <Badge status={r.status} />
                </span>
              </Link>
            ))}
            {visible.length === 0 && <p className="small c3 empty">No runs match this filter.</p>}
          </div>
        </div>

        <div className="col g16 min0">
          <div className="card pad col g12">
            <div className="row between">
              <h2 className="title">Needs you</h2>
              {waiting > 0 ? (
                <Badge status="Waiting" label={`${waiting} waiting`} />
              ) : (
                <Badge status="Completed" label="All clear" />
              )}
            </div>
            {items.map((a) => (
              <div key={a.id} className="inner pad-md col g8 rise">
                <div className="row between">
                  <span className="mono">{a.tool}</span>
                  <span className={`mono-s ${a.remaining > 0 ? "ca" : "c3"}`}>
                    {a.remaining > 0 ? `expires ${a.remaining}s` : "expired"}
                  </span>
                </div>
                <span className="small c2">{a.summary}</span>
                <div className="row g8">
                  {a.remaining > 0 ? (
                    <>
                      <Button
                        variant="primary"
                        compact
                        onClick={() => {
                          resolve(a.id, true);
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        compact
                        onClick={() => {
                          resolve(a.id, false);
                        }}
                      >
                        Deny
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="small c3">No answer, so the task stopped.</span>
                      <Button
                        variant="link"
                        onClick={() => {
                          dismiss(a.id);
                        }}
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                  <span className="grow" />
                  <AgentAvatar kind={a.agent} size={20} labelled />
                </div>
              </div>
            ))}
            {items.length === 0 && <p className="small c3">Nothing is waiting on you. New asks show up here.</p>}
          </div>

          <div className="card pad col g12 ov-activity">
            <div className="row between">
              <h2 className="title">Task activity</h2>
              <div className="row g12 small c2" aria-hidden="true">
                <span className="row g6">
                  <i className="legend done" />
                  Completed
                </span>
                <span className="row g6">
                  <i className="legend failed" />
                  Failed
                </span>
              </div>
            </div>
            <div className="ov-chart" aria-hidden="true">
              {activity.map((d, i) => (
                <div key={d.day} className="ov-bar-group">
                  <i className="ov-bar done" style={stagger(i, { height: d.completed * BAR_SCALE })} />
                  {d.failed > 0 && (
                    <i
                      className="ov-bar failed"
                      style={stagger(i, { height: Math.max(d.failed * BAR_SCALE, MIN_FAIL_BAR) })}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="row between small c3 ov-days" aria-hidden="true">
              {activity.map((d) => (
                <span key={d.day}>{d.day}</span>
              ))}
            </div>
            <table className="sr-only">
              <caption>Tasks per day this week</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Failed</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((d) => (
                  <tr key={d.day}>
                    <th scope="row">{d.day}</th>
                    <td>{d.completed}</td>
                    <td>{d.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
