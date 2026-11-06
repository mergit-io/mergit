import { describe, expect, it } from "vitest";
import type { AgentReputation } from "../../../api/types";
import { withTrackRecord } from "./trackRecord";

const row = (name: string, category: string, counted: number): AgentReputation => ({
  agent_id: name,
  name,
  category,
  basis: counted > 0 ? "validated outcomes" : "prior (no counted outcomes)",
  counted_outcomes: counted,
  uncounted_credit_outcomes: 0,
  success_mean: 0.5,
  cost_mean_micros: 1,
  value_density_per_usdc: 1,
  effective_sample_size: counted,
});

describe("withTrackRecord", () => {
  it("lists agents with validated outcomes in the category, most validated first", () => {
    const rows = [row("a", "bugfix", 2), row("b", "bugfix", 5), row("c", "refactor", 9)];
    expect(withTrackRecord(rows, "bugfix").map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("leaves out an agent with only a prior, so a newcomer is never shown as proven", () => {
    expect(withTrackRecord([row("a", "bugfix", 0)], "bugfix")).toEqual([]);
  });

  it("does not count free-credit work: an agent with only uncounted outcomes has no record", () => {
    const credits = { ...row("a", "bugfix", 0), uncounted_credit_outcomes: 7 };
    expect(withTrackRecord([credits], "bugfix")).toEqual([]);
  });
});
