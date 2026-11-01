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
  /** "pick": the requester's `agents` runs it. "auto": the control plane routes it by reputation. */
  routing: "pick" | "auto";
  /** For an "auto" task: whether the router may explore an under-observed agent instead of the greedy pick. */
  explore: boolean;
  /** For an "auto" task: whether a retriable failure still counts as a usable (if poor) outcome. */
  retry_tolerant: boolean;
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
  /** Null for a "pick"-routed task, or an "auto" task whose draw hasn't landed yet. */
  routing: { exploratory: boolean; seed: string; greedy_agent: string | null } | null;
};

/** A gateway event about this plan's money or verdicts, as the gateway sent it. */
export type MoneyEvent = { type: string; at: string; payload: Record<string, unknown> };

/**
 * Why a task will not run again on its own. "attempts_exhausted": it used every attempt the service allows.
 * "agents_exhausted": every agent it may run with has tried it (the requester's picks, or for an "auto" task
 * the whole roster). "over_budget": an "auto" task with no untried agent that can fit its budget, possibly
 * before a single attempt.
 */
export type NeedsRequesterReason = "attempts_exhausted" | "agents_exhausted" | "over_budget";

/** One task the control plane will not dispatch again on its own (`outcomes.stuck_reasons`). */
export type NeedsRequester = { index: number; reason: NeedsRequesterReason };

export type PlanDetail = Plan & {
  attempts: Attempt[];
  money_events: MoneyEvent[];
  /** The server's own answer to "is this task stuck", sent whole and kept current over the stream. */
  needs_requester: NeedsRequester[];
};

export type PlanSummary = Pick<
  Plan,
  "plan_uuid" | "plan_id" | "state" | "goal" | "category" | "budget_usdc_units" | "created_at"
>;

/** An agent's recorded performance in one category: the posterior mean and how many observations back it. */
export type AgentReputation = {
  category: string;
  theta_mean: number;
  cost_mean_micros: number;
  density: number;
  outcomes: number;
  costs: number;
};

export type AgentInfo = {
  agent_id: string;
  name: string;
  model: string;
  provider: string;
  reputation: AgentReputation[];
};

/** One agent's eligibility and reputation for one task, as the router ranks it. */
export type Candidate = {
  agent_id: string;
  name: string;
  model: string;
  provider: string;
  operator: string;
  theta_mean: number;
  cost_mean_micros: number;
  density: number;
  outcomes: number;
  costs: number;
  eligible: boolean;
  /** Why it is left out of the draw, e.g. "over budget for this task"; null when eligible. */
  reason: string | null;
  /** Its mean cost fits the task's budget. False: only an exploratory draw can pick it. */
  within_budget: boolean;
};

export type TaskCandidates = {
  index: number;
  routing: "pick" | "auto";
  explore: boolean;
  retry_tolerant: boolean;
  candidates: Candidate[];
};

export type CandidatesResponse = { tasks: TaskCandidates[] };

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
  /** Per task index, as a string key: the agent ids the requester allows, in order, or "auto" to route it. */
  agents: Record<string, string[] | "auto">;
  /** Only meaningful for an index marked "auto" in `agents`; omit or leave empty otherwise. */
  routing?: Record<string, { explore: boolean; retry_tolerant: boolean }>;
  funding: Funding;
};

export type ApproveResponse = { plan_id: Hex; total_budget_usdc_units: string };
