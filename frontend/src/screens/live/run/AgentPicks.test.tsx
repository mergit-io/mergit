import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "../../../api/types";
import { AgentPicks, type RoutingChoice } from "./AgentPicks";

const AUTO: RoutingChoice = { routing: "auto", explore: true, retryTolerant: true };

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  agent_id: "1",
  name: "coder-a",
  model: "claude-sonnet-5",
  provider: "openrouter",
  operator: `0x${"1".repeat(40)}`,
  theta_mean: 0.72,
  cost_mean_micros: 150_000,
  density: 4.8e-6,
  outcomes: 12,
  costs: 12,
  eligible: true,
  reason: null,
  within_budget: true,
  ...over,
});

function renderAuto(candidates: Candidate[], over: Partial<RoutingChoice> = {}) {
  render(
    <AgentPicks
      task="Task 1"
      agents={[]}
      picks={[]}
      onPicksChange={vi.fn()}
      routing={{ ...AUTO, ...over }}
      onRoutingChange={vi.fn()}
      candidates={candidates}
    />,
  );
}

describe("AgentPicks: Let Mergit route", () => {
  it("renders a candidate's reputation as a percentage and its cost in dollars", () => {
    renderAuto([candidate()]);
    expect(screen.getByText("coder-a · claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText("$0.15 expected")).toBeInTheDocument();
  });

  it("shows an ineligible candidate's reason instead of its numbers", () => {
    // The shape the control plane sends for an agent no draw will realistically pick for this budget
    // (`routing.OVER_BUDGET`): ineligible, with that reason, and not within budget by mean either.
    renderAuto([candidate({ eligible: false, reason: "over budget for this task", within_budget: false })]);
    expect(screen.getByText("over budget for this task")).toBeInTheDocument();
    expect(screen.getByText("Not eligible")).toBeInTheDocument();
    expect(screen.queryByText("72%")).not.toBeInTheDocument();
  });

  it("does not present the starting cost estimate of an agent with no metered cost as a measurement", () => {
    renderAuto([candidate({ costs: 0, cost_mean_micros: 200_000 })]);
    expect(screen.getByText("no metered cost yet")).toBeInTheDocument();
    expect(screen.queryByText("$0.20 expected")).not.toBeInTheDocument();
  });

  it("says when an eligible agent is over budget by its mean cost, and whether exploring can still try it", () => {
    const over = candidate({ cost_mean_micros: 800_000, within_budget: false });
    renderAuto([over]);
    expect(
      screen.getByText("$0.80 expected, over this task's budget · only an exploratory pick tries it"),
    ).toBeInTheDocument();
    cleanup();
    renderAuto([over], { explore: false });
    expect(
      screen.getByText("$0.80 expected, over this task's budget · not picked with exploring off"),
    ).toBeInTheDocument();
  });

  it("labels a candidate with no observations as new rather than showing a measured number", () => {
    renderAuto([candidate({ outcomes: 0 })]);
    expect(screen.getByText("new, no audited record yet")).toBeInTheDocument();
    expect(screen.queryByText("72%")).not.toBeInTheDocument();
  });

  it("hides the ranked list and shows manual pick slots in pick mode", () => {
    render(
      <AgentPicks
        task="Task 1"
        agents={[{ agent_id: "1", name: "coder-a", model: "claude-sonnet-5", provider: "openrouter", reputation: [] }]}
        picks={[]}
        onPicksChange={vi.fn()}
        routing={{ routing: "pick", explore: true, retryTolerant: true }}
        onRoutingChange={vi.fn()}
        candidates={[candidate()]}
      />,
    );
    expect(screen.getByText("Pick an agent")).toBeInTheDocument();
    expect(screen.queryByText("72%")).not.toBeInTheDocument();
  });
});
