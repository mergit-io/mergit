import { describe, expect, it } from "vitest";
import { initialPlanStream, planReducer, type PlanStreamEvent, type PlanStreamState } from "./planStream";
import type { Attempt, PlanDetail } from "./types";

const attempt: Attempt = {
  task_id: `0x${"a".repeat(64)}`,
  index: 0,
  attempt: 1,
  agent_id: "1",
  status: "running",
  phi_holds: null,
  receipt_root: null,
  notes: null,
  finished_at: null,
  routing: null,
};

const detail: PlanDetail = {
  plan_uuid: "u",
  plan_id: `0x${"1".repeat(64)}`,
  requester: `0x${"2".repeat(40)}`,
  state: "running",
  goal: "g",
  repo_url: "https://github.com/acme/widgets",
  ref: "main",
  category: "test-repair",
  budget_usdc_units: "1000000",
  funding: "wallet",
  total_budget_usdc_units: "1000000",
  created_at: "t",
  approved_at: "t",
  tasks: [],
  attempts: [attempt],
  money_events: [],
};

const loaded: PlanStreamState = planReducer(initialPlanStream, { type: "loaded", detail });
const apply = (state: PlanStreamState, event: PlanStreamEvent) => planReducer(state, { type: "event", event });

describe("planReducer", () => {
  it("moves the plan state and returns the same state when nothing changed", () => {
    expect(apply(loaded, { name: "plan.state", data: { state: "done" } }).detail?.state).toBe("done");
    expect(apply(loaded, { name: "plan.state", data: { state: "running" } })).toBe(loaded);
  });

  it("replaces an attempt by task_id and adds a new one in index and attempt order", () => {
    const passed = { ...attempt, status: "done" as const, phi_holds: true };
    const retry = { ...attempt, task_id: `0x${"b".repeat(64)}` as const, attempt: 2 };
    const next = apply(apply(loaded, { name: "task.state", data: passed }), { name: "task.state", data: retry });
    expect(next.detail?.attempts).toEqual([passed, retry]);
    expect(apply(loaded, { name: "task.state", data: attempt })).toBe(loaded);
  });

  it("adds a money or verdict event once, however often the stream repeats it", () => {
    const verdict = { type: "verdict.recorded", at: "t", payload: { task_id: attempt.task_id, verdict: "pass" } };
    const once = apply(loaded, { name: "verdict", data: verdict });
    expect(apply(once, { name: "verdict", data: verdict })).toBe(once);
    expect(once.detail?.money_events).toEqual([verdict]);
  });

  it("keeps each step once, even before the detail has loaded", () => {
    const step = { task_id: attempt.task_id, seq: 1, type: "model_call", cost: { usd_micros: 5 } };
    const early = apply(initialPlanStream, { name: "step.recorded", data: step });
    expect(apply(early, { name: "step.recorded", data: step })).toBe(early);
    expect(early.steps).toEqual([step]);
  });

  it("holds events that arrive before the detail, then applies them to it", () => {
    const early = apply(initialPlanStream, { name: "plan.state", data: { state: "done" } });
    expect(early.detail).toBeNull();
    const ready = planReducer(early, { type: "loaded", detail });
    expect(ready.detail?.state).toBe("done");
    expect(ready.backlog).toEqual([]);
  });

  it("clears an earlier load error once the detail loads", () => {
    const failed = planReducer(initialPlanStream, { type: "failed", error: "down" });
    expect(planReducer(failed, { type: "loaded", detail }).error).toBeNull();
  });
});
