import { Badge } from "../../../components/Badge";
import type { PlanState } from "../../../api/types";
import type { Status } from "../../../mock/data";
import type { AttemptOutcome, TaskProgress, Verdict } from "./progress";

const PLAN: Record<PlanState, [Status, string]> = {
  draft: ["Neutral", "Draft"],
  approved: ["Waiting", "Awaiting funds"],
  funded: ["Running", "Starting"],
  running: ["Running", "Running"],
  done: ["Completed", "Done"],
  failed: ["Failed", "Failed"],
  closed: ["Neutral", "Closed"],
};

const STUCK: [Status, string] = ["Failed", "Needs you"];

/** `stuck`: how many of a running plan's tasks wait on the requester; any turns "Running" into "Needs you". */
export function PlanBadge({ state, stuck = 0 }: { state: PlanState; stuck?: number }) {
  const [status, label] = state === "running" && stuck > 0 ? STUCK : PLAN[state];
  return <Badge status={status} label={label} />;
}

const PROGRESS: Record<TaskProgress["kind"], [Status, string]> = {
  waiting: ["Neutral", "Waiting"],
  running: ["Running", "Running"],
  passed: ["Completed", "Passed"],
  retrying: ["Waiting", "Retrying"],
  stuck: ["Failed", "Needs you"],
};

export function ProgressBadge({ progress }: { progress: TaskProgress }) {
  const [status, label] = PROGRESS[progress.kind];
  return <Badge status={status} label={label} />;
}

const OUTCOME: Record<AttemptOutcome, [Status, string]> = {
  "in progress": ["Running", "In progress"],
  passed: ["Completed", "Check held"],
  failed: ["Failed", "Check failed"],
  inconclusive: ["Waiting", "Inconclusive"],
};

export function OutcomeBadge({ outcome }: { outcome: AttemptOutcome }) {
  const [status, label] = OUTCOME[outcome];
  return <Badge status={status} label={label} />;
}

const VERDICT: Record<Verdict, [Status, string]> = {
  pass: ["Verified", "Audit passed"],
  fail: ["Failed", "Audit failed"],
  invalid: ["Failed", "Receipt invalid"],
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const [status, label] = VERDICT[verdict];
  return <Badge status={status} label={label} />;
}
