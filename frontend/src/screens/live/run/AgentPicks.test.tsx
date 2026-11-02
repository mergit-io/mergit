// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentInfo, Suggestion, TaskSuggestions } from "../../../api/types";
import { readSuggestions } from "../../../api/useSuggestions";
import { AgentPicks } from "./AgentPicks";

const AGENTS: AgentInfo[] = ["1", "2", "3", "4", "5"].map((id) => ({
  agent_id: id,
  name: `coder-${id}`,
  model: "claude-sonnet-5",
}));

const pick = (over: Partial<Suggestion> = {}): Suggestion => ({
  agent_id: "1",
  name: "coder-1",
  score_per_usdc: 4.8,
  assumed_success: 0.72,
  assumed_cost_micros: 150_000,
  counted_outcomes: 12,
  unproven: false,
  cost_is_prior: false,
  ...over,
});

const task = (over: Partial<TaskSuggestions> = {}): TaskSuggestions => ({
  index: 0,
  budget_usdc_units: "500000",
  picks: [pick()],
  ineligible: [],
  ...over,
});

function renderPicks(props: Partial<Parameters<typeof AgentPicks>[0]> = {}) {
  const onChange = vi.fn<(picks: string[]) => void>();
  render(<AgentPicks task="Task 1" agents={AGENTS} picks={[]} onChange={onChange} {...props} />);
  return onChange;
}

const suggested = () => screen.getByRole("list", { name: "Task 1: suggested agents" });

describe("AgentPicks: suggestions", () => {
  it("shows a suggested agent's success as a percentage, its cost in dollars and its counted outcomes", () => {
    renderPicks({ suggestion: task(), mode: "greedy" });
    const row = within(suggested()).getByRole("listitem");
    expect(row).toHaveTextContent("coder-1");
    expect(row).toHaveTextContent("72% success");
    expect(row).toHaveTextContent("$0.15 a run");
    expect(row).toHaveTextContent("12 counted outcomes");
    expect(row).not.toHaveTextContent("Unproven");
  });

  it("says a cost under a cent is under a cent rather than $0.00", () => {
    renderPicks({ suggestion: task({ picks: [pick({ assumed_cost_micros: 1_200 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("under $0.01 a run");
  });

  it("marks an unproven agent with a badge", () => {
    renderPicks({ suggestion: task({ picks: [pick({ unproven: true, counted_outcomes: 2 })] }) });
    expect(within(suggested()).getByText("Unproven")).toBeInTheDocument();
  });

  it("never shows the prior as a measurement for an agent with no counted outcomes", () => {
    renderPicks({ suggestion: task({ picks: [pick({ counted_outcomes: 0, unproven: true })] }) });
    const row = within(suggested()).getByRole("listitem");
    expect(row).toHaveTextContent("new, no audited record yet");
    expect(row).not.toHaveTextContent("72%");
    expect(row).not.toHaveTextContent("$0.15");
  });

  it("lists an agent left out with its reason word for word, after the suggestions", () => {
    const reason = "operator in probation";
    renderPicks({ suggestion: task({ ineligible: [{ agent_id: "2", name: "coder-2", reason }] }) });
    const left = screen.getByRole("list", { name: "Task 1: not suggested" });
    expect(within(left).getByRole("listitem")).toHaveTextContent(`coder-2: ${reason}`);
    expect(within(suggested()).queryByText(/coder-2/)).toBeNull();
  });

  it("shows the task's own reason when nothing is suggested, and offers nothing to use", () => {
    const reason = "no agent is expected to fit this budget; choose one yourself or raise the budget";
    renderPicks({
      suggestion: task({ picks: [], reason, ineligible: [{ agent_id: "1", name: "coder-1", reason: "x" }] }),
    });
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use suggestion" })).toBeNull();
  });

  it("says when the order is a random draw", () => {
    renderPicks({ suggestion: task(), mode: "explore" });
    expect(screen.getByText("Random draw")).toBeInTheDocument();
  });

  it("fills the picks with the suggested order on Use suggestion", () => {
    const onChange = renderPicks({
      suggestion: task({ picks: [pick({ agent_id: "3" }), pick({ agent_id: "1" })] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(onChange).toHaveBeenCalledWith(["3", "1"]);
  });

  it("never fills more than MAX_PICKS, nor an agent the same answer lists as left out", () => {
    const onChange = renderPicks({
      suggestion: task({
        picks: ["5", "2", "4", "3", "1"].map((agent_id) => pick({ agent_id })),
        ineligible: [{ agent_id: "2", name: "coder-2", reason: "operator at concurrency cap" }],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(onChange).toHaveBeenCalledWith(["5", "4", "3"]);
  });

  it("leaves the slots editable after Use suggestion fills them", () => {
    const seen: string[][] = [];
    function Stateful() {
      const [picks, setPicks] = useState<string[]>([]);
      return (
        <AgentPicks
          task="Task 1"
          agents={AGENTS}
          picks={picks}
          onChange={(next) => {
            seen.push(next);
            setPicks(next);
          }}
          suggestion={task({ picks: [pick({ agent_id: "3" }), pick({ agent_id: "1" })] })}
        />
      );
    }
    render(<Stateful />);
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(screen.getByLabelText("Task 1: runs it")).toHaveValue("3");
    expect(screen.getByLabelText("Task 1: retry 1")).toHaveValue("1");

    // The requester changes the first pick and adds a third, as with any manual pick.
    fireEvent.change(screen.getByLabelText("Task 1: runs it"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Task 1: retry 2"), { target: { value: "2" } });
    expect(seen).toEqual([
      ["3", "1"],
      ["4", "1"],
      ["4", "1", "2"],
    ]);
    expect(screen.getByLabelText("Task 1: runs it")).toHaveValue("4");
  });

  it("labels explore-mode numbers as this draw's, not as the agent's estimate", () => {
    renderPicks({ suggestion: task(), mode: "explore" });
    const drawn = within(suggested()).getByRole("listitem");
    expect(drawn).toHaveTextContent("This draw: 72% success · $0.15 a run · 12 counted outcomes");
    expect(drawn).not.toHaveTextContent("about");
    cleanup();
    renderPicks({ suggestion: task(), mode: "greedy" });
    const ranked = within(suggested()).getByRole("listitem");
    expect(ranked).toHaveTextContent("72% success · about $0.15 a run · 12 counted outcomes");
    expect(ranked).not.toHaveTextContent("This draw");
  });

  it("never shows a cost that is only the prior in dollars, even with counted outcomes", () => {
    for (const mode of ["greedy", "explore"] as const) {
      renderPicks({ suggestion: task({ picks: [pick({ cost_is_prior: true })] }), mode });
      const row = within(suggested()).getByRole("listitem");
      expect(row).toHaveTextContent("72% success · no metered cost yet · 12 counted outcomes");
      expect(row).not.toHaveTextContent("$");
      cleanup();
    }
  });

  it("tells a measured cost, a prior and an unreported cost apart, as the control plane sends them", () => {
    // The same pick three ways: cost_is_prior false, true, and absent (an older control plane, which has no
    // such field and so says nothing either way about the cost).
    const older: Record<string, unknown> = { ...pick() };
    delete older.cost_is_prior;
    const answers = [{ ...older, cost_is_prior: false }, { ...older, cost_is_prior: true }, older];
    const shown = answers.map((p) => {
      const read = readSuggestions({ mode: "greedy", tasks: [{ index: 0, budget_usdc_units: "500000", picks: [p] }] });
      renderPicks({ suggestion: read?.tasks[0], mode: "greedy" });
      const text = within(suggested()).getByRole("listitem").textContent;
      cleanup();
      return text;
    });
    expect(shown[0]).toContain("72% success · about $0.15 a run · 12 counted outcomes");
    expect(shown[1]).toContain("72% success · no metered cost yet · 12 counted outcomes");
    expect(shown[2]).toContain("72% success · cost not reported · 12 counted outcomes");
    expect(shown[2]).not.toContain("$");
  });

  it("shows a cent from exactly 10 000 micros, where formatUsdc first prints one", () => {
    renderPicks({ suggestion: task({ picks: [pick({ assumed_cost_micros: 9_999 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("under $0.01 a run");
    cleanup();
    renderPicks({ suggestion: task({ picks: [pick({ assumed_cost_micros: 10_000 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("about $0.01 a run");
    cleanup();
    renderPicks({ suggestion: task({ picks: [pick({ assumed_cost_micros: 0.4 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("under $0.01 a run");
  });

  it("never rounds a success rate to a certainty it cannot have", () => {
    renderPicks({ suggestion: task({ picks: [pick({ assumed_success: 0.996 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("99% success");
    cleanup();
    renderPicks({ suggestion: task({ picks: [pick({ assumed_success: 0.003 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("1% success");
    cleanup();
    renderPicks({ suggestion: task({ picks: [pick({ assumed_success: 0.5 })] }) });
    expect(within(suggested()).getByRole("listitem")).toHaveTextContent("50% success");
  });

  it("renders the manual pick slots alone when there are no suggestions (not loaded, or failed)", () => {
    const onChange = renderPicks();
    expect(screen.getByLabelText("Task 1: runs it")).toBeInTheDocument();
    expect(screen.queryByText("Suggested")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use suggestion" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Task 1: runs it"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(["2"]);
  });
});
