import { type Fields, GOAL_LIMIT, INITIAL, KINDS } from "./newRunForm";

/**
 * The new-run form, kept while the requester looks at another page: leaving for Agents or Wallet and coming back
 * finds the goal, repository, branch, budget and kind of work as they were left. It lives in this browser tab only
 * (sessionStorage), keyed on the signed-in address so another account in the same tab never sees it, and is
 * dropped once the plan is drafted or the form is cleared. Nothing here is sent anywhere.
 */
export type NewRunDraft = {
  fields: Fields;
  /** The branch was chosen by hand, so the repository's default branch does not replace it. */
  refTouched: boolean;
  /** The budget was edited by hand, so the free-credit amount does not replace it. */
  budgetTouched: boolean;
};

const PREFIX = "mergit-new-run-draft:";
/** Longest stored text for the repository, branch and budget fields; anything longer is not a draft this form wrote. */
const FIELD_LIMIT = 512;

export const draftKey = (address: string | null | undefined): string =>
  `${PREFIX}${(address ?? "signed-out").toLowerCase()}`;

/** Nothing typed and nothing chosen: no draft is worth keeping. */
export const isEmptyDraft = (d: NewRunDraft): boolean =>
  !d.refTouched &&
  !d.budgetTouched &&
  d.fields.goal.trim() === "" &&
  d.fields.repo.trim() === "" &&
  d.fields.ref === INITIAL.ref &&
  d.fields.budget === INITIAL.budget &&
  d.fields.category === INITIAL.category;

const text = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length <= limit ? value : null;

/** A stored draft read back. Anything malformed (edited by hand, from an older version) is ignored, not repaired. */
export function parseDraft(raw: string | null): NewRunDraft | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { fields, refTouched, budgetTouched } = data as Record<string, unknown>;
  if (typeof fields !== "object" || fields === null) return null;
  if (typeof refTouched !== "boolean" || typeof budgetTouched !== "boolean") return null;
  const f = fields as Record<string, unknown>;
  const goal = text(f.goal, GOAL_LIMIT);
  const repo = text(f.repo, FIELD_LIMIT);
  const ref = text(f.ref, FIELD_LIMIT);
  const budget = text(f.budget, FIELD_LIMIT);
  const category = typeof f.category === "string" && KINDS.some((k) => k.value === f.category) ? f.category : null;
  if (goal === null || repo === null || ref === null || budget === null || category === null) return null;
  return { fields: { goal, repo, ref, budget, category }, refTouched, budgetTouched };
}

export function loadDraft(key: string): NewRunDraft | null {
  try {
    return parseDraft(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Keeps the draft, or forgets it once the form is back to its starting state. */
export function saveDraft(key: string, draft: NewRunDraft): void {
  try {
    if (isEmptyDraft(draft)) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Private mode or storage full: the form still works, it just is not kept across pages.
  }
}

export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}
