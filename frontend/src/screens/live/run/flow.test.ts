import { describe, expect, it } from "vitest";
import { layoutFlow } from "./flow";

const task = (index: number, depends_on: number[] = []) => ({ index, depends_on });

describe("layoutFlow", () => {
  it("puts each task one row below the deepest task it waits on", () => {
    // 0 -> 1, 0 -> 2, (1, 2) -> 3, and 4 on its own.
    const flow = layoutFlow([task(0), task(1, [0]), task(2, [0]), task(3, [1, 2]), task(4)]);
    expect(flow.rows).toEqual([[0, 4], [1, 2], [3]]);
    expect(flow.edges).toEqual([
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it("orders a row by task index whatever order the tasks arrive in", () => {
    expect(layoutFlow([task(2), task(0), task(1)]).rows).toEqual([[0, 1, 2]]);
  });

  it("ignores dependencies on tasks that are not in the plan and survives a cycle", () => {
    expect(layoutFlow([task(0, [9])]).rows).toEqual([[0]]);
    expect(
      layoutFlow([task(0, [1]), task(1, [0])])
        .rows.flat()
        .sort(),
    ).toEqual([0, 1]);
  });

  it("is empty for no tasks", () => {
    expect(layoutFlow([])).toEqual({ row: new Map(), rows: [], edges: [] });
  });
});
