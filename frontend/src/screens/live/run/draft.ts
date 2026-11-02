import type { ApproveRequest, Funding, Phi, Plan, TaskEdit } from "../../../api/types";
import { parseUsdc, usdcText } from "../../../chain/funding";

/** The requester's picks per task: the agent that runs, then the retries in order (plan task O3). */
export const MAX_PICKS = 3;

/** One task as the draft editor holds it: free text the requester types, checked before it is sent. */
export type TaskForm = {
  index: number;
  title: string;
  instructions: string;
  /** Φ as pretty JSON. The API validates its shape; the editor only checks that it parses. */
  phiText: string;
  /** USDC, as typed ("0.5"). */
  budget: string;
  dependsOn: number[];
  agents: string[];
};

export function toForms(plan: Plan): TaskForm[] {
  return plan.tasks.map((t) => ({
    index: t.index,
    title: t.title,
    instructions: t.instructions,
    phiText: JSON.stringify(t.phi, null, 2),
    budget: usdcText(BigInt(t.budget_usdc_units)),
    dependsOn: t.depends_on,
    agents: t.agents ?? [],
  }));
}

function parsePhi(text: string): Phi | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Phi) : null;
  } catch {
    return null;
  }
}

const taskLabel = (f: TaskForm) => `Task ${String(f.index + 1)}`;

/** What would stop the tasks from saving, one line per problem, task numbers from 1. */
export function editProblems(forms: TaskForm[]): string[] {
  return forms.flatMap((f) => {
    const problems: string[] = [];
    if (!f.title.trim()) problems.push(`${taskLabel(f)}: the title is empty.`);
    if (!parsePhi(f.phiText)) problems.push(`${taskLabel(f)}: the check (Φ) is not a JSON object.`);
    const budget = parseUsdc(f.budget);
    if (budget === null || budget <= 0n) problems.push(`${taskLabel(f)}: the budget must be a positive USDC amount.`);
    return problems;
  });
}

/** What would stop the approval on top of that: every task needs an agent, none picked twice, and no
 * more than MAX_PICKS, so a form the editor itself can't produce isn't only caught server-side after
 * the requester has already clicked Approve. */
export function pickProblems(forms: TaskForm[]): string[] {
  return forms.flatMap((f) => {
    if (f.agents.length === 0) return [`${taskLabel(f)}: pick an agent to run it.`];
    if (f.agents.length > MAX_PICKS) return [`${taskLabel(f)}: pick at most ${String(MAX_PICKS)} agents.`];
    return new Set(f.agents).size === f.agents.length ? [] : [`${taskLabel(f)}: an agent is picked twice.`];
  });
}

/** The PATCH body. Call only once `editProblems` is empty. */
export function toEdits(forms: TaskForm[]): TaskEdit[] {
  return forms.map((f) => ({
    title: f.title.trim(),
    instructions: f.instructions.trim(),
    phi: parsePhi(f.phiText) ?? {},
    budget_usdc_units: (parseUsdc(f.budget) ?? 0n).toString(),
    depends_on: f.dependsOn,
  }));
}

/** Whether the tasks (not the picks, which only go out with the approval) differ from the saved plan. */
export function hasEdits(plan: Plan, forms: TaskForm[]): boolean {
  if (forms.some((f) => !parsePhi(f.phiText) || parseUsdc(f.budget) === null)) return true;
  const saved = plan.tasks.map((t) => ({
    title: t.title,
    instructions: t.instructions,
    phi: t.phi,
    budget_usdc_units: t.budget_usdc_units,
    depends_on: t.depends_on,
  }));
  return JSON.stringify(saved) !== JSON.stringify(toEdits(forms));
}

export function toApproval(forms: TaskForm[], funding: Funding): ApproveRequest {
  return { agents: Object.fromEntries(forms.map((f) => [String(f.index), f.agents])), funding };
}

export function totalBudget(forms: TaskForm[]): bigint {
  return forms.reduce((sum, f) => sum + (parseUsdc(f.budget) ?? 0n), 0n);
}
