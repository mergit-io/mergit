import { describe, expect, it } from "vitest";
import { planKey } from "./idempotency";

const form = {
  goal: "Fix it",
  repo_url: "https://github.com/o/r",
  ref: "main",
  budget_usdc_units: "1",
  category: "bug-fix",
};

describe("planKey", () => {
  it("is the same for the same form, so a retry or second click names the same plan", () => {
    expect(planKey("n1", form)).toBe(planKey("n1", { ...form }));
  });

  it("changes when anything in the form changes, so an edited form is a new plan", () => {
    const keys = new Set([
      planKey("n1", form),
      planKey("n1", { ...form, goal: "Fix it now" }),
      planKey("n1", { ...form, ref: "dev" }),
      planKey("n1", { ...form, budget_usdc_units: "2" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("differs between page loads, so yesterday's identical form is not today's plan", () => {
    expect(planKey("n1", form)).not.toBe(planKey("n2", form));
  });

  it("is a header value the API accepts: 1 to 100 of letters, digits . _ : -", () => {
    expect(planKey("0b6f2f4e-4f1c-4a3e-9b6e-1f2d3c4b5a69", form)).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
  });
});
