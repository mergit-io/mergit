import { useState } from "react";
import { Link } from "react-router-dom";
import type { Address } from "viem";
import { formatEther } from "viem";
import { paths } from "../../app/paths";
import type { PlanState } from "../../api/types";
import { usePlans } from "../../api/usePlans";
import { isTrialSession } from "../../auth/account";
import { useAuth } from "../../auth/context";
import { useBalances } from "../../chain/useBalances";
import { useCommitments } from "../../chain/useCommitments";
import { useCredits } from "../../chain/useCredits";
import { formatUsdc } from "../../chain/funding";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { Spark } from "../../components/Spark";
import { LIVE } from "../../config/live";
import { stagger } from "../../lib/stagger";
import { dailySuccess, runsPerDay, successRate, timeAgo } from "./analytics";
import { DayBars, Meter } from "./charts";
import { PlanBadge } from "./run/badges";
import { summarizePlans } from "./overview";
import "../../styles/screens/overview.css";
import "../../styles/screens/live-run.css";
import "../../styles/screens/live-charts.css";

const RECENT = 6;
const NEEDS_YOU = 3;
const TREND_DAYS = 14;

const FILTERS = ["All", "Running", "Needs you", "Failed"] as const;
type Filter = (typeof FILTERS)[number];

const MATCH: Record<Filter, (s: PlanState) => boolean> = {
  All: () => true,
  Running: (s) => s === "funded" || s === "running",
  "Needs you": (s) => s === "draft" || s === "approved",
  Failed: (s) => s === "failed",
};

/** What a plan in each state waits on the requester for, and the button that does it. */
const ASK: Partial<Record<PlanState, { what: string; action: string }>> = {
  draft: { what: "draft to review", action: "Review plan" },
  approved: { what: "awaiting funds", action: "Fund it" },
};

/** The dashboard on live data, laid out as the design: stat cards, recent runs, what needs you, and activity. */
export function LiveOverview() {
  const { session, account } = useAuth();
  const creditsFor = (session?.address ?? null) as Address | null;
  // A free-trial account has no wallet to read balances from; its credits are under the trial address.
  const trial = isTrialSession(account, session?.address);
  const balances = useBalances(trial ? null : creditsFor);
  const { credits, error: creditsError } = useCredits(creditsFor !== null);
  const { plans, error: plansError } = usePlans();
  const { rows: receipts, error: receiptsError } = useCommitments();
  const [filter, setFilter] = useState<Filter>("All");

  // Every chart is drawn from these and nothing else: an empty account gets empty charts, never sample data.
  const mine = plans ?? [];
  const counts = plans ? summarizePlans(plans) : null;
  const latest = receipts?.[0];
  const trend = runsPerDay(mine, TREND_DAYS);
  const week = trend.slice(-7);
  const rate = successRate(mine);
  const finished = counts ? counts.done + counts.failed : 0;
  const spentShare = credits && credits.granted > 0n ? Number(credits.spent) / Number(credits.granted) : 0;
  const visible = mine.filter((p) => MATCH[filter](p.state)).slice(0, RECENT);
  const asks = mine.filter((p) => ASK[p.state]).slice(0, NEEDS_YOU);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Everything here is read live from your account, the Mergit services and ${LIVE.chainName}.`}
        actions={
          <Button variant="primary" icon="plus" to={paths.newRun}>
            New run
          </Button>
        }
      />

      <section className="ov-stats">
        <div className="card pad24 col between mesh ov-stat">
          <div className="row between">
            <Badge status="Verified" label="Receipts on chain" />
            <Link to={paths.proofs} className="link">
              Open ledger <Icon name="arrowUp" size={14} />
            </Link>
          </div>
          <div className="col g4">
            <div className="row g10 items-base">
              <span className="ov-big" data-testid="receipt-count">
                {receiptsError ? "?" : receipts ? receipts.length : "…"}
              </span>
              <span className="title c2 medium">committed on {LIVE.chainName}</span>
            </div>
            <div className="small c2">
              {receiptsError
                ? `Could not read the registry on ${LIVE.chainName} right now.`
                : latest
                  ? `Latest at block ${latest.blockNumber.toString()}, task ${latest.taskId.slice(0, 10)}…`
                  : "No receipts committed yet. One appears here once an agent finishes a task."}
            </div>
          </div>
          <span className="small c3">All agents, read from the ReceiptRegistry contract.</span>
        </div>

        <div className="card pad24 col between ov-stat">
          <div className="row between">
            <span className="c2 strong">Runs</span>
            <Link to={paths.runs} aria-label="All runs" className="c3">
              <Icon name="arrowUp" size={16} />
            </Link>
          </div>
          <div className="row between items-end g8">
            <div className="col g4 min0">
              <span className="stat" data-testid="run-count">
                {plansError ? "?" : counts ? counts.total : "…"}
              </span>
              <span className="small c3">
                {counts
                  ? `${String(counts.active)} in progress, ${String(counts.done)} done`
                  : plansError
                    ? "Could not load your runs."
                    : "Loading…"}
              </span>
            </div>
            <span className="lc-spark" title={`Runs started per day, last ${String(TREND_DAYS)} days`}>
              <Spark points={trend.map((d) => d.started)} />
            </span>
          </div>
        </div>

        <div className="card pad24 col between ov-stat">
          <div className="row between">
            <span className="c2 strong">Success rate</span>
            <Link to={paths.runs} aria-label="All runs" className="c3">
              <Icon name="arrowUp" size={16} />
            </Link>
          </div>
          <div className="row between items-end g8">
            <div className="col g4 min0">
              <span className="stat" data-testid="success-rate">
                {rate === null ? "—" : `${String(Math.round(rate * 100))}%`}
              </span>
              <span className="small c3">
                {finished > 0 ? `${String(counts?.done ?? 0)} of ${String(finished)} finished` : "No finished runs yet"}
              </span>
            </div>
            <span className="lc-spark" title={`Share of finished runs done, per day, last ${String(TREND_DAYS)} days`}>
              <Spark points={dailySuccess(trend)} />
            </span>
          </div>
        </div>

        <div className="card pad24 col between ov-stat">
          <span className="c2 strong">Free credits</span>
          <div className="col g4">
            <span className="stat" data-testid="credits-remaining">
              {creditsError ? "?" : credits ? formatUsdc(credits.remaining) : "…"}
            </span>
            <Meter share={spentShare} color="var(--chart-purple)" label="Share of free credits spent" />
          </div>
          {trial ? (
            <span className="small c3">
              No wallet.{" "}
              <Link to={paths.wallet} className="link">
                Connect a wallet
              </Link>{" "}
              to pay with your own test USDC.
            </span>
          ) : (
            <span className="small c3">
              Wallet{" "}
              <span className="c2" data-testid="usdc-balance">
                {balances ? formatUsdc(balances.usdc) : "…"}
              </span>{" "}
              test USDC, {balances ? Number(formatEther(balances.eth)).toFixed(4) : "…"} ETH
            </span>
          )}
        </div>
      </section>

      <section className="ov-bottom fill">
        <div className="card col min0">
          <div className="hd">
            <h2 className="title">Recent runs</h2>
            <div className="row g12">
              <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter runs" />
              <Link to={paths.runs} className="link">
                View all
              </Link>
            </div>
          </div>
          <div className="tbl-h">
            <span className="grow">Run</span>
            <span className="w-90 hide-md text-right">Budget</span>
            <span className="w-84 hide-sm">Started</span>
            <span className="w-130 ov-status">Status</span>
          </div>
          <div className="scroll">
            {visible.map((p, i) => (
              <Link key={`${filter}-${p.plan_uuid}`} to={paths.run(p.plan_uuid)} className="tr rise" style={stagger(i)}>
                <div className="col grow min0">
                  <span className="strong ellipsis">{p.goal}</span>
                  <span className="small c3">
                    <span className="mono-s">{p.plan_uuid.slice(0, 8)}</span>&nbsp; {p.category}
                  </span>
                </div>
                <span className="w-90 hide-md mono c2 text-right">{formatUsdc(BigInt(p.budget_usdc_units))}</span>
                <span className="w-84 small c2 hide-sm">{timeAgo(p.created_at)}</span>
                <span className="w-130 ov-status">
                  <PlanBadge state={p.state} />
                </span>
              </Link>
            ))}
            {visible.length === 0 && (
              <div className="lc-table-empty">
                <p className="small c2">
                  {plansError
                    ? plansError
                    : plans === null
                      ? "Loading your runs…"
                      : mine.length === 0
                        ? "No runs yet. Start one to see it here."
                        : "No runs match this filter."}
                </p>
                {/* Placeholder rows keep the table's shape; they hold no data. */}
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="tr lc-ghost-row" aria-hidden="true">
                    <span className="lc-ghost-cell">
                      <i className="lc-ghost-line" style={{ width: `${String(46 - i * 6)}%` }} />
                      <i className="lc-ghost-line" style={{ width: "18%" }} />
                    </span>
                    <i className="lc-ghost-line lc-ghost-when hide-sm" />
                    <i className="lc-ghost-pill" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col g16 min0">
          <div className="card pad col g12">
            <div className="row between">
              <h2 className="title">Needs you</h2>
              {asks.length > 0 ? (
                <Badge status="Waiting" label={`${String(asks.length)} waiting`} />
              ) : (
                <Badge status="Completed" label="All clear" />
              )}
            </div>
            {asks.map((p, i) => {
              const ask = ASK[p.state];
              return ask ? (
                <div key={p.plan_uuid} className="inner pad-md col g8 rise" style={stagger(i)}>
                  <div className="row between ov-ask-head">
                    <span className="mono">{ask.what}</span>
                    <span className="mono-s c3">{timeAgo(p.created_at)}</span>
                  </div>
                  <span className="small c2 ellipsis">{p.goal}</span>
                  <div className="row g8">
                    <Button variant="primary" compact to={paths.run(p.plan_uuid)}>
                      {ask.action}
                    </Button>
                  </div>
                </div>
              ) : null;
            })}
            {asks.length === 0 && (
              <p className="small c3">Nothing is waiting on you. Drafts to review and plans to fund show up here.</p>
            )}
          </div>

          <div className="card pad col g12 ov-activity">
            <div className="row between">
              <h2 className="title">Run activity</h2>
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
            <DayBars
              days={week}
              bars={[
                { name: "Completed", color: "var(--ink)" },
                { name: "Failed", color: "var(--fail-bar)" },
              ]}
              values={week.map((d) => [d.done, d.failed])}
              caption="Runs completed and failed this week, by the day they started"
              empty="No finished runs this week yet."
            />
          </div>
        </div>
      </section>
    </>
  );
}
