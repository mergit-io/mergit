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
