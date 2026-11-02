import { describe, expect, it } from "vitest";
import { byAgent, percent, usdc } from "./reputation";
import type { AgentReputation } from "./types";

const row = (agent_id: string, category: string): AgentReputation => ({
  agent_id,
  name: `agent-${agent_id}`,
  category,
  basis: "validated outcomes",
  counted_outcomes: 3,
  uncounted_credit_outcomes: 0,
  success_mean: 0.5,
  cost_mean_micros: 500_000,
  value_density_per_usdc: 1,
  effective_sample_size: 5,
});

describe("reputation figures", () => {
  it("shows a share as a whole percent", () => {
    expect(percent(0.6724)).toBe("67%");
    expect(percent(0.5)).toBe("50%");
    expect(percent(1)).toBe("100%");
  });

  it("rounds a fractional cost to the cent without going negative", () => {
    expect(usdc(500_000)).toBe("0.50");
    expect(usdc(3_025_641.2)).toBe("3.02");
    expect(usdc(-5)).toBe("0.00");
  });

  it("groups categories under their agent and keeps the order", () => {
    const grouped = byAgent([row("1", "a"), row("2", "a"), row("1", "b")]);
    expect([...grouped.keys()]).toEqual(["1", "2"]);
    expect(grouped.get("1")?.map((r) => r.category)).toEqual(["a", "b"]);
  });
});
