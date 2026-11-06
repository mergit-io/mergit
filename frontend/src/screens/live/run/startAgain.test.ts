import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import type { PlanDetail, PlanState } from "../../../api/types";
import { paths } from "../../../app/paths";
import { fieldProblems, GOAL_LIMIT, INITIAL, KINDS } from "./newRunForm";
import {
  applyPrefill,
  canStartAgain,
  filledMessage,
  loadFailureMessage,
  prefillFromPlan,
  sourcePlanId,
} from "./startAgain";

const UUID = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";

const detail = (over: Partial<PlanDetail> = {}): PlanDetail => ({
  plan_uuid: UUID,
  plan_id: `0x${"1".repeat(64)}`,
  requester: `0x${"2".repeat(40)}`,
  state: "closed",
  goal: "Fix the refund test",
  repo_url: "https://github.com/acme/widgets",
  ref: "release/1.2",
  category: "bug-fix",
  budget_usdc_units: "2500000",
  funding: "wallet",
  total_budget_usdc_units: "2500000",
  created_at: "2026-10-29T10:00:00Z",
  approved_at: "2026-10-29T10:05:00Z",
  tasks: [
    {
      index: 0,
      title: "Fix",
      instructions: "Patch it",
      phi: {},
      phi_hash: `0x${"3".repeat(64)}`,
      budget_usdc_units: "2500000",
      depends_on: [],
      agents: ["1", "2"],
    },
  ],
  attempts: [],
  money_events: [],
  ...over,
});

describe("canStartAgain", () => {
  it("is offered for a plan that ended without finishing, and only then", () => {
    const states: PlanState[] = ["draft", "approved", "funded", "running", "done", "failed", "closed"];
    expect(states.filter(canStartAgain)).toEqual(["failed", "closed"]);
  });
});

describe("sourcePlanId", () => {
  it("takes a plan uuid from the from parameter, in any case, as lower case", () => {
    expect(sourcePlanId(`?from=${UUID}`)).toBe(UUID);
    expect(sourcePlanId(new URLSearchParams({ from: UUID.toUpperCase() }))).toBe(UUID);
  });

  it("ignores a missing or invalid value", () => {
    for (const search of [
      "",
      "?from=",
      "?from=main",
      `?from=${UUID}x`,
      `?from=../${UUID}`,
      `?from=${UUID}/approve`,
      "?from=<script>alert(1)</script>",
      `?from=${UUID}&from=${UUID.replace("3f", "4f")}`,
      `?other=${UUID}`,
    ]) {
      expect(sourcePlanId(search), search).toBeNull();
    }
  });
});

describe("prefillFromPlan", () => {
  it("fills the form from a closed plan: goal, repository, branch, budget and kind of work", () => {
    expect(prefillFromPlan(detail())).toEqual({
      goal: "Fix the refund test",
      repo: "acme/widgets",
      ref: "release/1.2",
      budget: "2.5",
      category: "bug-fix",
    });
  });

  it("fills the form from a failed plan too", () => {
    expect(prefillFromPlan(detail({ state: "failed" })).goal).toBe("Fix the refund test");
  });

  it("fills nothing from a plan that is done, running or not yet over", () => {
    for (const state of ["draft", "approved", "funded", "running", "done"] as const) {
      expect(prefillFromPlan(detail({ state })), state).toEqual({});
    }
  });

  it("never carries funding, approval, tasks or picks over", () => {
    const keys = Object.keys(prefillFromPlan(detail())).sort();
    expect(keys).toEqual(["budget", "category", "goal", "ref", "repo"]);
    const text = JSON.stringify(prefillFromPlan(detail()));
    for (const leaked of ["funding", "wallet", "approved", "plan_id", UUID, "agents", "phi", "tasks"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("gives a form the form itself accepts", () => {
    const filled = applyPrefill(INITIAL, prefillFromPlan(detail()));
    expect(fieldProblems(filled)).toEqual([]);
  });

  it("writes the repository the way the picker does, and the https URL form is accepted", () => {
    expect(prefillFromPlan(detail({ repo_url: "https://github.com/acme/widgets.git" })).repo).toBe("acme/widgets");
    expect(prefillFromPlan(detail({ repo_url: "http://github.com/acme/widgets" })).repo).toBe("acme/widgets");
  });

  it("leaves out a repository the form would not take", () => {
    for (const repo_url of [
      "",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "git@github.com:acme/widgets.git",
      "https://example.com/acme/widgets",
      "https://github.com/acme/widgets\nhttps://evil.example",
      "https://github.com/acme/wid gets",
      "ftp://github.com/acme/widgets",
    ]) {
      expect(prefillFromPlan(detail({ repo_url })), repo_url).not.toHaveProperty("repo");
    }
  });

  it("strips control characters from the goal but keeps its line breaks, and drops a goal that is then empty", () => {
    expect(prefillFromPlan(detail({ goal: "Fix\u0000 the\u001b test\r\nthen\ttidy\u007f\u0085 up‮" })).goal).toBe(
      "Fix the test\nthen\ttidy up",
    );
    expect(prefillFromPlan(detail({ goal: "\u0000\u0007 \n" }))).not.toHaveProperty("goal");
  });

  it("drops a goal longer than the form's own limit instead of cutting it", () => {
    expect(prefillFromPlan(detail({ goal: "a".repeat(GOAL_LIMIT) })).goal).toHaveLength(GOAL_LIMIT);
    expect(prefillFromPlan(detail({ goal: "a".repeat(GOAL_LIMIT + 1) }))).not.toHaveProperty("goal");
  });

  it("drops a goal with a starting point's <…> blank, which the form refuses", () => {
    expect(
      prefillFromPlan(detail({ goal: "<What goes wrong> no longer happens, and a regression test covers it." })),
    ).not.toHaveProperty("goal");
  });

  it("leaves out a branch with control characters, blank, or absurdly long", () => {
    for (const ref of ["", "  ", "ma\u0000in", "main\nfeature", "x".repeat(256)]) {
      expect(prefillFromPlan(detail({ ref })), JSON.stringify(ref)).not.toHaveProperty("ref");
    }
    expect(prefillFromPlan(detail({ ref: " main " })).ref).toBe("main");
  });

  it("leaves out a budget the form would refuse, and a kind of work it does not offer", () => {
    for (const budget_usdc_units of ["0", "-5", "abc", "1.5", "", "1000000001", "9".repeat(400)]) {
      expect(prefillFromPlan(detail({ budget_usdc_units })), budget_usdc_units).not.toHaveProperty("budget");
    }
    expect(prefillFromPlan(detail({ budget_usdc_units: "1000000000" })).budget).toBe("1000");
    expect(prefillFromPlan(detail({ category: "rm -rf" }))).not.toHaveProperty("category");
    for (const k of KINDS) expect(prefillFromPlan(detail({ category: k.value })).category).toBe(k.value);
  });

  it("is not fooled by a plan whose fields are not strings", () => {
    const hostile = detail({
      goal: 5 as unknown as string,
      repo_url: null as unknown as string,
      ref: {} as unknown as string,
      category: [] as unknown as string,
      budget_usdc_units: 3 as unknown as string,
    });
    expect(prefillFromPlan(hostile)).toEqual({});
  });
});

describe("applyPrefill", () => {
  const prefill = prefillFromPlan(detail());

  it("fills a form that has not been touched", () => {
    expect(applyPrefill(INITIAL, prefill)).toEqual({
      goal: "Fix the refund test",
      repo: "acme/widgets",
      ref: "release/1.2",
      budget: "2.5",
      category: "bug-fix",
    });
  });

  it("keeps whatever was already typed", () => {
    const typed = { goal: "My own goal", repo: "me/mine", ref: "dev", budget: "7", category: "docs" };
    expect(applyPrefill(typed, prefill)).toEqual(typed);
  });

  it("fills only the empty fields of a half-filled form", () => {
    expect(applyPrefill({ ...INITIAL, goal: "My own goal" }, prefill)).toEqual({
      goal: "My own goal",
      repo: "acme/widgets",
      ref: "release/1.2",
      budget: "2.5",
      category: "bug-fix",
    });
  });

  it("changes nothing for an empty prefill, and adds no fields", () => {
    expect(applyPrefill(INITIAL, {})).toEqual(INITIAL);
    expect(Object.keys(applyPrefill(INITIAL, prefill)).sort()).toEqual(Object.keys(INITIAL).sort());
  });
});

describe("loadFailureMessage", () => {
  it("says plainly that a plan which is not the requester's, or is gone, was not used", () => {
    expect(loadFailureMessage(new ApiError(403, "x"))).toBe(
      "That earlier plan is not one of yours, so the form was not filled in from it.",
    );
    expect(loadFailureMessage(new ApiError(404, "x"))).toBe(
      "That earlier plan could not be found, so the form was not filled in from it.",
    );
  });

  it("says plainly that any other failure left the form empty", () => {
    expect(loadFailureMessage(new ApiError(0, "unreachable"))).toBe(
      "Could not load the earlier plan to fill in the form. Describe the run below instead.",
    );
    expect(loadFailureMessage(new Error("boom"))).toBe(
      "Could not load the earlier plan to fill in the form. Describe the run below instead.",
    );
  });
});

describe("filledMessage", () => {
  it("says the form was filled in and that nothing was paid or approved", () => {
    expect(filledMessage(prefillFromPlan(detail()))).toBe(
      "Filled in from your earlier plan. Check it, then draft the plan. Nothing is paid until you approve and fund it.",
    );
  });

  it("says when some details could not be reused, and when none could", () => {
    expect(filledMessage(prefillFromPlan(detail({ ref: "" })))).toContain("Some details could not be reused");
    expect(filledMessage({})).toBe("Nothing from the earlier plan could be reused. Describe the run below instead.");
  });
});

describe("the Start again link", () => {
  it("opens the new-run screen with only the plan id in the query", () => {
    expect(paths.startAgain(UUID)).toBe(`${paths.newRun}?from=${UUID}`);
    expect(sourcePlanId(paths.startAgain(UUID).split("?")[1] ?? "")).toBe(UUID);
  });
});
