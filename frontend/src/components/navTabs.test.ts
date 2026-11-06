import { describe, expect, it } from "vitest";
import { navTabs } from "./navTabs";

const labels = (mode: "mock" | "live") => navTabs(mode).map((t) => t.label);

describe("navTabs", () => {
  it("shows only pages with real data behind them on live data", () => {
    expect(labels("live")).toEqual(["Overview", "Runs", "Agents", "Proofs", "Leaderboard"]);
  });

  it("shows every page of the design on the demo site", () => {
    expect(labels("mock")).toEqual(["Overview", "Runs", "Agents", "Proofs", "Leaderboard", "Integrations"]);
  });
});
