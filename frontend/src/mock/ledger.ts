/*
 * Proof ledger & analytics, following the dashboard in the landing design
 * video. Every number is illustrative until the indexer exists. Series are
 * written out, not generated, so screenshots and tests stay stable.
 */
import { proof } from "./data";

export const ledgerStats = [
  {
    label: "Runs this week",
    value: 1284,
    format: "int",
    sub: "+18.2% vs last week",
    tone: "up",
    color: "var(--chart-purple)",
    trend: [62, 70, 64, 63, 55, 52, 46, 50, 41, 44, 48, 47],
  },
  {
    label: "Proofs settled",
    value: 7702,
    format: "int",
    sub: "6 of 6 on latest run",
    tone: "up",
    color: "var(--chart-green)",
    trend: [60, 62, 52, 49, 41, 40, 37, 42, 41, 47, 53, 50],
  },
  {
    label: "Tests passed",
    value: 41260,
    format: "int",
    sub: "99.4% pass rate",
    tone: "up",
    color: "var(--chart-yellow)",
    trend: [58, 56, 49, 44, 40, 41, 46, 44, 47, 52, 50, 43],
  },
  {
    label: "Avg cost / run",
    value: 0.012,
    format: "usd3",
    sub: "−9.1% this week",
    tone: "up",
    color: "var(--chart-green)",
    trend: [44, 43, 42, 45, 41, 43, 46, 52, 57, 58, 58, 55],
  },
] as const;

/** Hourly runs and settled proofs over the last 28 hours (index 0 = 28h ago). */
export const hourly = {
  labels: Array.from({ length: 29 }, (_, i) => `${String(i % 24).padStart(2, "0")}:00`),
  runs: [
    41, 60, 59, 63, 71, 68, 63, 64, 61, 57, 58, 60, 66, 67, 78, 89, 94, 92, 101, 98, 99, 95, 82, 85, 90, 90, 95, 102,
    106,
  ],
  proofs: [
    25, 40, 41, 44, 48, 43, 37, 36, 33, 31, 34, 40, 42, 47, 53, 58, 59, 55, 58, 56, 58, 57, 54, 57, 62, 61, 62, 64, 65,
  ],
};

export const workByAgent = [
  { name: "Code", share: 34, color: "var(--chart-purple)" },
  { name: "Research", share: 24, color: "var(--chart-green)" },
  { name: "QA", share: 18, color: "var(--chart-yellow)" },
  { name: "Review", share: 14, color: "var(--chart-rose)" },
  { name: "Docs", share: 10, color: "var(--chart-gray)" },
];
export const totalTasks = 1284;

/** Proofs settled in each of the last 22 blocks; the last bar is the live block. */
export const proofsPerBlock = [9, 9, 5, 5, 8, 5, 3, 4, 5, 4, 9, 7, 8, 9, 2, 4, 6, 6, 5, 3, 9, 2];

/** Tasks per hour over 7 days: 7 rows (days) by 24 columns (hours), 0–4 intensity. */
export const activityGrid = [
  [2, 2, 2, 3, 2, 3, 2, 4, 3, 4, 3, 4, 4, 4, 4, 3, 4, 4, 4, 4, 3, 2, 2, 2],
  [2, 3, 2, 2, 3, 2, 3, 2, 3, 1, 1, 1, 1, 1, 0, 1, 2, 1, 1, 2, 1, 1, 0, 1],
  [0, 0, 1, 1, 2, 2, 2, 2, 2, 3, 3, 2, 3, 3, 3, 4, 4, 4, 4, 3, 4, 4, 3, 4],
  [4, 4, 3, 3, 4, 4, 4, 3, 3, 2, 3, 3, 2, 2, 2, 2, 1, 2, 0, 0, 1, 1, 1, 2],
  [1, 0, 1, 1, 1, 0, 1, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 3, 3, 2, 3, 2, 3],
  [4, 4, 4, 4, 3, 3, 4, 3, 4, 4, 3, 4, 3, 4, 3, 3, 3, 4, 3, 3, 3, 3, 2, 2],
  [2, 2, 2, 2, 1, 1, 2, 2, 1, 1, 0, 1, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 3, 1],
];

export type Settlement = { tx: string; call: string; agent: string; gas: string; proofId?: string };

/** On-chain receipts, newest first. Only the first has a full demo receipt behind it. */
export const settlementTrace: Settlement[] = [
  { tx: "0xa9c3…08d2", call: "commitReceipt()", agent: "Coder", gas: "21,432", proofId: proof.id },
  { tx: "0x3a7c…e010", call: "commitReceipt()", agent: "Tester", gas: "19,880" },
  { tx: "0x91bd…77a2", call: "anchorDensity()", agent: "Research", gas: "12,104" },
  { tx: "0x5e02…c3f8", call: "commitReceipt()", agent: "Reviewer", gas: "20,311" },
  { tx: "0xd41a…09be", call: "anchorRoot()", agent: "Planner", gas: "8,762" },
];

export const LEDGER_FIRST_BLOCK = 18_492_301;
