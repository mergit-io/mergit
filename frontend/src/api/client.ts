import { apiBase } from "../chain/wallet";
import { LIVE } from "../config/live";
import { parseDiff, parsePullRequest, type PlanDiff, type PullRequest } from "./pullRequest";
import type {
  AgentInfo,
  ApproveRequest,
  ApproveResponse,
  CandidatesResponse,
  NewPlanRequest,
  Plan,
  PlanDetail,
  PlanSummary,
  TaskEdit,
} from "./types";

/** A failed API call. `problems` lists every reason the API gave, for forms that show them all. */
export class ApiError extends Error {
  readonly status: number;
  readonly problems: string[];

  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problems = problems.length > 0 ? problems : [message];
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
  const message = STATUS_MESSAGE[response.status] ?? problems[0] ?? `Mergit answered ${String(response.status)}.`;
  return new ApiError(response.status, message, problems);
}

/** The API's address, resolved: `same-origin` is the hostname the page was loaded from, never a literal. */
const base = () => (LIVE.apiUrl ? apiBase() : "");

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      method,
      credentials: "include",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "Mergit is unreachable. Check your connection and try again.");
  }
  if (response.status === 401) sessionEnded?.();
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

const planPath = (planUuid: string) => `/v0/plans/${encodeURIComponent(planUuid)}`;

/** Drafts a plan from a goal. The planner model runs during this call, so it takes a few seconds. */
export const createPlan = (body: NewPlanRequest) => request<Plan>("POST", "/v0/plans", body);

/** Replaces a draft's tasks. The API checks them exactly as it checks a planner answer. */
export const editPlan = (planUuid: string, tasks: TaskEdit[]) => request<Plan>("PATCH", planPath(planUuid), { tasks });

export const approvePlan = (planUuid: string, body: ApproveRequest) =>
  request<ApproveResponse>("POST", `${planPath(planUuid)}/approve`, body);

/** Closes a plan the requester gives up on; the gateway returns what is left of its funds. */
export const abandonPlan = (planUuid: string) =>
  request<{ plan_id: string; state: "closed" }>("POST", `${planPath(planUuid)}/abandon`);

export const listPlans = () => request<PlanSummary[]>("GET", "/v0/plans");

export const getPlan = (planUuid: string) => request<PlanDetail>("GET", planPath(planUuid));

export const listAgents = () => request<AgentInfo[]>("GET", "/v0/agents");

/** Ranked, eligibility-checked agents per task, for the "Let Mergit route" picker. */
export const getCandidates = (planUuid: string) =>
  request<CandidatesResponse>("GET", `${planPath(planUuid)}/candidates`);

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

/** The requester's approval: queues the pull request for the worker, which holds the GitHub token. */
export async function openPullRequest(planUuid: string): Promise<PullRequest> {
  const pr = parsePullRequest(await request<unknown>("POST", `${planPath(planUuid)}/open-pr`));
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
