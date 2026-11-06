import type { Attempt, MoneyEvent, PendingDispatch, PlanDetail, PlanTask } from "../../../api/types";

/**
 * What each task of a running plan is doing, derived from its attempts, the attempts dispatched but not yet
 * started, and the requester's agent picks, the same rule the control plane applies (plan task O6,
 * `outcomes.stuck_indexes`): a failed or inconclusive attempt is retried with the next agent the requester
 * picked; once every pick has been tried, or the next attempt could not be started, the task waits on the
 * requester. The API does not store that last state, so the screen derives it the way the server does.
 */
export type TaskProgress =
  /** Not dispatched yet: waiting on a dependency, or on its escrow. */
  | { kind: "waiting" }
  | { kind: "running"; attempt: Attempt }
  | { kind: "passed"; attempt: Attempt }
  /** The last attempt did not pass and the next pick is on its way; `pending` says where, once known. */
  | { kind: "retrying"; failed: Attempt; nextAgent: string; pending?: PendingDispatch }
  /** Only the requester can move this task on: every pick was tried, or `givenUp` never started. */
  | { kind: "stuck"; failed?: Attempt; givenUp?: PendingDispatch };

export type AttemptOutcome = "in progress" | "passed" | "failed" | "inconclusive";

export function attemptsOf(index: number, attempts: Attempt[]): Attempt[] {
  return attempts.filter((a) => a.index === index).sort((a, b) => a.attempt - b.attempt);
}

export function attemptOutcome(attempt: Attempt): AttemptOutcome {
  if (attempt.status === "queued" || attempt.status === "running") return "in progress";
  if (attempt.phi_holds === true) return "passed";
  return attempt.phi_holds === false ? "failed" : "inconclusive";
}

export function taskProgress(task: PlanTask, attempts: Attempt[], pending: PendingDispatch[] = []): TaskProgress {
  const mine = attemptsOf(task.index, attempts);
  const passed = mine.find((a) => a.phi_holds === true);
  if (passed) return { kind: "passed", attempt: passed };
  const latest = mine.at(-1);
  // An attempt dispatched after the newest job: on its way to the gateway, or given up before it started.
  const next = pending
    .filter((p) => p.index === task.index && p.attempt > (latest?.attempt ?? 0))
    .sort((a, b) => a.attempt - b.attempt)
    .at(-1);
  if (next?.state === "given_up") return { kind: "stuck", failed: latest, givenUp: next };
  if (!latest) return { kind: "waiting" };
  if (attemptOutcome(latest) === "in progress") return { kind: "running", attempt: latest };
  if (next) return { kind: "retrying", failed: latest, nextAgent: next.agent_id, pending: next };
  // Attempt n ran with agents[n - 1], so the retry's pick is agents[n]. Approval caps the list at the
  // service's attempt limit, so the list running out is the limit.
  const nextAgent = task.agents?.[latest.attempt];
  return nextAgent === undefined ? { kind: "stuck", failed: latest } : { kind: "retrying", failed: latest, nextAgent };
}

export function stuckTasks(tasks: PlanTask[], attempts: Attempt[], pending: PendingDispatch[] = []): PlanTask[] {
  return tasks.filter((t) => taskProgress(t, attempts, pending).kind === "stuck");
}

/**
 * The tasks waiting on the requester. The control plane's own list when it sent one: between a job finishing
 * and the orchestrator reacting to it, the screen's derivation alone would call a task stuck that is about to
 * be retried, and offer a Retry the server refuses.
 */
export function waitingOnRequester(detail: PlanDetail): PlanTask[] {
  const fromServer = detail.stuck_indexes;
  return fromServer
    ? detail.tasks.filter((t) => fromServer.includes(t.index))
    : stuckTasks(detail.tasks, detail.attempts, detail.pending_dispatches ?? []);
}

/** The highest attempt number this task has had or has on its way. */
export function lastAttempt(index: number, detail: PlanDetail): number {
  const numbers = [...detail.attempts, ...(detail.pending_dispatches ?? [])]
    .filter((a) => a.index === index)
    .map((a) => a.attempt);
  return Math.max(0, ...numbers);
}

/** Nothing was ever dispatched: every task still waits. A closed plan like this never funded, or was closed first. */
export function closedBeforeStart(tasks: PlanTask[], attempts: Attempt[]): boolean {
  return tasks.every((t) => taskProgress(t, attempts).kind === "waiting");
}

export type Verdict = "pass" | "fail" | "invalid";

/** The audit verdict recorded on chain for one attempt, if any. */
export function verdictFor(taskId: string, money: MoneyEvent[]): Verdict | null {
  const event = money.findLast((m) => m.type === "verdict.recorded" && m.payload.task_id === taskId);
  const verdict = event?.payload.verdict;
  return verdict === "pass" || verdict === "fail" || verdict === "invalid" ? verdict : null;
}

const DENIAL_REASON: Record<string, string> = {
  no_credits: "This account has no free credits left. Redeem a code, or connect a wallet and pay as you go.",
  rate_limited: "This account has used its free-credit plans for today.",
  over_value_cap: "This plan costs more than free credits can cover.",
};

/** Why the gateway refused to fund this plan from free credits, or null if it has not. */
export function creditsDenial(money: MoneyEvent[]): string | null {
  const event = money.findLast((m) => m.type === "credits.denied");
  if (!event) return null;
  const reason = event.payload.reason;
  return (typeof reason === "string" ? DENIAL_REASON[reason] : undefined) ?? "Free credits were refused for this plan.";
}
