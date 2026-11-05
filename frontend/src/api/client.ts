import { apiBase } from "../chain/wallet";
import { LIVE } from "../config/live";
import { invalidApprovalMessage } from "../world/reasons";
import { parseDiff, parsePullRequest, type PlanDiff, type PullRequest } from "./pullRequest";
import type {
  AgentInfo,
  ApproveRequest,
  ApproveResponse,
  NewPlanRequest,
  Plan,
  PlanDetail,
  PlanSummary,
  ReputationResponse,
  Suggestions,
  TaskEdit,
} from "./types";

/** A failed API call. `problems` lists every reason the API gave, for forms that show them all. `detail` is
 * the API's `detail` field exactly as parsed, before `problemsOf` reduces it to strings -- callers that need
 * to recognize a specific shape in it (e.g. World's 428 `human_approval_required` body) read this instead of
 * re-parsing the response themselves. */
export class ApiError extends Error {
  readonly status: number;
  readonly problems: string[];
  readonly detail: unknown;

  constructor(status: number, message: string, problems: string[] = [], detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problems = problems.length > 0 ? problems : [message];
    this.detail = detail;
  }
}

let sessionEnded: (() => void) | null = null;

/** The app registers what to do when the API says the session is gone (a 401); pass `null` to stop listening. */
export function onSessionEnded(handler: (() => void) | null): void {
  sessionEnded = handler;
}

const STATUS_MESSAGE: Partial<Record<number, string>> = {
  401: "Your session has ended. Sign in again to continue.",
  403: "Only the requester who created this plan can do that.",
  404: "There is no such plan.",
  502: "The planner model is unavailable right now. Try again in a moment.",
};

/** The API answers with `{detail: string}`, `{detail: {problems: string[]}}`, or FastAPI's validation list. */
function problemsOf(detail: unknown): string[] {
  if (typeof detail === "string") return [detail];
  if (Array.isArray(detail)) {
    return detail.map((d: { loc?: unknown[]; msg?: unknown }) => {
      const where = Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "";
      const msg = typeof d.msg === "string" ? d.msg : "invalid value";
      return where ? `${where}: ${msg}` : msg;
    });
  }
  if (detail && typeof detail === "object" && "problems" in detail && Array.isArray(detail.problems)) {
    return detail.problems.filter((p): p is string => typeof p === "string");
  }
  return [];
}

async function toError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  const problems = problemsOf(body?.detail);
  // A refused World ID approval is a 403 too, but not the requester-only one STATUS_MESSAGE[403] describes:
  // it says which approval problem it was (expired, used, changed since approving, ...) in its own `reason`.
  const message =
    invalidApprovalMessage(body?.detail) ??
    STATUS_MESSAGE[response.status] ??
    problems[0] ??
    `Mergit answered ${String(response.status)}.`;
  return new ApiError(response.status, message, problems, body?.detail);
}

/** The API's address, resolved: `same-origin` is the hostname the page was loaded from, never a literal.
 * Exported so other modules that need to build a URL against the same API (e.g. `world/api.ts`'s
 * `resolveApiUrl`) share this instead of redefining it. */
export const base = () => (LIVE.apiUrl ? apiBase() : "");

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      method,
      credentials: "include",
      ...(body === undefined
        ? { headers }
        : { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "Mergit is unreachable. Check your connection and try again.");
  }
  if (response.status === 401) sessionEnded?.();
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const planPath = (planUuid: string) => `/v0/plans/${encodeURIComponent(planUuid)}`;

/** Drafts a plan from a goal. The planner model runs during this call, so it takes a few seconds. */
export const createPlan = (body: NewPlanRequest, idempotencyKey?: string) =>
  request<Plan>("POST", "/v0/plans", body, idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey });

/** Throws a draft away, with its tasks. Only a draft: anything approved is closed with `abandonPlan` instead. */
export const discardPlan = (planUuid: string) => request<undefined>("DELETE", planPath(planUuid));

/** Replaces a draft's tasks. The API checks them exactly as it checks a planner answer. */
export const editPlan = (planUuid: string, tasks: TaskEdit[]) => request<Plan>("PATCH", planPath(planUuid), { tasks });

/** `approvalId`, when a fresh World ID check has already been done for this exact action (plan sec 1.7),
 * is sent as `X-World-Approval`; omitted, the API answers 428 when World Agent Pass is configured. */
export const approvePlan = (planUuid: string, body: ApproveRequest, approvalId?: string) =>
  request<ApproveResponse>(
    "POST",
    `${planPath(planUuid)}/approve`,
    body,
    approvalId ? { "X-World-Approval": approvalId } : {},
  );

/** Closes a plan the requester gives up on; the gateway returns what is left of its funds. */
export const abandonPlan = (planUuid: string) =>
  request<{ plan_id: string; state: "closed" }>("POST", `${planPath(planUuid)}/abandon`);

export const listPlans = () => request<PlanSummary[]>("GET", "/v0/plans");

export const getPlan = (planUuid: string) => request<PlanDetail>("GET", planPath(planUuid));

export const listAgents = () => request<AgentInfo[]>("GET", "/v0/agents");

/** Every agent-category pair with validated outcomes. Until there are any, the list is empty. */
export const getReputation = () => request<ReputationResponse>("GET", "/v0/agents/reputation");

/** Advice for a draft plan's agent picks. `explore` asks for a seeded Thompson draw instead of the greedy ranking. */
export const getSuggestions = (planUuid: string, explore: boolean) =>
  request<Suggestions>("GET", `${planPath(planUuid)}/suggestions${explore ? "?explore=true" : ""}`);

/** Server-Sent Events for one plan. Open with `withCredentials: true`, or the session cookie is not sent. */
export const planEventsUrl = (planUuid: string) => `${base()}${planPath(planUuid)}/events`;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The combined change of every task, for the requester to read before approving a pull request. 409 until the plan is done. */
export async function getPlanDiff(planUuid: string): Promise<PlanDiff> {
  const diff = parseDiff(await request<unknown>("GET", `${planPath(planUuid)}/diff`));
  if (!diff) throw new ApiError(0, "Mergit's API did not answer like the diff service.");
  return diff;
}

/** The requester's approval: queues the pull request for the worker, which holds the GitHub token.
 * `approvalId`, when a fresh World ID check has already been done for this exact diff (plan sec 1.7), is
 * sent as `X-World-Approval`; omitted, the API answers 428 when World Agent Pass is configured. */
export async function openPullRequest(planUuid: string, approvalId?: string): Promise<PullRequest> {
  const pr = parsePullRequest(
    await request<unknown>(
      "POST",
      `${planPath(planUuid)}/open-pr`,
      undefined,
      approvalId ? { "X-World-Approval": approvalId } : {},
    ),
  );
  if (!pr) throw new ApiError(0, "Mergit's API did not answer like the pull request service.");
  return pr;
}

/** Where the pull request stands, or null when none was requested (404). */
export async function getPullRequest(planUuid: string): Promise<PullRequest | null> {
  try {
    const pr = parsePullRequest(await request<unknown>("GET", `${planPath(planUuid)}/pr`));
    if (!pr) throw new ApiError(0, "Mergit's API did not answer like the pull request service.");
    return pr;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
