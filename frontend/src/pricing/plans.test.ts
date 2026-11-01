import { describe, expect, it } from "vitest";
import { COMPARISON, PLANS } from "./plans";

describe("pricing data", () => {
  it("has Free, Premium and Pay as you go, and only Premium is unbuilt", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "premium", "payg"]);
    expect(PLANS.filter((p) => p.soon).map((p) => p.id)).toEqual(["premium"]);
  });

  it("gives Free the 5 USDC the gateway grants by default, and Premium no invented price", () => {
    expect(PLANS[0]?.amount).toBe("5 USDC");
    expect(PLANS[1]?.amount).not.toMatch(/\d/);
  });

  it("sets one built plan apart, never an unbuilt one", () => {
    const featured = PLANS.filter((p) => p.featured);
    expect(featured.map((p) => p.id)).toEqual(["payg"]);
    expect(featured.every((p) => !p.soon)).toBe(true);
  });

  it("fills every comparison row for every plan", () => {
    for (const group of COMPARISON) for (const row of group.rows) expect(row.cells).toHaveLength(PLANS.length);
  });

  it("shows Premium as soon wherever it would otherwise be a claim, except what every plan shares", () => {
    for (const group of COMPARISON)
      for (const row of group.rows) {
        const [free, premium, payg] = row.cells;
        const shared = "yes" in free && "yes" in premium && "yes" in payg;
        const sameText = "text" in free && "text" in premium && free.text === premium.text;
        expect(shared || sameText || "soon" in premium, row.label).toBe(true);
      }
  });
});
