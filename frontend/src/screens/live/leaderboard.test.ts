import { describe, expect, it } from "vitest";
import type { AgentReputation } from "../../api/types";
import { categoriesOf, rankAgents, weightedMean } from "./leaderboard";
// Read through Vite (`?raw`), as the E11 boundary test does: the app's tsconfig has no Node types.
import source from "./leaderboard.ts?raw";

const row = (
  agent_id: string,
  name: string,
  category: string,
  value_density_per_usdc: number,
  counted_outcomes: number,
  basis = "validated outcomes",
): AgentReputation => ({
  agent_id,
  name,
  category,
  basis,
  counted_outcomes,
  uncounted_credit_outcomes: 0,
  success_mean: 0.5,
  cost_mean_micros: 100_000,
  value_density_per_usdc,
  effective_sample_size: counted_outcomes,
});

const order = (ranked: { name: string }[]) => ranked.map((r) => r.name);

describe("rankAgents", () => {
  it("gives nothing for no rows", () => {
    expect(rankAgents([], "All")).toEqual([]);
    expect(rankAgents([], "code")).toEqual([]);
  });

  it("leaves out an agent with no counted outcomes and one whose figures are only a prior", () => {
    const ranked = rankAgents(
      [
        row("1", "counted", "code", 2, 3),
        row("2", "uncounted", "code", 9, 0),
        row("3", "prior", "code", 9, 4, "prior (no counted outcomes)"),
      ],
      "All",
    );
    expect(order(ranked)).toEqual(["counted"]);
  });

  it("leaves out a row whose density is not a finite number", () => {
    expect(order(rankAgents([row("1", "a", "code", Number.NaN, 3), row("2", "b", "code", 1, 3)], "All"))).toEqual([
      "b",
    ]);
  });

  it("ranks by value density, highest first", () => {
    const ranked = rankAgents([row("1", "low", "code", 1, 5), row("2", "high", "code", 3, 5)], "code");
    expect(order(ranked)).toEqual(["high", "low"]);
    expect(ranked[0]).toMatchObject({ agentId: "2", valueDensity: 3, countedOutcomes: 5 });
  });

  it("breaks a tie in density by counted outcomes, then by name", () => {
    const ranked = rankAgents(
      [row("1", "zed", "code", 2, 4), row("2", "few", "code", 2, 1), row("3", "amy", "code", 2, 4)],
      "code",
    );
    expect(order(ranked)).toEqual(["amy", "zed", "few"]);
  });

  it("uses only that category's row when a category is chosen", () => {
    const rows = [row("1", "a", "code", 1, 5), row("1", "a", "docs", 9, 5), row("2", "b", "code", 2, 5)];
    const ranked = rankAgents(rows, "code");
    expect(order(ranked)).toEqual(["b", "a"]);
    expect(ranked[1]).toMatchObject({ valueDensity: 1, countedOutcomes: 5 });
    expect(ranked[1]?.categories.map((c) => c.category)).toEqual(["code"]);
    expect(rankAgents(rows, "docs").map((r) => r.agentId)).toEqual(["1"]);
    expect(rankAgents(rows, "nothing")).toEqual([]);
  });

  it("for All, weights each category's density by its counted outcomes", () => {
    // a: (1*1 + 4*3) / 4 = 3.25 over 4 outcomes; b: 3 over 10.
    const rows = [row("1", "a", "code", 1, 1), row("1", "a", "docs", 4, 3), row("2", "b", "code", 3, 10)];
    const ranked = rankAgents(rows, "All");
    expect(order(ranked)).toEqual(["a", "b"]);
    expect(ranked[0]?.valueDensity).toBeCloseTo(3.25);
    expect(ranked[0]?.countedOutcomes).toBe(4);
    expect(ranked[0]?.categories.map((c) => c.category)).toEqual(["code", "docs"]);
  });

  it("for All, does not let an excluded category pull an agent's density", () => {
    const rows = [row("1", "a", "code", 2, 2), row("1", "a", "docs", 100, 5, "prior (no counted outcomes)")];
    expect(rankAgents(rows, "All")[0]).toMatchObject({ valueDensity: 2, countedOutcomes: 2 });
  });

  it("does not change the rows it was given", () => {
    const rows = [row("1", "low", "code", 1, 5), row("2", "high", "code", 3, 5)];
    const copy = structuredClone(rows);
    rankAgents(rows, "All");
    expect(rows).toEqual(copy);
  });

  it("reads nothing from ENS: the module imports no ENS code (E11)", () => {
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(imports).toEqual(["../../api/types"]);
    expect(imports.some((p) => /chain\/ens|useAgentEns|liveEns|AgentIdentity/.test(p ?? ""))).toBe(false);
  });
});

describe("weightedMean", () => {
  it("weights by counted outcomes and is 0 for nothing counted", () => {
    const rows = [row("1", "a", "code", 1, 1), row("1", "a", "docs", 4, 3)];
    expect(weightedMean(rows, (r) => r.value_density_per_usdc)).toBeCloseTo(3.25);
    expect(weightedMean([], (r) => r.value_density_per_usdc)).toBe(0);
  });
});

describe("categoriesOf", () => {
  it("lists All, then each category that has a counted record, in alphabetical order", () => {
    const rows = [
      row("1", "a", "docs", 1, 1),
      row("2", "b", "code", 1, 2),
      row("3", "c", "code", 1, 2),
      row("4", "d", "data", 1, 0),
    ];
    expect(categoriesOf(rows)).toEqual(["All", "code", "docs"]);
    expect(categoriesOf([])).toEqual(["All"]);
  });
});
