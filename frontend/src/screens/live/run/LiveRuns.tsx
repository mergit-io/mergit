import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { paths } from "../../../app/paths";
import { errorMessage, listPlans } from "../../../api/client";
import { useAuth } from "../../../auth/context";
import type { PlanSummary } from "../../../api/types";
import { formatUsdc } from "../../../chain/funding";
import { Button } from "../../../components/Button";
import { MergitLoader } from "../../../components/MergitLoader";
import { PageHeader } from "../../../components/PageHeader";
import { PlanBadge } from "./badges";
import "../../../styles/screens/live-run.css";

/** The signed-in requester's own plans, newest first. */
export function LiveRuns() {
  const { session } = useAuth();
  const signedIn = session !== null; // signed out, this page renders behind the Connect window and must not ask
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    listPlans().then(
      (list) => {
        if (active) setPlans(list);
      },
      (e: unknown) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, [signedIn]);

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Every plan you have drafted, from review to the last check."
        actions={
          <Button variant="primary" icon="plus" to={paths.newRun}>
            New run
          </Button>
        }
      />
      <section className="card">
        {error && <p className="c2 empty">{error}</p>}
        {!error && plans === null && (
          <div className="c2 empty row g12 loading-row">
            <MergitLoader size={28} label="Loading your runs" />
            <span>Loading your runs…</span>
          </div>
        )}
        {plans?.length === 0 && <p className="c2 empty">No runs yet. Start one to see it here.</p>}
        {plans && plans.length > 0 && (
          <ul className="lr-list">
            {plans.map((p) => (
              <li key={p.plan_uuid}>
                <Link to={paths.run(p.plan_uuid)} className="tr">
                  <span className="strong grow ellipsis">{p.goal}</span>
                  <span className="mono-s c3 hide-sm">{p.category}</span>
                  <span className="mono c2 w-90 text-right">{formatUsdc(BigInt(p.budget_usdc_units))} USDC</span>
                  <span className="w-130">
                    <PlanBadge state={p.state} stuck={p.stuck_tasks} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
