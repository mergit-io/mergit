import { describe, expect, it } from "vitest";
import type { PlanState } from "../../api/types";
import {
  costTrend,
  hourlyActivity,
  niceMax,
  receiptsByAgent,
  receiptsPerBlock,
  runsByState,
  runsPerDay,
  successRate,
  totalCost,
} from "./analytics";

// A Wednesday, mid-afternoon local time.
const NOW = new Date(2026, 9, 28, 15, 30);
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 28 - daysAgo, hour, 5).toISOString();
const plan = (state: PlanState, created_at = at(0, 9)) => ({ state, created_at });

describe("runsPerDay", () => {
  it("is zeros for every day, ending today, when there are no runs", () => {
    const days = runsPerDay([], 7, NOW);
    expect(days.map((d) => d.day)).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
    expect(days.every((d) => d.started === 0 && d.done === 0 && d.failed === 0)).toBe(true);
  });

  it("counts each run on the day it started, split by how it ended", () => {
    const days = runsPerDay(
      [plan("done", at(0, 1)), plan("failed", at(0, 23)), plan("running", at(2, 12)), plan("done", at(6, 0))],
      7,
      NOW,
    );
    expect(days.at(-1)).toMatchObject({ started: 2, done: 1, failed: 1 });
    expect(days.at(-3)).toMatchObject({ started: 1, done: 0, failed: 0 });
    expect(days[0]).toMatchObject({ started: 1, done: 1 });
  });

  it("leaves out runs older than the window and unparseable dates", () => {
    const days = runsPerDay([plan("done", at(7, 12)), plan("done", "not a date")], 7, NOW);
    expect(days.reduce((n, d) => n + d.started, 0)).toBe(0);
  });
});

describe("successRate", () => {
  it("is null until a run has finished", () => {
    expect(successRate([])).toBeNull();
    expect(successRate([plan("running"), plan("draft")])).toBeNull();
  });

  it("is done runs over finished runs", () => {
    expect(successRate([plan("done"), plan("done"), plan("failed"), plan("running")])).toBeCloseTo(2 / 3);
  });
});

describe("runsByState", () => {
  it("lists every state, even at zero", () => {
    const parts = runsByState([plan("funded"), plan("running"), plan("done"), plan("closed")]);
    expect(parts.map((p) => [p.name, p.count])).toEqual([
      ["In progress", 2],
      ["Done", 1],
      ["Drafts", 0],
      ["Failed", 0],
      ["Closed", 1],
    ]);
  });
});

describe("hourlyActivity", () => {
  it("is an empty 7 by 24 grid with no runs", () => {
    const a = hourlyActivity([], NOW);
    expect(a.levels).toHaveLength(7);
    expect(a.levels.every((row) => row.length === 24 && row.every((l) => l === 0))).toBe(true);
    expect(a.days.at(-1)).toBe("Wed");
    expect(a.max).toBe(0);
  });

  it("places runs by day and hour, scaled to the busiest hour", () => {
    const a = hourlyActivity(
      [
        { created_at: at(0, 9) },
        { created_at: at(0, 9) },
        { created_at: at(0, 9) },
        { created_at: at(0, 9) },
        { created_at: at(3, 14) },
      ],
      NOW,
    );
    expect(a.counts[6]?.[9]).toBe(4);
    expect(a.levels[6]?.[9]).toBe(4);
    expect(a.levels[3]?.[14]).toBe(1);
  });
});

describe("receipts", () => {
  const r = (block: number, agent: number, micros: number) => ({
    blockNumber: BigInt(block),
    agentId: BigInt(agent),
    costMicros: BigInt(micros),
  });
  // Newest first, as the gateway lists them.
  const rows = [r(30, 2, 3000), r(30, 1, 2000), r(12, 1, 1000)];

  it("counts receipts per block, oldest block first, keeping the latest blocks", () => {
    expect(receiptsPerBlock(rows, 24)).toEqual([
      { block: 12n, receipts: 1 },
      { block: 30n, receipts: 2 },
    ]);
    expect(receiptsPerBlock(rows, 1)).toEqual([{ block: 30n, receipts: 2 }]);
  });

  it("ranks agents by receipts and folds the rest together", () => {
    const many = [1, 1, 1, 2, 2, 3, 4, 5, 6].map((a) => r(1, a, 1));
    const parts = receiptsByAgent(many, (id) => `Agent ${id}`);
    expect(parts.map((p) => [p.name, p.count])).toEqual([
      ["Agent 1", 3],
      ["Agent 2", 2],
      ["Agent 3", 1],
      ["Agent 4", 1],
      ["Other agents", 2],
    ]);
    expect(receiptsByAgent([], String)).toEqual([]);
  });

  it("gives cost oldest first, in USD, and the total", () => {
    expect(costTrend(rows)).toEqual([0.001, 0.002, 0.003]);
    expect(totalCost(rows)).toBeCloseTo(0.006);
  });
});

describe("niceMax", () => {
  it("is a round number that splits into four ticks", () => {
    expect([0, 1, 4, 5, 9, 17, 41, 130].map(niceMax)).toEqual([4, 4, 4, 8, 20, 20, 80, 200]);
  });
});
