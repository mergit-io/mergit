import type { Attempt, MoneyEvent, NeedsRequester, NeedsRequesterReason, PlanTask } from "../../../api/types";

/**
 * What each task of a running plan is doing, derived from its attempts.
 *
 * A "pick" task follows the rule the control plane applies to the requester's own list (plan task O6): a
 * failed or inconclusive attempt is retried with the next agent the requester picked; once every pick has
 * been tried, the task waits on the requester. That rule only needs the list, so the screen derives it.
 *
 * An "auto" task has no list. Whether a failed attempt is retried depends on the roster, the reputation
 * posteriors and the budget, which only the server knows, so the screen never decides an "auto" task is
 * stuck itself: it asks `needsRequester`, the plan detail's own list (final review M1). Until the server
 * says so, a failed "auto" attempt reads as being retried.
 */
export type TaskProgress =
  /** Not dispatched yet: waiting on a dependency, or on its escrow (and, for "auto", on an agent to route to). */
  | { kind: "waiting" }
  | { kind: "running"; attempt: Attempt }
  | { kind: "passed"; attempt: Attempt }
  /** The last attempt did not pass and a retry is coming: the requester's next pick, or (null) Mergit's. */
  | { kind: "retrying"; failed: Attempt; nextAgent: string | null }
  /**
   * Only the requester can move this task on. For a "pick" task, every agent they picked has been tried.
   * For an "auto" task, `reason` is the server's, and `failed` is null if no attempt was ever made.
   */
  | { kind: "stuck"; failed: Attempt | null; reason?: NeedsRequesterReason };

export type AttemptOutcome = "in progress" | "passed" | "failed" | "inconclusive";

export function attemptsOf(index: number, attempts: Attempt[]): Attempt[] {
  return attempts.filter((a) => a.index === index).sort((a, b) => a.attempt - b.attempt);
}

export function attemptOutcome(attempt: Attempt): AttemptOutcome {
  if (attempt.status === "queued" || attempt.status === "running") return "in progress";
  if (attempt.phi_holds === true) return "passed";
  return attempt.phi_holds === false ? "failed" : "inconclusive";
}

function autoProgress(task: PlanTask, attempts: Attempt[], needsRequester: NeedsRequester[]): TaskProgress {
  const mine = attemptsOf(task.index, attempts);
  const passed = mine.find((a) => a.phi_holds === true);
  if (passed) return { kind: "passed", attempt: passed };
  const latest = mine.at(-1);
  if (latest && attemptOutcome(latest) === "in progress") return { kind: "running", attempt: latest };
  const stuck = needsRequester.find((n) => n.index === task.index);
  if (stuck) return { kind: "stuck", failed: latest ?? null, reason: stuck.reason };
  if (!latest) return { kind: "waiting" };
  return { kind: "retrying", failed: latest, nextAgent: null };
}

/** `needsRequester` is the plan detail's list; only an "auto" task reads it (see `TaskProgress`). */
export function taskProgress(task: PlanTask, attempts: Attempt[], needsRequester: NeedsRequester[]): TaskProgress {
  if (task.routing === "auto") return autoProgress(task, attempts, needsRequester);
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

export function stuckTasks(tasks: PlanTask[], attempts: Attempt[], needsRequester: NeedsRequester[]): PlanTask[] {
  return tasks.filter((t) => taskProgress(t, attempts, needsRequester).kind === "stuck");
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
