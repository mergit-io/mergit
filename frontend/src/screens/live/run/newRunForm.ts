import { parseRepo, repoUrl } from "../../../api/github";
import { MAX_BUDGET } from "../../../chain/creditLimits";
import { formatUsdc, parseUsdc } from "../../../chain/funding";
import type { IconName } from "../../../components/Icon";

/** What the new-run form holds and how it checks it. Pure, so the prefill from an earlier plan can reuse every rule. */

export const GOAL_LIMIT = 8000;

/** Kinds of work. The planner is told the kind (its prompt names the task category); the API takes any slug. */
export const KINDS: { value: string; label: string; icon: IconName; placeholder: string }[] = [
  {
    value: "test-repair",
    label: "Fix failing tests",
    icon: "flask",
    placeholder: "The refund test in payments/ passes again",
  },
  { value: "bug-fix", label: "Fix a bug", icon: "bug", placeholder: "Expired sessions no longer log users out" },
  {
    value: "security",
    label: "Security",
    icon: "shield",
    placeholder: "The upload endpoint rejects paths outside the uploads folder",
  },
  {
    value: "performance",
    label: "Performance",
    icon: "bolt",
    placeholder: "The search endpoint answers in under 200 ms on the test data",
  },
  { value: "refactor", label: "Refactor", icon: "wrench", placeholder: "The billing module has no circular imports" },
  { value: "docs", label: "Docs", icon: "book", placeholder: "Every public function in api/ has a docstring" },
];

/** Starting points: each fills the goal with a sentence to finish, and picks its kind of work. */
export const STARTERS: { kind: string; title: string; goal: string }[] = [
  {
    kind: "test-repair",
    title: "Make a failing test pass",
    goal: "The failing test in <path to the test> passes again, without weakening the test.",
  },
  {
    kind: "bug-fix",
    title: "Fix a bug, with a regression test",
    goal: "<What goes wrong> no longer happens, and a regression test covers it.",
  },
  {
    kind: "security",
    title: "Close a security hole",
    goal: "<Code path> no longer allows <the problem>, and a test proves it.",
  },
];

/** The <…> blanks in the starting points, which must be filled in before a plan is drafted. */
const PLACEHOLDERS = STARTERS.flatMap((st) => st.goal.match(/<[^<>]+>/g) ?? []);

export type Fields = { goal: string; repo: string; ref: string; budget: string; category: string };

export const INITIAL: Fields = { goal: "", repo: "", ref: "main", budget: "5", category: "test-repair" };

/** The problem with a goal, or null. */
export function goalProblem(goal: string): string | null {
  if (!goal.trim()) return "Describe the goal.";
  if (PLACEHOLDERS.some((ph) => goal.includes(ph))) return "Replace the <…> parts of the goal with your own words.";
  return null;
}

export function repoProblem(repo: string): string | null {
  return repo.trim() ? null : "Choose a repository, or type its owner/name or https URL.";
}

export function refProblem(ref: string): string | null {
  return ref.trim() ? null : "Give the branch, tag or commit to start from.";
}

export function budgetProblem(budget: string): string | null {
  const units = parseUsdc(budget);
  if (units === null || units <= 0n) return "The budget must be a positive USDC amount.";
  if (units > MAX_BUDGET) return `The budget can be at most ${formatUsdc(MAX_BUDGET)} USDC for one plan.`;
  return null;
}

/** Problems the form can catch itself; the API checks the repository, branch and category again. */
export function fieldProblems(f: Fields): string[] {
  return [goalProblem(f.goal), repoProblem(f.repo), refProblem(f.ref), budgetProblem(f.budget)].flatMap((p) =>
    p === null ? [] : [p],
  );
}

/** What the API takes as the repository: a typed owner/name or GitHub URL becomes its https URL. */
export const toRepoUrl = (typed: string) => {
  const parsed = parseRepo(typed);
  return parsed ? repoUrl(parsed) : typed.trim();
};
