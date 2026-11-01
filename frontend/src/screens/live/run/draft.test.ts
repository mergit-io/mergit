import { describe, expect, it } from "vitest";
import type { Plan } from "../../../api/types";
import { editProblems, hasEdits, pickProblems, toApproval, toEdits, toForms, totalBudget } from "./draft";

const PHI = { kind: "exec/0", command: ["pytest", "-q"], expected_exit: 0 };

const plan: Plan = {
  plan_uuid: "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b",
  plan_id: `0x${"1".repeat(64)}`,
  requester: `0x${"2".repeat(40)}`,
  state: "draft",
  goal: "Fix the refund test",
  repo_url: "https://github.com/acme/widgets",
  ref: "main",
  category: "test-repair",
  budget_usdc_units: "2000000",
  funding: null,
  total_budget_usdc_units: null,
  created_at: "2026-10-29T10:00:00Z",
  approved_at: null,
  tasks: [
    {
      index: 0,
      title: "Reproduce",
      instructions: "Run the test",
      phi: PHI,
      phi_hash: null,
      budget_usdc_units: "333333",
      depends_on: [],
      agents: null,
      routing: "pick",
      explore: true,
      retry_tolerant: true,
    },
    {
      index: 1,
      title: "Fix",
      instructions: "Patch it",
      phi: PHI,
      phi_hash: null,
      budget_usdc_units: "1000000",
      depends_on: [0],
      agents: null,
      routing: "pick",
      explore: true,
      retry_tolerant: true,
    },
  ],
};

describe("draft forms", () => {
  it("round-trips a saved plan without counting as an edit, keeping every budget digit", () => {
    const forms = toForms(plan);
    expect(forms[0]?.budget).toBe("0.333333");
    expect(hasEdits(plan, forms)).toBe(false);
    expect(toEdits(forms)).toEqual(
      plan.tasks.map(({ title, instructions, phi, budget_usdc_units, depends_on }) => ({
        title,
        instructions,
        phi,
        budget_usdc_units,
        depends_on,
      })),
    );
  });

  it("sees an edited check, and sends it parsed", () => {
    const forms = toForms(plan).map((f) =>
      f.index === 0 ? { ...f, phiText: JSON.stringify({ ...PHI, command: ["pytest", "tests/test_refund.py"] }) } : f,
    );
    expect(hasEdits(plan, forms)).toBe(true);
    expect(toEdits(forms)[0]?.phi).toEqual({ ...PHI, command: ["pytest", "tests/test_refund.py"] });
  });

  it("names each problem with its task number before anything is sent", () => {
    const forms = toForms(plan).map((f) =>
      f.index === 1 ? { ...f, title: " ", phiText: "[1]", budget: "-1", agents: ["1", "1"] } : { ...f, agents: [] },
    );
    expect(editProblems(forms)).toEqual([
      "Task 2: the title is empty.",
      "Task 2: the check (Φ) is not a JSON object.",
      "Task 2: the budget must be a positive USDC amount.",
    ]);
    expect(pickProblems(forms)).toEqual(["Task 1: pick an agent to run it.", "Task 2: an agent is picked twice."]);
  });

  it("builds the approval with every index as a string key, picks in order", () => {
    const forms = toForms(plan).map((f) => ({ ...f, agents: f.index === 0 ? ["2", "1"] : ["1"] }));
    expect([...editProblems(forms), ...pickProblems(forms)]).toEqual([]);
    expect(toApproval(forms, "credits")).toEqual({
      agents: { "0": ["2", "1"], "1": ["1"] },
      routing: {},
      funding: "credits",
    });
    expect(totalBudget(forms)).toBe(1_333_333n);
  });

  it("routes a task automatically instead of sending a pick list", () => {
    const forms = toForms(plan).map((f) =>
      f.index === 0 ? { ...f, routing: "auto" as const } : { ...f, agents: ["1"] },
    );
    expect(pickProblems(forms)).toEqual([]);
    expect(toApproval(forms, "wallet")).toEqual({
      agents: { "0": "auto", "1": ["1"] },
      routing: { "0": { explore: true, retry_tolerant: true } },
      funding: "wallet",
    });
  });

  it("sends the requester's explore choice for an auto-routed task", () => {
    const forms = toForms(plan).map((f) =>
      f.index === 0 ? { ...f, routing: "auto" as const, explore: false } : { ...f, agents: ["1"] },
    );
    expect(toApproval(forms, "wallet").routing).toEqual({ "0": { explore: false, retry_tolerant: true } });
  });

  it("never sends a pick-routed task's own index in `routing`", () => {
    const forms = toForms(plan).map((f) =>
      f.index === 0 ? { ...f, routing: "auto" as const } : { ...f, routing: "pick" as const, agents: ["1"] },
    );
    const approval = toApproval(forms, "wallet");
    expect(Object.keys(approval.routing ?? {})).toEqual(["0"]);
    expect(approval.routing?.["1"]).toBeUndefined();
  });

  it("an auto-routed task is exempt from the agent-picking checks", () => {
    const forms = toForms(plan).map((f) => ({ ...f, routing: "auto" as const, agents: [] }));
    expect(pickProblems(forms)).toEqual([]);
  });
});
