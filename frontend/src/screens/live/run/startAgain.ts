import { ApiError } from "../../../api/client";
import { parseRepo } from "../../../api/github";
import type { Plan, PlanState } from "../../../api/types";
import { usdcText } from "../../../chain/funding";
import {
  budgetProblem,
  type Fields,
  GOAL_LIMIT,
  goalProblem,
  INITIAL,
  KINDS,
  refProblem,
  repoProblem,
} from "./newRunForm";

/**
 * "Start again": a run that ended closed or failed opens the new-run form filled in from it. The earlier plan only
 * ever supplies text for the form's own fields, and each value goes through the form's own checks first; nothing
 * about its funding, approval, tasks or agent picks is carried over, and the new run is drafted, reviewed, approved
 * and funded like any other.
 */

/** The fields of the new-run form that an earlier plan can fill in. Whatever is absent is left as it is. */
export type NewRunPrefill = Partial<Fields>;

/** Only a plan that ended without finishing is offered again: done work is not redone, and an active plan is not over. */
export const canStartAgain = (state: PlanState): boolean => state === "closed" || state === "failed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The plan to fill the form from, named by `?from=<plan uuid>`; anything that is not exactly one UUID is ignored. */
export function sourcePlanId(search: string | URLSearchParams): string | null {
  const values = new URLSearchParams(search).getAll("from");
  const [value] = values;
  return values.length === 1 && value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
}

type Source = Pick<Plan, "state" | "goal" | "repo_url" | "ref" | "category" | "budget_usdc_units">;

/** Control characters other than a line break or tab. */
const CONTROL = /[^\P{Cc}\n\t]/gu;
/** Characters that reorder text on screen (bidirectional overrides and isolates). */
const BIDI = /[‪-‮⁦-⁩]/g;
const hasControl = (text: string) => /\p{Cc}/u.test(text);

/** Longest branch, tag or commit the form is asked to take. */
const REF_LIMIT = 255;

const cleanGoal = (goal: string) => goal.replace(/\r\n/g, "\n").replace(CONTROL, "").replace(BIDI, "").trim();

/**
 * The form's fields from an earlier plan that ended closed or failed. A value the form would refuse, or that is not
 * text, is left out (so the form keeps its own default) rather than cut or repaired.
 */
export function prefillFromPlan(plan: Source): NewRunPrefill {
  if (!canStartAgain(plan.state)) return {};
  const out: NewRunPrefill = {};

  if (typeof plan.goal === "string") {
    const goal = cleanGoal(plan.goal);
    if (goalProblem(goal) === null && goal.length <= GOAL_LIMIT) out.goal = goal;
  }

  // The same reading of a repository the form applies to what is typed: only a GitHub repository, as owner/name.
  const parsed = typeof plan.repo_url === "string" ? parseRepo(plan.repo_url) : null;
  if (parsed) {
    const repo = `${parsed.owner}/${parsed.name}`;
    if (repoProblem(repo) === null) out.repo = repo;
  }

  if (typeof plan.ref === "string") {
    const ref = plan.ref.trim();
    if (refProblem(ref) === null && ref.length <= REF_LIMIT && !hasControl(ref)) out.ref = ref;
  }

  if (typeof plan.budget_usdc_units === "string" && /^\d{1,20}$/.test(plan.budget_usdc_units)) {
    const budget = usdcText(BigInt(plan.budget_usdc_units));
    if (budgetProblem(budget) === null) out.budget = budget;
  }

  if (typeof plan.category === "string" && KINDS.some((k) => k.value === plan.category)) {
    out.category = plan.category;
  }
  return out;
}

/** The form with the prefill in the fields that are still empty or at their starting value; typed values stay. */
export function applyPrefill(fields: Fields, prefill: NewRunPrefill): Fields {
  const next = { ...fields };
  if (prefill.goal !== undefined && fields.goal.trim() === "") next.goal = prefill.goal;
  if (prefill.repo !== undefined && fields.repo.trim() === "") next.repo = prefill.repo;
  if (prefill.ref !== undefined && fields.ref === INITIAL.ref) next.ref = prefill.ref;
  if (prefill.budget !== undefined && fields.budget === INITIAL.budget) next.budget = prefill.budget;
  if (prefill.category !== undefined && fields.category === INITIAL.category) next.category = prefill.category;
  return next;
}

/** What to tell the requester once the form is filled in: what it was, and that nothing has been paid or approved. */
export function filledMessage(prefill: NewRunPrefill): string {
  const count = Object.keys(prefill).length;
  if (count === 0) return "Nothing from the earlier plan could be reused. Describe the run below instead.";
  const partial = count < Object.keys(INITIAL).length ? " Some details could not be reused; check the rest." : "";
  return `Filled in from your earlier plan. Check it, then draft the plan. Nothing is paid until you approve and fund it.${partial}`;
}

/** What to tell the requester when the earlier plan cannot be read. The form stays usable either way. */
export function loadFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "That earlier plan is not one of yours, so the form was not filled in from it.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "That earlier plan could not be found, so the form was not filled in from it.";
  }
  return "Could not load the earlier plan to fill in the form. Describe the run below instead.";
}
