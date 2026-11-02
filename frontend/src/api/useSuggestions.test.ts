// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSuggestions } from "./client";
import type { SuggestionsResponse } from "./types";
import { useSuggestions } from "./useSuggestions";

vi.mock("./client", async (actual) => ({ ...(await actual<typeof import("./client")>()), getSuggestions: vi.fn() }));
const fetchSuggestions = vi.mocked(getSuggestions);

const UUID = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";

const answer = (mode: SuggestionsResponse["mode"]): SuggestionsResponse => ({
  plan_id: `0x${"ab".repeat(32)}`,
  mode,
  seed: mode === "explore" ? 7 : null,
  note: "A suggestion, not an assignment.",
  tasks: [{ index: 0, budget_usdc_units: "500000", picks: [], ineligible: [] }],
});

afterEach(() => {
  fetchSuggestions.mockReset();
});

describe("useSuggestions", () => {
  it("reads the ranking once on mount and never draws on its own", async () => {
    fetchSuggestions.mockResolvedValue(answer("greedy"));
    const { result, rerender } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    rerender();
    expect(fetchSuggestions.mock.calls).toEqual([[UUID, false]]);
  });

  it("draws once per explicit request, and back to the ranking when it is turned off", async () => {
    fetchSuggestions.mockImplementation((_, explore) => Promise.resolve(answer(explore ? "explore" : "greedy")));
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    act(() => {
      result.current.setExplore(true);
    });
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("explore");
    });
    act(() => {
      result.current.setExplore(false);
    });
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    expect(fetchSuggestions.mock.calls).toEqual([
      [UUID, false],
      [UUID, true],
      [UUID, false],
    ]);
  });

  it("reads the ranking again when the saved budgets change", async () => {
    fetchSuggestions.mockResolvedValue(answer("greedy"));
    const { result, rerender } = renderHook(({ saved }) => useSuggestions(UUID, saved), {
      initialProps: { saved: "500000" },
    });
    await waitFor(() => {
      expect(result.current.suggestions).not.toBeNull();
    });
    rerender({ saved: "900000" });
    await waitFor(() => {
      expect(fetchSuggestions).toHaveBeenCalledTimes(2);
    });
    expect(fetchSuggestions.mock.calls.every(([, explore]) => !explore)).toBe(true);
  });

  it("reports a failed read without throwing, so manual picking carries on", async () => {
    fetchSuggestions.mockRejectedValue(new ApiError(500, "Mergit answered 500."));
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.error).toBe("Mergit answered 500.");
    });
    expect(result.current.suggestions).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("keeps the ranking it has when a draw is refused, and says why", async () => {
    fetchSuggestions.mockResolvedValueOnce(answer("greedy"));
    fetchSuggestions.mockRejectedValueOnce(
      new ApiError(429, "too many exploring suggestions this hour; try again later"),
    );
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    act(() => {
      result.current.setExplore(true);
    });
    await waitFor(() => {
      expect(result.current.error).toBe("too many exploring suggestions this hour; try again later");
    });
    expect(result.current.suggestions?.mode).toBe("greedy");
  });

  it("reads an older control plane's answer (no ineligible, no cost_is_prior) without breaking", async () => {
    // Exactly the shape origin/main's P4 slice 1 answers with, before Task 3 and the cost_is_prior fix.
    const older = {
      plan_id: `0x${"ab".repeat(32)}`,
      mode: "greedy",
      seed: null,
      note: "A suggestion, not an assignment.",
      tasks: [
        {
          index: 0,
          budget_usdc_units: "500000",
          picks: [
            {
              agent_id: "1",
              name: "coder-a",
              score_per_usdc: 4.8,
              assumed_success: 0.72,
              assumed_cost_micros: 150000,
              counted_outcomes: 12,
              unproven: false,
            },
          ],
        },
        { index: 1, budget_usdc_units: "100", picks: [], reason: "no agent is expected to fit this budget" },
      ],
    };
    fetchSuggestions.mockResolvedValue(older as unknown as SuggestionsResponse);
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions).not.toBeNull();
    });
    const [first, second] = result.current.suggestions?.tasks ?? [];
    expect(first?.ineligible).toEqual([]);
    // Without the field nothing says the cost was measured, so it is not shown as if it were.
    expect(first?.picks[0]?.cost_is_prior).toBe(true);
    expect(second).toMatchObject({
      index: 1,
      picks: [],
      ineligible: [],
      reason: "no agent is expected to fit this budget",
    });
  });

  it("drops a task or a pick it cannot read, and keeps the rest", async () => {
    const odd = {
      ...answer("greedy"),
      tasks: [
        { index: 0, budget_usdc_units: "1", picks: "nope" },
        {
          index: 1,
          budget_usdc_units: "1",
          picks: [{ agent_id: 2 }, { agent_id: "x", name: "coder-x" }], // a numeric id; no numbers at all
          ineligible: [
            { agent_id: "3", name: "coder-c" },
            { agent_id: "4", name: "coder-d", reason: "operator at concurrency cap" },
          ],
        },
      ],
    };
    fetchSuggestions.mockResolvedValue(odd as unknown as SuggestionsResponse);
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions).not.toBeNull();
    });
    const tasks = result.current.suggestions?.tasks ?? [];
    expect(tasks.map((t) => t.index)).toEqual([1]);
    expect(tasks[0]?.picks).toEqual([]);
    expect(tasks[0]?.ineligible).toEqual([{ agent_id: "4", name: "coder-d", reason: "operator at concurrency cap" }]);
  });

  it("reads the ranking, never a draw, after a save made while exploring", async () => {
    fetchSuggestions.mockImplementation((_, explore) => Promise.resolve(answer(explore ? "explore" : "greedy")));
    const { result, rerender } = renderHook(({ saved }) => useSuggestions(UUID, saved), {
      initialProps: { saved: "500000" },
    });
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    act(() => {
      result.current.setExplore(true);
    });
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("explore");
    });
    rerender({ saved: "900000" });
    expect(result.current.loading).toBe(true); // the old answer is for the old budgets until the new one lands
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.suggestions?.mode).toBe("greedy");
    expect(fetchSuggestions.mock.calls).toEqual([
      [UUID, false],
      [UUID, true],
      [UUID, false],
    ]);
  });

  it("makes one draw for two requests while one is in flight, even in the same batch", async () => {
    fetchSuggestions.mockResolvedValueOnce(answer("greedy"));
    fetchSuggestions.mockReturnValue(new Promise(() => undefined)); // the draw never answers
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.suggestions?.mode).toBe("greedy");
    });
    act(() => {
      result.current.setExplore(true);
      result.current.setExplore(true);
    });
    act(() => {
      result.current.setExplore(true);
    });
    expect(result.current.loading).toBe(true);
    expect(fetchSuggestions.mock.calls.filter(([, explore]) => explore)).toHaveLength(1);
  });

  it("treats an answer without a task list as no suggestions", async () => {
    fetchSuggestions.mockResolvedValue({ detail: "not this service" } as unknown as SuggestionsResponse);
    const { result } = renderHook(() => useSuggestions(UUID, "500000"));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.suggestions).toBeNull();
    expect(result.current.error).toBeDefined();
  });
});
