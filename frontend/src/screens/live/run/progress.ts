import type { Attempt, MoneyEvent, PlanTask } from "../../../api/types";

/**
 * What each task of a running plan is doing, derived from its attempts and the requester's agent picks,
 * the same rule the control plane applies (plan task O6): a failed or inconclusive attempt is retried with
 * the next agent the requester picked; once every pick has been tried, the task waits on the requester.
 * The API does not store that last state, so the screen derives it the way the server does.
 */
export type TaskProgress =
  /** Not dispatched yet: waiting on a dependency, or on its escrow. */
  | { kind: "waiting" }
  | { kind: "running"; attempt: Attempt }
  | { kind: "passed"; attempt: Attempt }
  /** The last attempt did not pass and the next pick is being dispatched. */
  | { kind: "retrying"; failed: Attempt; nextAgent: string }
  /** Every agent the requester picked has been tried: only the requester can move this task on. */
  | { kind: "stuck"; failed: Attempt };

export type AttemptOutcome = "in progress" | "passed" | "failed" | "inconclusive";

export function attemptsOf(index: number, attempts: Attempt[]): Attempt[] {
  return attempts.filter((a) => a.index === index).sort((a, b) => a.attempt - b.attempt);
}

export function attemptOutcome(attempt: Attempt): AttemptOutcome {
  if (attempt.status === "queued" || attempt.status === "running") return "in progress";
  if (attempt.phi_holds === true) return "passed";
  return attempt.phi_holds === false ? "failed" : "inconclusive";
}

export function taskProgress(task: PlanTask, attempts: Attempt[]): TaskProgress {
  const mine = attemptsOf(task.index, attempts);
  const passed = mine.find((a) => a.phi_holds === true);
  if (passed) return { kind: "passed", attempt: passed };
  const latest = mine.at(-1);
  if (!latest) return { kind: "waiting" };
  if (attemptOutcome(latest) === "in progress") return { kind: "running", attempt: latest };
  // Attempt n ran with agents[n - 1], so the retry's pick is agents[n]. Approval caps the list at the
  // service's attempt limit, so the list running out is the limit.
  const nextAgent = task.agents?.[latest.attempt];
  return nextAgent === undefined ? { kind: "stuck", failed: latest } : { kind: "retrying", failed: latest, nextAgent };
}

export function stuckTasks(tasks: PlanTask[], attempts: Attempt[]): PlanTask[] {
  return tasks.filter((t) => taskProgress(t, attempts).kind === "stuck");
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
