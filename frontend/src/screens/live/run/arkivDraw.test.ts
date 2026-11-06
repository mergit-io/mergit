import { describe, expect, it } from "vitest";
import type { ArkivDecision } from "../../../api/types";
import { latestDraw } from "./arkivDraw";

const d = (
  task_index: number,
  decided_at: string,
  entity_key = `0x${String(task_index)}${decided_at}`,
): ArkivDecision => ({
  entity_key,
  decision_id: 1,
  task_index,
  category: "test-repair",
  seed: 1,
  budget_micros: 400000,
  decided_at,
  candidates: [],
  picks: [],
});

describe("latestDraw", () => {
  it("is empty for no decisions", () => {
    expect(latestDraw([])).toEqual({ latest: [], earlier: 0 });
  });

  it("keeps only the newest draw, in task order, and counts the rest", () => {
    const older = "2026-11-06T06:19:40.100000+00:00";
    const newer = "2026-11-06T06:21:02.500000+00:00";
    // Arkiv returns them in key order, which mixes draws and tasks (as it did on the live chain).
    const got = latestDraw([d(2, older), d(1, newer), d(0, older), d(2, newer), d(0, newer), d(1, older)]);
    expect(got.latest.map((x) => [x.task_index, x.decided_at])).toEqual([
      [0, newer],
      [1, newer],
      [2, newer],
    ]);
    expect(got.earlier).toBe(3);
  });
});
