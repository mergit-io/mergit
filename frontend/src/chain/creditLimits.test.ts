import { describe, expect, it } from "vitest";
import { creditBudget, creditProblem, MAX_BUDGET } from "./creditLimits";
import type { Credits } from "./useCredits";

const U = 1_000_000n;
const fresh: Credits = {
  granted: 5n * U,
  spent: 0n,
  remaining: 5n * U,
  plansToday: 0,
  planCap: 2n * U,
  plansPerDay: 3,
};

describe("creditProblem", () => {
  it("accepts a plan within every limit", () => {
    expect(creditProblem(fresh, 2n * U)).toBeNull();
    expect(creditProblem(fresh, 1n)).toBeNull();
  });

  it("names the per-plan cap and what the plan costs", () => {
    const text = creditProblem(fresh, 5n * U);
    expect(text).toContain("2.00 USDC per plan");
    expect(text).toContain("5.00");
  });

  it("refuses once the day's free plans are used", () => {
    expect(creditProblem({ ...fresh, plansToday: 3 }, U)).toContain("3 free plans");
    expect(creditProblem({ ...fresh, plansToday: 2 }, U)).toBeNull();
  });

  it("refuses more than what is left", () => {
    const text = creditProblem({ ...fresh, remaining: U / 2n }, U);
    expect(text).toContain("0.50 USDC");
  });

  it("says nothing when the limits are unknown (an older gateway, or credits not loaded)", () => {
    expect(creditProblem(null, 100n * U)).toBeNull();
    expect(creditProblem({ ...fresh, planCap: null, plansPerDay: null }, 3n * U)).toBeNull();
  });
});

describe("creditBudget", () => {
  it("starts at the cap when the credits cover it", () => {
    expect(creditBudget(fresh)).toBe(2n * U);
  });

  it("is what is left when that is below the cap", () => {
    expect(creditBudget({ ...fresh, remaining: U })).toBe(U);
  });

  it("is unknown without credits or a cap, and when nothing is left", () => {
    expect(creditBudget(null)).toBeNull();
    expect(creditBudget({ ...fresh, planCap: null })).toBeNull();
    expect(creditBudget({ ...fresh, remaining: 0n })).toBeNull();
  });
});

describe("MAX_BUDGET", () => {
  it("is a sensible ceiling for one plan", () => {
    expect(MAX_BUDGET).toBe(1000n * U);
  });
});
