import { describe, expect, it } from "vitest";
import {
  COMPARISON,
  FREE_CREDITS_LABEL,
  FREE_CREDITS_USDC,
  PLAN_CAP_LABEL,
  PLAN_CAP_USDC,
  PLANS,
  PLANS_PER_DAY,
} from "./plans";

describe("pricing data", () => {
  it("has Free, Premium and Pay as you go, and only Premium is unbuilt", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "premium", "payg"]);
    expect(PLANS.filter((p) => p.soon).map((p) => p.id)).toEqual(["premium"]);
  });

  it("gives Free the credits the gateway grants by default, and Premium no invented price", () => {
    expect(PLANS[0]?.amount).toBe(FREE_CREDITS_LABEL);
    expect(PLANS[1]?.amount).not.toMatch(/\d/);
  });

  it("caps a plan at the free grant, not a smaller number", () => {
    // chain/gateway/src/main.rs: CREDIT_PLAN_CAP_USDC_UNITS has no separate default, it defaults to
    // FREE_CREDITS_USDC_UNITS itself, after a past bug where a hardcoded cap under the grant let the New
    // run page offer a budget the gateway then refused. PLAN_CAP_USDC must track the grant, not a literal.
    expect(PLAN_CAP_USDC).toBe(FREE_CREDITS_USDC);
    expect(PLAN_CAP_LABEL).toBe(FREE_CREDITS_LABEL);
  });

  it("sets one built plan apart, never an unbuilt one", () => {
    const featured = PLANS.filter((p) => p.featured);
    expect(featured.map((p) => p.id)).toEqual(["payg"]);
    expect(featured.every((p) => !p.soon)).toBe(true);
  });

  it("fills every comparison row for every plan", () => {
    for (const group of COMPARISON) for (const row of group.rows) expect(row.cells).toHaveLength(PLANS.length);
  });

  it("shows Premium as soon in every row, since the plan is not built and claims nothing", () => {
    for (const group of COMPARISON)
      for (const row of group.rows) expect(row.cells[1], row.label).toEqual({ soon: true });
  });

  it("does not claim reputation is earned yet", () => {
    const row = COMPARISON.flatMap((g) => g.rows).find((r) => r.label.includes("reputation"));
    expect(row?.cells.some((c) => "yes" in c)).toBe(false);
    expect(PLANS[2]?.features.join(" ")).toMatch(/coming soon/);
  });

  it("states the free limits from the one set of constants, as defaults", () => {
    expect(PLANS[0]?.features[0]).toBe(
      `By default up to ${PLAN_CAP_LABEL} per plan, ${String(PLANS_PER_DAY)} plans a day`,
    );
    const cells = COMPARISON.flatMap((g) => g.rows).flatMap((r) => r.cells);
    expect(cells).toContainEqual({ text: String(PLANS_PER_DAY) });
    expect(cells).toContainEqual({ text: `Up to ${PLAN_CAP_LABEL}` });
  });
});
