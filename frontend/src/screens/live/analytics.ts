import type { PlanState, PlanSummary } from "../../api/types";
import type { Commitment } from "../../chain/commitments";

/**
 * The numbers behind the live dashboard's charts. Every value is derived from what the API and the chain return;
 * with nothing returned, every series is zeros of the right length, so a chart still draws its axes and empty bars.
 */

const DAY_MS = 86_400_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local midnight of the day `t` falls in. */
const dayStart = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();

const finished = (s: PlanState) => s === "done" || s === "failed";

export type DayCount = {
  /** Short weekday, as the chart labels it. */
  day: string;
  /** Calendar date, for the accessible table and tooltips. */
  date: string;
  started: number;
  done: number;
  failed: number;
};

/** Runs started on each of the last `days` days, oldest first, ending today, split by how they ended. */
export function runsPerDay(plans: Pick<PlanSummary, "created_at" | "state">[], days: number, now = new Date()) {
  const today = dayStart(now);
  const buckets: DayCount[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(today - (days - 1 - i) * DAY_MS);
    return {
      day: WEEKDAY[d.getDay()] ?? "",
      date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      started: 0,
      done: 0,
      failed: 0,
    };
  });
  for (const p of plans) {
    const t = Date.parse(p.created_at);
    if (Number.isNaN(t)) continue;
    // Round, not floor: a day that crosses a daylight-saving change is 23 or 25 hours long.
    const back = Math.round((today - dayStart(new Date(t))) / DAY_MS);
    const bucket = buckets[days - 1 - back];
    if (!bucket) continue;
    bucket.started += 1;
    if (p.state === "done") bucket.done += 1;
    if (p.state === "failed") bucket.failed += 1;
  }
  return buckets;
}

/** Done runs as a share of the runs that finished, or null when none has finished yet. */
export function successRate(plans: Pick<PlanSummary, "state">[]): number | null {
  const ended = plans.filter((p) => finished(p.state));
  if (ended.length === 0) return null;
  return ended.filter((p) => p.state === "done").length / ended.length;
}

export type Share = { name: string; count: number; color: string };

const STATE_PARTS: { name: string; states: PlanState[]; color: string }[] = [
  { name: "In progress", states: ["approved", "funded", "running"], color: "var(--chart-purple)" },
  { name: "Done", states: ["done"], color: "var(--chart-green)" },
  { name: "Drafts", states: ["draft"], color: "var(--chart-yellow)" },
  { name: "Failed", states: ["failed"], color: "var(--chart-rose)" },
  { name: "Closed", states: ["closed"], color: "var(--chart-gray)" },
];

/** Runs counted by where they are now. Every part is listed, even at zero, so the legend reads the same each time. */
export function runsByState(plans: Pick<PlanSummary, "state">[]): Share[] {
  return STATE_PARTS.map(({ name, states, color }) => ({
    name,
    color,
    count: plans.filter((p) => states.includes(p.state)).length,
  }));
}

/**
 * Runs started in each hour of each of the last 7 days: 7 rows (oldest day first) of 24 levels from 0 (none) to 4
 * (the busiest hour). Levels are relative to the busiest hour, so a quiet week still shows its shape.
 */
export function hourlyActivity(plans: Pick<PlanSummary, "created_at">[], now = new Date()) {
  const today = dayStart(now);
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const p of plans) {
    const t = Date.parse(p.created_at);
    if (Number.isNaN(t)) continue;
    const at = new Date(t);
    const back = Math.round((today - dayStart(at)) / DAY_MS);
    const row = grid[6 - back];
    if (row && back >= 0) row[at.getHours()] = (row[at.getHours()] ?? 0) + 1;
  }
  const max = Math.max(0, ...grid.flat());
  const levels = grid.map((row) => row.map((n) => (n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4)))));
  const days = Array.from({ length: 7 }, (_, i) => WEEKDAY[new Date(today - (6 - i) * DAY_MS).getDay()] ?? "");
  return { counts: grid, levels, days, max };
}

export type BlockCount = { block: bigint; receipts: number };

/** Receipts per block for the `limit` most recent blocks that have any, oldest first. */
export function receiptsPerBlock(receipts: Pick<Commitment, "blockNumber">[], limit: number): BlockCount[] {
  const byBlock = new Map<bigint, number>();
  for (const r of receipts) byBlock.set(r.blockNumber, (byBlock.get(r.blockNumber) ?? 0) + 1);
  return [...byBlock.entries()]
    .map(([block, n]) => ({ block, receipts: n }))
    .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
    .slice(-limit);
}

const AGENT_COLORS = ["var(--chart-purple)", "var(--chart-green)", "var(--chart-yellow)", "var(--chart-rose)"];

/** Receipts by the agent that committed them: the top four by count, then everyone else together. */
export function receiptsByAgent(receipts: Pick<Commitment, "agentId">[], name: (agentId: string) => string): Share[] {
  const byAgent = new Map<string, number>();
  for (const r of receipts) {
    const id = r.agentId.toString();
    byAgent.set(id, (byAgent.get(id) ?? 0) + 1);
  }
  const ranked = [...byAgent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top: Share[] = ranked.slice(0, 4).map(([id, count], i) => ({
    name: name(id),
    count,
    color: AGENT_COLORS[i] ?? "var(--chart-gray)",
  }));
  const rest = ranked.slice(4).reduce((sum, [, n]) => sum + n, 0);
  return rest > 0 ? [...top, { name: "Other agents", count: rest, color: "var(--chart-gray)" }] : top;
}

/** Metered cost of each receipt in USD, oldest first (the list arrives newest first). */
export function costTrend(receipts: Pick<Commitment, "costMicros">[]): number[] {
  return receipts.map((r) => Number(r.costMicros) / 1_000_000).reverse();
}

/** Total metered cost of the receipts, in USD. */
export const totalCost = (receipts: Pick<Commitment, "costMicros">[]) =>
  Number(receipts.reduce((sum, r) => sum + r.costMicros, 0n)) / 1_000_000;

/** A round axis maximum that splits into four ticks: 4, 8, 20, 40, 80, 200… */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const raw = value / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  return step * 4;
}
