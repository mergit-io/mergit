import type { Hex } from "viem";

/**
 * Wire types of the control-plane API (plan tasks O3, O6 and O7). Amounts are USDC base units as decimal
 * strings, exactly as the API sends them; convert with `BigInt` at the point of use.
 */

export type PlanState = "draft" | "approved" | "funded" | "running" | "done" | "failed" | "closed";
export type Funding = "wallet" | "credits";

/** A task's check, as spec/schemas/predicate.json defines it. Edited as JSON, validated by the API. */
export type Phi = Record<string, unknown>;

export type PlanTask = {
  index: number;
  title: string;
  instructions: string;
  phi: Phi;
  /** Fixed at approval; null on a draft. */
  phi_hash: Hex | null;
  budget_usdc_units: string;
  depends_on: number[];
  /** The requester's picks: the first runs, the rest are retries in order. Null on a draft. */
  agents: string[] | null;
};

export type Plan = {
  plan_uuid: string;
  plan_id: Hex;
  requester: string;
  state: PlanState;
  goal: string;
  repo_url: string;
  ref: string;
  category: string;
  budget_usdc_units: string;
  funding: Funding | null;
  total_budget_usdc_units: string | null;
  created_at: string;
  approved_at: string | null;
  tasks: PlanTask[];
};

export type JobStatus = "queued" | "running" | "done" | "error";

/** One dispatched attempt at one task index (a `jobs` row). */
export type Attempt = {
  task_id: Hex;
  index: number;
  attempt: number;
  agent_id: string;
  status: JobStatus;
  /** The Φ result: true passed, false failed, null not finished or inconclusive. */
  phi_holds: boolean | null;
  receipt_root: Hex | null;
  notes: string | null;
  finished_at: string | null;
};

/** A gateway event about this plan's money or verdicts, as the gateway sent it. */
export type MoneyEvent = { type: string; at: string; payload: Record<string, unknown> };

export type PlanDetail = Plan & { attempts: Attempt[]; money_events: MoneyEvent[] };

export type PlanSummary = Pick<
  Plan,
  "plan_uuid" | "plan_id" | "state" | "goal" | "category" | "budget_usdc_units" | "created_at"
>;

export type AgentInfo = { agent_id: string; name: string; model: string };

export type StepCost = {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  wall_ms: number;
  usd_micros: number;
};

/** One step of an agent's run, relayed live as the worker records it. */
export type StepEvent = { task_id: Hex; seq: number; type: string; cost: Partial<StepCost> };

export type NewPlanRequest = {
  goal: string;
  repo_url: string;
  ref: string;
  budget_usdc_units: string;
  category: string;
};

export type TaskEdit = Pick<PlanTask, "title" | "instructions" | "phi" | "budget_usdc_units" | "depends_on">;

export type ApproveRequest = {
  /** Per task index, as a string key: the agent ids the requester allows, in order. */
  agents: Record<string, string[]>;
  funding: Funding;
};

export type ApproveResponse = { plan_id: Hex; total_budget_usdc_units: string };

/** One agent the control plane suggests for a task, best first. Advice only: `/approve` is unchanged. */
export type Suggestion = {
  agent_id: string;
  name: string;
  score_per_usdc: number;
  /** Chance of passing the check, 0 to 1, from the agent's posterior. Only the prior when `counted_outcomes` is 0. */
  assumed_success: number;
  /** Cost of one run, micro-USD (the same scale as USDC base units). */
  assumed_cost_micros: number;
  counted_outcomes: number;
  /** Too few counted outcomes for the platform to vouch for it; a failed run is not covered. */
  unproven: boolean;
};

/** A roster agent left out of a task's suggestions, with why, as a sentence to show as it is. */
export type IneligibleAgent = { agent_id: string; name: string; reason: string };

export type TaskSuggestions = {
  index: number;
  budget_usdc_units: string;
  picks: Suggestion[];
  ineligible: IneligibleAgent[];
  /** Only when `picks` is empty: why, as a sentence to show as it is. */
  reason?: string;
};

export type SuggestionsResponse = {
  plan_id: Hex;
  /** `greedy` ranks by expected value; `explore` is one random (Thompson) draw, recorded with its `seed`. */
  mode: "greedy" | "explore";
  seed: number | null;
  note: string;
  tasks: TaskSuggestions[];
};
