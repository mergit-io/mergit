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

/** One agent in one category, as `GET /v0/agents/reputation` reports it. Costs are USDC base units (micros). */
export type AgentReputation = {
  agent_id: string;
  name: string;
  category: string;
  /** "validated outcomes", or "prior (no counted outcomes)" when the figures are only configuration. */
  basis: string;
  counted_outcomes: number;
  /** Outcomes funded from free credits: shown, never counted. */
  uncounted_credit_outcomes: number;
  success_mean: number;
  cost_mean_micros: number;
  /** Success per USDC. */
  value_density_per_usdc: number;
  effective_sample_size: number;
};

export type ReputationResponse = { note: string; agents: AgentReputation[] };

export type SuggestedPick = {
  agent_id: string;
  name: string;
  score_per_usdc: number;
  assumed_success: number;
  assumed_cost_micros: number;
  counted_outcomes: number;
  /** Too few counted outcomes to trust. The platform does not yet cover the cost if an unproven agent fails. */
  unproven: boolean;
};

export type TaskSuggestion = {
  index: number;
  budget_usdc_units: string;
  picks: SuggestedPick[];
  /** Why there are no picks, when there are none. */
  reason?: string;
};

export type Suggestions = {
  plan_id: string;
  mode: "greedy" | "explore";
  seed: number | null;
  note: string;
  tasks: TaskSuggestion[];
};

/** One exploring suggestion mirrored onto Arkiv's Rabdi testnet (ETHGlobal Mumbai's "Build on Arkiv" track),
 * as read back through `arkiv_query` rather than from this plan's own Postgres row. */
export type ArkivDecision = {
  entity_key: string;
  task_index: number;
  category: string;
  decided_at: string;
  candidates: unknown[];
  picks: unknown[];
};

export type ArkivSuggestions = {
  /** False when the server has no `ARKIV_*` configured; the panel that renders this should then hide. */
  enabled: boolean;
  query?: string;
  decisions: ArkivDecision[];
};

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
