import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Address } from "viem";
import { formatEther } from "viem";
import { paths } from "../../app/paths";
import { errorMessage, getPlan } from "../../api/client";
import type { PlanDetail } from "../../api/types";
import { agentName, useAgents } from "../../api/useAgents";
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
import { Spark } from "../../components/Spark";
import { LIVE } from "../../config/live";
import { hourlyActivity, receiptsPerBlock, runsByState, runsPerDay, successRate } from "./analytics";
import { AreaTrend, BlockBars, DayBars, HourHeatmap, Meter, ShareLegend, ShareRing } from "./charts";
import { PlanBadge } from "./run/badges";
import { TaskFlow, TaskFlowEmpty } from "./run/TaskFlow";
import { summarizePlans } from "./overview";
import "../../styles/screens/overview.css";
import "../../styles/screens/ledger.css";
import "../../styles/screens/run.css";
import "../../styles/screens/live-run.css";
import "../../styles/screens/live-charts.css";

const RECENT = 5;
const TREND_DAYS = 14;
const TRACE = 5;
const usd = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(4)}`;
const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/** One plan's detail, fetched once (the run page keeps it live; the overview only needs a look). */
function usePlanDetail(planUuid: string | null) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!planUuid) return;
    let active = true;
    getPlan(planUuid).then(
      (d) => {
        if (active) setDetail(d);
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, [planUuid]);
  return { detail: detail?.plan_uuid === planUuid ? detail : null, error };
}

/** The dashboard on live data: your credits and balances, your runs, and the receipts committed on chain. */
export function LiveOverview() {
  const { session, account } = useAuth();
  const creditsFor = (session?.address ?? null) as Address | null;
  // A free-trial account has no wallet to read balances from; its credits are under the trial address.
  const trial = isTrialSession(account, session?.address);
  const balances = useBalances(trial ? null : creditsFor);
  const { credits, error: creditsError } = useCredits(creditsFor !== null);
  const { plans, error: plansError } = usePlans();
  const { rows: receipts, error: receiptsError } = useCommitments();
  const { agents } = useAgents();
  const counts = plans ? summarizePlans(plans) : null;
  const latest = receipts?.[0];
  const latestPlan = plans?.[0] ?? null;
  const { detail: latestDetail, error: latestError } = usePlanDetail(latestPlan?.plan_uuid ?? null);
  // Every chart below is drawn from these, and from nothing else: an empty account gets empty charts.
  const mine = plans ?? [];
  const trend = runsPerDay(mine, TREND_DAYS);
  const week = trend.slice(-7);
  const rate = successRate(mine);
  const heat = hourlyActivity(mine);
  const blocks = receiptsPerBlock(receipts ?? [], 24);
  const spentShare = credits && credits.granted > 0n ? Number(credits.spent) / Number(credits.granted) : 0;

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
                  : "None yet. A receipt appears here once an agent finishes a task."}
            </div>
          </div>
          <span className="small c3">All agents, read from the ReceiptRegistry contract.</span>
        </div>

        <div className="card pad24 col between ov-stat">
          <span className="c2 strong">Free credits</span>
          <div className="col g4">
            <span className="stat" data-testid="credits-remaining">
              {creditsError ? "?" : credits ? formatUsdc(credits.remaining) : "…"}
            </span>
            <span className="small c3">USDC left to fund plans</span>
          </div>
          <div className="col g6">
            <Meter share={spentShare} color="var(--chart-purple)" label="Share of free credits spent" />
            <span className="small c3">
              {credits ? `${formatUsdc(credits.spent)} of ${formatUsdc(credits.granted)} spent` : " "}
            </span>
          </div>
        </div>

        <div className="card pad24 col between ov-stat">
          <span className="c2 strong">Your wallet</span>
          {trial ? (
            <div className="col g4">
              <span className="stat">None</span>
              <span className="small c3">
                <Link to={paths.wallet} className="link">
                  Connect a wallet
                </Link>{" "}
                to pay with your own test USDC.
              </span>
            </div>
          ) : (
            <div className="col g4">
              <span className="stat" data-testid="usdc-balance">
                {balances ? formatUsdc(balances.usdc) : "…"}
              </span>
              <span className="small c3">
                test USDC, {balances ? Number(formatEther(balances.eth)).toFixed(4) : "…"} ETH for gas
              </span>
            </div>
          )}
        </div>

        <div className="card pad24 col between ov-stat">
          <span className="c2 strong">Your runs</span>
          <div className="row between items-end g8">
            <div className="col g4 min0">
              <span className="stat" data-testid="run-count">
                {plansError ? "?" : counts ? counts.total : "…"}
              </span>
              <span className="small c3">
                {counts
                  ? `${counts.active} in progress, ${counts.done} done${counts.failed > 0 ? `, ${counts.failed} failed` : ""}`
                  : plansError
                    ? "Could not load your runs."
                    : "Loading…"}
              </span>
            </div>
            <span className="lc-spark" title={`Runs started per day, last ${String(TREND_DAYS)} days`}>
              <Spark points={trend.map((d) => d.started)} color="var(--azure)" width={88} height={36} />
            </span>
          </div>
        </div>
      </section>

      <section className="ov-bottom">
        <div className="card pad24 col g12 min0 lc-flow-card">
          <div className="row between">
            <div className="col">
              <h2 className="title">Latest run</h2>
              <span className="small c2 ellipsis">
                {latestPlan ? latestPlan.goal : "Each task of a run, under the tasks it waits on, as it runs"}
              </span>
            </div>
            {latestPlan ? (
              <div className="row g8">
                <PlanBadge state={latestPlan.state} />
                <Link to={paths.run(latestPlan.plan_uuid)} className="link">
                  Open run
                </Link>
              </div>
            ) : null}
          </div>
          {latestDetail ? (
            latestDetail.tasks.length > 0 ? (
              <TaskFlow detail={latestDetail} agents={agents} linkTo={paths.run(latestDetail.plan_uuid)} />
            ) : (
              <TaskFlowEmpty note="This run has no tasks yet." />
            )
          ) : (
            <TaskFlowEmpty
              note={
                plansError
                  ? "Could not load your runs."
                  : latestError
                    ? `Could not load the latest run: ${latestError}`
                    : plans === null || latestPlan
                      ? "Loading the run…"
                      : "Start a run and its tasks show up here as a graph, live as agents work."
              }
            />
          )}
        </div>

        <div className="card pad col g12 ov-activity">
          <div className="row between">
            <div className="col">
              <h2 className="title">Run activity</h2>
              <span className="small c2">Last 7 days</span>
            </div>
            <div className="row g12 small c2" aria-hidden="true">
              <span className="row g6">
                <i className="legend" style={{ background: "var(--ink)" }} />
                Started
              </span>
              <span className="row g6">
                <i className="legend" style={{ background: "var(--chart-green)" }} />
                Done
              </span>
              <span className="row g6">
                <i className="legend" style={{ background: "var(--chart-rose)" }} />
                Failed
              </span>
            </div>
          </div>
          <DayBars
            days={week}
            bars={[
              { name: "Started", color: "var(--ink)" },
              { name: "Done", color: "var(--chart-green)" },
              { name: "Failed", color: "var(--chart-rose)" },
            ]}
            values={week.map((d) => [d.started, d.done, d.failed])}
            caption="Runs started, done and failed per day, last 7 days"
            empty="No runs this week yet."
          />
          <div className="row between small c2">
            <span>{week.reduce((n, d) => n + d.started, 0)} started this week</span>
            <span>
              {rate === null ? "No finished runs yet" : `${String(Math.round(rate * 100))}% of finished runs done`}
            </span>
          </div>
        </div>
      </section>

      <section className="pl-row">
        <div className="card pl-card rise" style={{ animationDelay: "120ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Runs over time</h2>
              <span className="small c2">Per day, last {TREND_DAYS} days</span>
            </div>
            <div className="row g16 small c2" aria-hidden="true">
              <span className="row g6">
                <i className="pl-key" style={{ background: "var(--chart-purple)" }} /> Started
              </span>
              <span className="row g6">
                <i className="pl-key" style={{ background: "var(--chart-green)" }} /> Done
              </span>
            </div>
          </div>
          <AreaTrend
            labels={trend.map((d) => d.date)}
            label={`Runs started and done per day over the last ${String(TREND_DAYS)} days`}
            series={[
              { name: "Started", values: trend.map((d) => d.started), color: "var(--chart-purple)" },
              { name: "Done", values: trend.map((d) => d.done), color: "var(--chart-green)" },
            ]}
            empty={`No runs in the last ${String(TREND_DAYS)} days yet.`}
          />
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "200ms" }}>
          <div className="col">
            <h2 className="title">Runs by state</h2>
            <span className="small c2">Where each of your runs is now</span>
          </div>
          <div className="pl-work">
            <ShareRing parts={runsByState(mine)} unit="runs" />
            <ShareLegend parts={runsByState(mine)} />
          </div>
        </div>
      </section>

      <section className="pl-row pl-row3">
        <div className="card pl-card rise" style={{ animationDelay: "280ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Receipts per block</h2>
              <span className="small c2">Settlement on {LIVE.chainName}</span>
            </div>
            {blocks.length > 0 && <span className="badge b-ok">live</span>}
          </div>
          <BlockBars blocks={blocks} />
          <span className="small c3">
            {blocks.length > 0
              ? `Latest ${String(blocks.length)} blocks with a receipt, newest on the right`
              : receiptsError
                ? `Could not read ${LIVE.chainName}.`
                : "Waiting for the first receipt."}
          </span>
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "360ms" }}>
          <div className="col">
            <h2 className="title">When you run</h2>
            <span className="small c2">Runs started per hour · 7 days</span>
          </div>
          <HourHeatmap
            levels={heat.levels}
            days={heat.days}
            label={`Runs started per hour over the last 7 days; the busiest hour had ${String(heat.max)}`}
          />
        </div>

        <div className="card pl-card rise" style={{ animationDelay: "440ms" }}>
          <div className="row between">
            <div className="col">
              <h2 className="title">Settlement trace</h2>
              <span className="small c2">Latest receipts on chain</span>
            </div>
            <span className="mono-s c3">block</span>
          </div>
          {receipts && receipts.length > 0 ? (
            <ol className="pl-trace lc-trace">
              {receipts.slice(0, TRACE).map((c, i) => (
                <li key={c.taskId} className="rise" style={{ animationDelay: `${String(500 + i * 120)}ms` }}>
                  <Link to={paths.proof(c.taskId)} className="pl-trace-row" aria-label={`Open receipt ${c.taskId}`}>
                    <span className="mono cz w-120">{short(c.tx)}</span>
                    <span className="grow ellipsis">
                      <span className="mono">commitReceipt()</span>{" "}
                      <span className="small c3">· {agentName(agents, c.agentId.toString())}</span>
                    </span>
                    <span className="mono cm">✓ {c.blockNumber.toString()}</span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <div className="lc-trace-empty">
              <span className="small c3">
                {receiptsError
                  ? `Could not read ${LIVE.chainName}.`
                  : "Nothing settled yet. Receipts land here as agents finish."}
              </span>
              {[0, 1, 2].map((i) => (
                <i key={i} style={{ animationDelay: `${String(i * 200)}ms` }} aria-hidden="true" />
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="lc-lists">
        <section className="card pad24 col g12 min0">
          <div className="row between">
            <h2 className="title">Recent runs</h2>
            <Link to={paths.runs} className="link">
              All runs
            </Link>
          </div>
          {plansError && <p className="c2">{plansError}</p>}
          {!plansError && plans === null && <p className="c2">Loading your runs…</p>}
          {plans?.length === 0 && <p className="c2">No runs yet. Start one to see it here.</p>}
          {plans && plans.length > 0 && (
            <ul className="lr-list">
              {plans.slice(0, RECENT).map((p) => (
                <li key={p.plan_uuid}>
                  <Link to={paths.run(p.plan_uuid)} className="tr">
                    <span className="strong grow ellipsis">{p.goal}</span>
                    <span className="mono c2 w-90 text-right hide-sm">
                      {formatUsdc(BigInt(p.budget_usdc_units))} USDC
                    </span>
                    <span className="w-130">
                      <PlanBadge state={p.state} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card pad24 col g12 min0">
          <div className="row between">
            <h2 className="title">Latest receipts on chain</h2>
            <Link to={paths.proofs} className="link">
              All proofs
            </Link>
          </div>
          {receiptsError && <p className="c2">Could not read receipts from {LIVE.chainName}. Try again in a moment.</p>}
          {!receiptsError && receipts === null && <p className="c2">Reading the chain…</p>}
          {receipts?.length === 0 && <p className="c2">No receipts committed yet.</p>}
          {receipts && receipts.length > 0 && (
            <ul className="lr-list">
              {receipts.slice(0, RECENT).map((c) => (
                <li key={c.taskId}>
                  <Link to={paths.proof(c.taskId)} className="tr">
                    <span className="mono grow ellipsis">
                      {c.taskId.slice(0, 10)}…{c.taskId.slice(-6)}
                    </span>
                    <span className="c2 w-90 hide-sm">Agent {c.agentId.toString()}</span>
                    <span className="mono c2 w-90 text-right">{usd(c.costMicros)}</span>
                    <span className="mono c3 w-130 text-right">block {c.blockNumber.toString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
