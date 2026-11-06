import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { paths } from "../../../app/paths";
import { useAgents } from "../../../api/useAgents";
import { usePlan, type StreamStatus } from "../../../api/usePlan";
import type { AgentInfo, PlanDetail, StepEvent } from "../../../api/types";
import { MergitLoader } from "../../../components/MergitLoader";
import { PageHeader } from "../../../components/PageHeader";
import { PlanBadge } from "./badges";
import { stuckTasks, taskProgress } from "./progress";
import { DraftPlanEditor } from "./DraftPlanEditor";
import { FundingStep } from "./FundingStep";
import { RunView } from "./RunView";
import "../../../styles/screens/run.css";
import "../../../styles/screens/live-run.css";

/** The stream carries jobs, not dispatches, so a retry on its way to the gateway is followed by reloading. */
const RELOAD_WHILE_RETRYING_MS = 15_000;

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  closed: "Live updates stopped. Reload the page.",
};

/**
 * One plan on live data, from review to the last check. The URL stays the same through its whole life;
 * the body follows the plan's state.
 */
export function LiveRunWorkspace() {
  const { runId = "" } = useParams();
  const { detail, steps, error, stream, reload } = usePlan(runId);
  const { agents } = useAgents();
  const retrying =
    detail?.state === "running" &&
    detail.tasks.some((t) => taskProgress(t, detail.attempts, detail.pending_dispatches ?? []).kind === "retrying");
  useEffect(() => {
    if (!retrying) return;
    const timer = setInterval(reload, RELOAD_WHILE_RETRYING_MS);
    return () => {
      clearInterval(timer);
    };
  }, [retrying, reload]);

  if (!detail) {
    return (
      <section className="card pad24 rw-empty">
        {error ? (
          <p className="c2" role="alert">
            {error}
          </p>
        ) : (
          <div className="c2 row g12 loading-row">
            <MergitLoader size={28} label="Loading the plan" />
            <span>Loading the plan…</span>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <PageHeader
        title={<span className="lr-title">{detail.goal}</span>}
        crumb={{ label: "Runs", to: paths.runs, id: detail.plan_uuid.slice(0, 8) }}
        badge={
          <PlanBadge
            state={detail.state}
            stuck={stuckTasks(detail.tasks, detail.attempts, detail.pending_dispatches ?? []).length}
          />
        }
        subtitle={
          <>
            <span className="mono">{detail.repo_url}</span> at <span className="mono">{detail.ref}</span>
          </>
        }
        actions={
          <span className={`chip${stream === "open" ? "" : " warn"}`} role="status">
            {STREAM_LABEL[stream]}
          </span>
        }
      />
      {/* A refresh after an edit or approval failed: what is shown may be out of date. */}
      {error && (
        <p className="card pad small cr lr-banner" role="alert">
          Could not refresh the plan: {error}
        </p>
      )}
      <PlanBody detail={detail} steps={steps} agents={agents} reload={reload} />
    </>
  );
}

function PlanBody({
  detail,
  steps,
  agents,
  reload,
}: {
  detail: PlanDetail;
  steps: StepEvent[];
  agents: AgentInfo[] | null;
  reload: () => void;
}) {
  switch (detail.state) {
    case "draft":
      return <DraftPlanEditor key={detail.plan_uuid} plan={detail} agents={agents} onChanged={reload} />;
    case "approved":
      return <FundingStep detail={detail} onClosed={reload} />;
    default:
      return <RunView detail={detail} steps={steps} agents={agents} onClosed={reload} />;
  }
}
