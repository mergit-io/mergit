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

describe("taskProgress", () => {
  it("waits while nothing has been dispatched", () => {
    expect(taskProgress(task(), [])).toEqual({ kind: "waiting" });
  });

  it("is running while the latest attempt is queued or running", () => {
    expect(taskProgress(task(), [attempt(1, { status: "queued" })]).kind).toBe("running");
  });

  it("has passed once any attempt's check held, whatever came after", () => {
    const pass = attempt(2, { status: "done", phi_holds: true });
    expect(taskProgress(task(), [failed(1), pass])).toEqual({ kind: "passed", attempt: pass });
  });

  it("retries with the next agent the requester picked after a failure", () => {
    expect(taskProgress(task(["1", "2"]), [failed(1)])).toEqual({
      kind: "retrying",
      failed: failed(1),
      nextAgent: "2",
    });
  });

  it("treats an inconclusive check like a failure, never like a pass", () => {
    const inconclusive = attempt(1, { status: "error", phi_holds: null });
    expect(taskProgress(task(["1", "2"]), [inconclusive]).kind).toBe("retrying");
    expect(taskProgress(task(["1"]), [inconclusive]).kind).toBe("stuck");
  });

  it("waits on the requester once every picked agent has failed", () => {
    expect(taskProgress(task(["1", "2"]), [failed(1), failed(2)])).toEqual({ kind: "stuck", failed: failed(2) });
  });

  it("only counts attempts at its own index", () => {
    expect(taskProgress(task(), [{ ...failed(1), index: 1 }])).toEqual({ kind: "waiting" });
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
    expect(stuckTasks([task(["1"]), other], [failed(1), { ...failed(1), index: 1, task_id: "0xb" }])).toEqual([
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
