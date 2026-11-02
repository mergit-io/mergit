// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSuggestions } from "../../../api/client";
import type { SuggestionsResponse } from "../../../api/types";
import { useSuggestions } from "../../../api/useSuggestions";
import { SuggestionsPanel } from "./SuggestionsPanel";

vi.mock("../../../api/client", async (actual) => ({
  ...(await actual<typeof import("../../../api/client")>()),
  getSuggestions: vi.fn(),
}));
const fetchSuggestions = vi.mocked(getSuggestions);

const greedy: SuggestionsResponse = {
  plan_id: `0x${"ab".repeat(32)}`,
  mode: "greedy",
  seed: null,
  note: "A suggestion, not an assignment.",
  tasks: [{ index: 0, budget_usdc_units: "500000", picks: [], ineligible: [] }],
};

/** The panel wired to the real hook, as the draft editor wires it. */
function Harness() {
  const advice = useSuggestions("3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b", "500000");
  return (
    <SuggestionsPanel
      suggestions={advice.suggestions}
      error={advice.error}
      loading={advice.loading}
      stale={false}
      noteId="note"
      onExplore={advice.setExplore}
    />
  );
}

afterEach(() => {
  fetchSuggestions.mockReset();
});

describe("SuggestionsPanel", () => {
  it("makes one draw however often the switch is clicked while it is in flight, and says it is busy", async () => {
    fetchSuggestions.mockResolvedValueOnce(greedy);
    fetchSuggestions.mockReturnValue(new Promise(() => undefined)); // the draw never answers
    render(<Harness />);
    const toggle = await screen.findByRole("switch", { name: "Try a random draw" });
    expect(toggle).toBeEnabled();

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeDisabled();
    });
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(fetchSuggestions.mock.calls.filter(([, explore]) => explore)).toHaveLength(1);
  });

  it("explains in explore mode that the numbers, not only the order, come from the draw", async () => {
    fetchSuggestions.mockResolvedValue({ ...greedy, mode: "explore", seed: 7 });
    render(<Harness />);
    expect(await screen.findByText(/each agent's place and numbers come from one draw/)).toBeInTheDocument();
  });
});
