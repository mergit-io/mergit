import { Link } from "react-router-dom";
import type { Address } from "viem";
import { formatEther } from "viem";
import { paths } from "../../app/paths";
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
import { LIVE } from "../../config/live";
import { PlanBadge } from "./run/badges";
import { summarizePlans } from "./overview";
import "../../styles/screens/overview.css";
import "../../styles/screens/live-run.css";

const RECENT = 5;
const usd = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(4)}`;

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
  const counts = plans ? summarizePlans(plans) : null;
  const latest = receipts?.[0];

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
          <div className="col g4">
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
        </div>
      </section>

      <section className="card pad24 col g12">
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
                  <span className="mono c2 w-90 text-right">{formatUsdc(BigInt(p.budget_usdc_units))} USDC</span>
                  <span className="w-130">
                    <PlanBadge state={p.state} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card pad24 col g12">
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
                  <span className="c2 w-90">Agent {c.agentId.toString()}</span>
                  <span className="mono c2 w-90 text-right">{usd(c.costMicros)}</span>
                  <span className="mono c3 w-130 text-right">block {c.blockNumber.toString()}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
