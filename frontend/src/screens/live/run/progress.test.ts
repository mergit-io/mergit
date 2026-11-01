import { describe, expect, it } from "vitest";
import type { Attempt, MoneyEvent, PlanTask } from "../../../api/types";
import { attemptOutcome, creditsDenial, stuckTasks, taskProgress, verdictFor } from "./progress";

const task = (agents: string[] | null = ["1", "2"]): PlanTask => ({
  index: 0,
  title: "Fix the refund test",
  instructions: "",
  phi: {},
  phi_hash: null,
  budget_usdc_units: "500000",
  depends_on: [],
  agents,
  routing: "pick",
  explore: true,
  retry_tolerant: true,
});

const attempt = (n: number, over: Partial<Attempt> = {}): Attempt => ({
  task_id: `0x${String(n).repeat(64)}`,
  index: 0,
  attempt: n,
  agent_id: String(n),
  status: "running",
  phi_holds: null,
  receipt_root: null,
  notes: null,
  finished_at: null,
  routing: null,
  ...over,
});

const failed = (n: number) => attempt(n, { status: "done", phi_holds: false });

/** An "auto"-routed task, as approval stores it: no pick list at all. */
const autoTask = (): PlanTask => ({ ...task(null), routing: "auto" });

describe("taskProgress", () => {
  it("waits while nothing has been dispatched", () => {
    expect(taskProgress(task(), [], [])).toEqual({ kind: "waiting" });
  });

  it("is running while the latest attempt is queued or running", () => {
    expect(taskProgress(task(), [attempt(1, { status: "queued" })], []).kind).toBe("running");
  });

  it("has passed once any attempt's check held, whatever came after", () => {
    const pass = attempt(2, { status: "done", phi_holds: true });
    expect(taskProgress(task(), [failed(1), pass], [])).toEqual({ kind: "passed", attempt: pass });
  });

  it("retries with the next agent the requester picked after a failure", () => {
    expect(taskProgress(task(["1", "2"]), [failed(1)], [])).toEqual({
      kind: "retrying",
      failed: failed(1),
      nextAgent: "2",
    });
  });

  it("treats an inconclusive check like a failure, never like a pass", () => {
    const inconclusive = attempt(1, { status: "error", phi_holds: null });
    expect(taskProgress(task(["1", "2"]), [inconclusive], []).kind).toBe("retrying");
    expect(taskProgress(task(["1"]), [inconclusive], []).kind).toBe("stuck");
  });

  it("waits on the requester once every picked agent has failed", () => {
    expect(taskProgress(task(["1", "2"]), [failed(1), failed(2)], [])).toEqual({ kind: "stuck", failed: failed(2) });
  });

  it("only counts attempts at its own index", () => {
    expect(taskProgress(task(), [{ ...failed(1), index: 1 }], [])).toEqual({ kind: "waiting" });
  });
});

describe("taskProgress for a task Mergit routes", () => {
  // Final review M1: `agents` is null for every "auto" task, so the pick-list rule found no next agent
  // and called every one of them stuck after its first failure, telling the requester to close a plan the
  // server was still retrying. Only the server's own `needs_requester` may say an "auto" task is stuck.

  it("is being retried after a failure while the server has not said it is stuck", () => {
    expect(taskProgress(autoTask(), [failed(1)], [])).toEqual({ kind: "retrying", failed: failed(1), nextAgent: null });
    const inconclusive = attempt(2, { status: "error", phi_holds: null });
    expect(taskProgress(autoTask(), [failed(1), inconclusive], []).kind).toBe("retrying");
  });

  it("is stuck when, and only when, the server says so, with the server's reason", () => {
    const stuck = [{ index: 0, reason: "agents_exhausted" as const }];
    expect(taskProgress(autoTask(), [failed(1), failed(2)], stuck)).toEqual({
      kind: "stuck",
      failed: failed(2),
      reason: "agents_exhausted",
    });
    // Another task's entry does not count.
    expect(taskProgress(autoTask(), [failed(1)], [{ index: 1, reason: "over_budget" }]).kind).toBe("retrying");
  });

  it("can be stuck before any attempt, when no agent fits its budget", () => {
    expect(taskProgress(autoTask(), [], [{ index: 0, reason: "over_budget" }])).toEqual({
      kind: "stuck",
      failed: null,
      reason: "over_budget",
    });
    expect(taskProgress(autoTask(), [], [])).toEqual({ kind: "waiting" });
  });

  it("still shows a running attempt and a pass over a stale stuck entry", () => {
    const stale = [{ index: 0, reason: "agents_exhausted" as const }];
    expect(taskProgress(autoTask(), [failed(1), attempt(2)], stale).kind).toBe("running");
    const pass = attempt(2, { status: "done", phi_holds: true });
    expect(taskProgress(autoTask(), [failed(1), pass], stale)).toEqual({ kind: "passed", attempt: pass });
  });

  it("lets the server's list decide which tasks are stuck, pick tasks still by their list", () => {
    const auto = { ...autoTask(), index: 1 };
    const attempts = [failed(1), { ...failed(1), index: 1, task_id: "0xb" as const }];
    expect(stuckTasks([task(["1"]), auto], attempts, [])).toEqual([task(["1"])]);
    expect(stuckTasks([task(["1"]), auto], attempts, [{ index: 1, reason: "attempts_exhausted" }])).toEqual([
      task(["1"]),
      auto,
    ]);
    // A pick task ignores the server's list: the pick-list rule is unchanged.
    expect(stuckTasks([task(["1", "2"])], [failed(1)], [{ index: 0, reason: "agents_exhausted" }])).toEqual([]);
  });
});

describe("attemptOutcome", () => {
  it("names every state an attempt can end in", () => {
    expect(attemptOutcome(attempt(1))).toBe("in progress");
    expect(attemptOutcome(attempt(1, { status: "done", phi_holds: true }))).toBe("passed");
    expect(attemptOutcome(failed(1))).toBe("failed");
    expect(attemptOutcome(attempt(1, { status: "error" }))).toBe("inconclusive");
  });
});

describe("stuckTasks", () => {
  it("lists only the tasks with no pick left", () => {
    const other = { ...task(["1", "2"]), index: 1 };
    expect(stuckTasks([task(["1"]), other], [failed(1), { ...failed(1), index: 1, task_id: "0xb" }], [])).toEqual([
      task(["1"]),
    ]);
  });
});

describe("verdictFor and creditsDenial", () => {
  const money: MoneyEvent[] = [
    { type: "verdict.recorded", at: "t1", payload: { task_id: "0xaa", verdict: "fail" } },
    { type: "verdict.recorded", at: "t2", payload: { task_id: "0xaa", verdict: "pass" } },
    { type: "credits.denied", at: "t3", payload: { plan_id: "0xp", reason: "rate_limited" } },
  ];

  it("returns the latest verdict for the task, and none for another task", () => {
    expect(verdictFor("0xaa", money)).toBe("pass");
    expect(verdictFor("0xbb", money)).toBeNull();
  });

  it("explains a credits denial in words, with a fallback for an unknown reason", () => {
    expect(creditsDenial(money)).toBe("This account has used its free-credit plans for today.");
    expect(creditsDenial([{ type: "credits.denied", at: "t", payload: { reason: "new_reason" } }])).toBe(
      "Free credits were refused for this plan.",
    );
    expect(creditsDenial([])).toBeNull();
  });
});
