import { describe, expect, it } from "vitest";
import type { Suggestions } from "../../../api/types";
import type { TaskForm } from "./draft";
import { applySuggestions } from "./suggest";

const form = (index: number, agents: string[]): TaskForm => ({
  index,
  title: "t",
  instructions: "i",
  phiText: "{}",
  budget: "0.5",
  dependsOn: [],
  agents,
});

const pick = (agent_id: string) => ({
  agent_id,
  name: agent_id,
  score_per_usdc: 1,
  assumed_success: 0.5,
  assumed_cost_micros: 1,
  counted_outcomes: 0,
  unproven: true,
});

const suggestions = (tasks: Suggestions["tasks"]): Suggestions => ({
  plan_id: "0x",
  mode: "greedy",
  seed: null,
  note: "",
  tasks,
});

describe("applying suggested picks", () => {
  it("sets each task's agents in the suggested order", () => {
    const next = applySuggestions(
      [form(0, []), form(1, ["9"])],
      suggestions([
        { index: 0, budget_usdc_units: "1", picks: [pick("2"), pick("1")] },
        { index: 1, budget_usdc_units: "1", picks: [pick("1")] },
      ]),
    );
    expect(next.map((f) => f.agents)).toEqual([["2", "1"], ["1"]]);
  });

  it("keeps what the requester chose for a task with no suggestion", () => {
    const next = applySuggestions(
      [form(0, ["2"])],
      suggestions([{ index: 0, budget_usdc_units: "1", picks: [], reason: "nothing fits" }]),
    );
    expect(next[0]?.agents).toEqual(["2"]);
  });

  it("never sets more picks than a task may have", () => {
    const next = applySuggestions(
      [form(0, [])],
      suggestions([{ index: 0, budget_usdc_units: "1", picks: ["1", "2", "3", "4", "5"].map(pick) }]),
    );
    expect(next[0]?.agents).toEqual(["1", "2", "3"]);
  });

  it("leaves a task the suggestion does not mention alone", () => {
    const next = applySuggestions([form(0, ["1"]), form(1, ["2"])], suggestions([]));
    expect(next.map((f) => f.agents)).toEqual([["1"], ["2"]]);
  });
});
