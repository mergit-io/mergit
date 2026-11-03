import type { PlanTask } from "../../../api/types";

/**
 * Where each task of a plan sits in its flow graph: tasks with no dependency on the first row, every other task one
 * row below the deepest task it depends on, and tasks on the same row in index order.
 */
export type FlowLayout = {
  /** Row of each task, by task index. */
  row: Map<number, number>;
  /** Task indexes on each row, left to right. */
  rows: number[][];
  /** Every dependency as [from, to]: `to` waits on `from`. */
  edges: [from: number, to: number][];
};

export function layoutFlow(tasks: Pick<PlanTask, "index" | "depends_on">[]): FlowLayout {
  const byIndex = new Map(tasks.map((t) => [t.index, t]));
  const row = new Map<number, number>();
  // The API only accepts acyclic plans; `visiting` keeps a bad answer from recursing forever all the same.
  const visiting = new Set<number>();
  const depth = (index: number): number => {
    const known = row.get(index);
    if (known !== undefined) return known;
    const task = byIndex.get(index);
    if (!task || visiting.has(index)) return 0;
    visiting.add(index);
    const deps = task.depends_on.filter((d) => byIndex.has(d));
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
    visiting.delete(index);
    row.set(index, d);
    return d;
  };
  for (const t of tasks) depth(t.index);
  const rows: number[][] = [];
  for (const t of [...tasks].sort((a, b) => a.index - b.index)) {
    const r = row.get(t.index) ?? 0;
    (rows[r] ??= []).push(t.index);
  }
  const edges = tasks.flatMap((t) =>
    t.depends_on.filter((d) => byIndex.has(d)).map((d): [number, number] => [d, t.index]),
  );
  return { row, rows: rows.filter(Boolean), edges };
}
