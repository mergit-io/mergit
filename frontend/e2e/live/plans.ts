/**
 * A fake of the control plane's plan API (plan tasks O3, O6 and O7) for live-mode run tests. It keeps
 * plans in memory and moves them the way the real service does (an approval locks a draft, closing sets
 * `closed`), so a test drives the screens end to end and then asserts on what the API received.
 *
 * The wire shapes are written out here rather than imported from the app, so these tests check the app
 * against the API's contract, not against the app's own idea of it.
 */
import type { Page } from "@playwright/test";
import { LIVE_ENV } from "../../playwright.config";
import { CORS, json, ME } from "./fake";

type Hex = `0x${string}`;

export type FakeTask = {
  index: number;
  title: string;
  instructions: string;
  phi: Record<string, unknown>;
  phi_hash: Hex | null;
  budget_usdc_units: string;
  depends_on: number[];
  agents: string[] | null;
};

export type FakeAttempt = {
  task_id: Hex;
  index: number;
  attempt: number;
  agent_id: string;
  status: "queued" | "running" | "done" | "error";
  phi_holds: boolean | null;
  receipt_root: Hex | null;
  notes: string | null;
  finished_at: string | null;
};

export type FakePlan = {
  plan_uuid: string;
  plan_id: Hex;
  requester: string;
  state: "draft" | "approved" | "funded" | "running" | "done" | "failed" | "closed";
  goal: string;
  repo_url: string;
  ref: string;
  category: string;
  budget_usdc_units: string;
  funding: "wallet" | "credits" | null;
  total_budget_usdc_units: string | null;
  created_at: string;
  approved_at: string | null;
  tasks: FakeTask[];
  attempts: FakeAttempt[];
  money_events: Array<{ type: string; at: string; payload: Record<string, unknown> }>;
};

/** One Server-Sent Event the fake stream sends, as the control plane names them. */
export type FakeEvent = { event: string; data: unknown };

export const AGENTS = [
  { agent_id: "1", name: "coder-a", model: "claude-sonnet-5" },
  { agent_id: "2", name: "coder-b", model: "claude-opus-5-5" },
];

export const PHI = {
  kind: "exec/0",
  command: ["pytest", "tests/test_refund.py", "-q"],
  expected_exit: 0,
  workdir: ".",
  allowed_paths: ["payments/**"],
  artifact_hashes: null,
  timeout_s: 600,
};

const PLAN_UUID = "3f1c2b8e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";
export const PLAN_ID: Hex = `0x${"ab".repeat(32)}`;
export const taskId = (index: number, attempt: number): Hex => `0x${String(index)}${String(attempt)}${"0".repeat(62)}`;

/** A two-task draft, the second depending on the first, as the planner returns one. */
export function draftPlan(over: Partial<FakePlan> = {}): FakePlan {
  return {
    plan_uuid: PLAN_UUID,
    plan_id: PLAN_ID,
    requester: ME.toLowerCase(),
    state: "draft",
    goal: "The refund test in payments/ passes again",
    repo_url: "https://github.com/acme/widgets",
    ref: "main",
    category: "test-repair",
    budget_usdc_units: "2000000",
    funding: null,
    total_budget_usdc_units: null,
    created_at: "2026-10-29T10:00:00.000Z",
    approved_at: null,
    tasks: [
      {
        index: 0,
        title: "Reproduce the failing refund",
        instructions: "Run the refund test and find the cause.",
        phi: PHI,
        phi_hash: null,
        budget_usdc_units: "500000",
        depends_on: [],
        agents: null,
      },
      {
        index: 1,
        title: "Fix the refund rounding",
        instructions: "Fix the rounding in payments/refund.py.",
        phi: PHI,
        phi_hash: null,
        budget_usdc_units: "1000000",
        depends_on: [0],
        agents: null,
      },
    ],
    attempts: [],
    money_events: [],
    ...over,
  };
}

/** The same plan approved with `agents` picked for every task and paid with `funding`. */
export function approvedPlan(over: Partial<FakePlan> = {}, agents: string[] = ["1", "2"]): FakePlan {
  const draft = draftPlan();
  return draftPlan({
    state: "approved",
    funding: "wallet",
    total_budget_usdc_units: "1500000",
    approved_at: "2026-10-29T10:05:00.000Z",
    tasks: draft.tasks.map((t) => ({ ...t, agents, phi_hash: `0x${"cc".repeat(32)}` })),
    ...over,
  });
}

export function attempt(index: number, n: number, over: Partial<FakeAttempt> = {}): FakeAttempt {
  return {
    task_id: taskId(index, n),
    index,
    attempt: n,
    agent_id: String(n),
    status: "running",
    phi_holds: null,
    receipt_root: null,
    notes: null,
    finished_at: null,
    ...over,
  };
}

export type ApiCall = { method: string; path: string; body: unknown };

const sseBody = (events: FakeEvent[]) =>
  // A long retry, so the browser does not reconnect while a test is still asserting.
  ["retry: 600000\n\n", ...events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)].join("");

/**
 * Serves the plan API on the live API host. Register it after `mockBackend`, which still answers sign-in.
 * `created` is what `POST /v0/plans` drafts; `events` is what each plan's stream sends on connect.
 */
export async function mockPlanApi(
  page: Page,
  opts: {
    plans?: FakePlan[];
    created?: FakePlan;
    events?: FakeEvent[];
    /** The pull-request step. `after` is what the worker reports on each poll once the request is queued. */
    pr?: { after: Array<"running" | "done" | "error"> };
  } = {},
) {
  let prState: "none" | "queued" | "running" | "done" | "error" = "none";
  const prPolls = [...(opts.pr?.after ?? ["running", "done"])];
  const prBody = () => ({
    plan_uuid: "x",
    requested_by: ME.toLowerCase(),
    status: prState,
    branch: prState === "done" ? "mergit/0b7f6a52" : null,
    commit_sha: prState === "done" ? "a".repeat(40) : null,
    pr_number: prState === "done" ? 7 : null,
    pr_url: prState === "done" ? "https://github.com/mergit-io/demo-repo/pull/7" : null,
    error: prState === "error" ? "patch does not apply" : null,
  });
  const plans = new Map((opts.plans ?? []).map((p) => [p.plan_uuid, structuredClone(p)]));
  const calls: ApiCall[] = [];

  await page.route(`${LIVE_ENV.VITE_API_URL}/v0/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v0/auth/") || path.startsWith("/v0/account/")) return route.fallback();
    const body: unknown = request.postData() ? request.postDataJSON() : null;
    calls.push({ method, path, body });

    if (path === "/v0/agents") return json(route, AGENTS);
    if (path === "/v0/plans" && method === "GET") return json(route, [...plans.values()]);
    if (path === "/v0/plans" && method === "POST") {
      const created = structuredClone(opts.created ?? draftPlan());
      plans.set(created.plan_uuid, created);
      return json(route, created, 201);
    }

    const [, , , uuid = "", action] = path.split("/");
    const plan = plans.get(uuid);
    if (!plan) return json(route, { detail: "no such plan" }, 404);

    if (action === "events") {
      return route.fulfill({
        status: 200,
        headers: { ...CORS(route), "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: sseBody([{ event: "plan.state", data: { state: plan.state } }, ...(opts.events ?? [])]),
      });
    }
    if (method === "GET" && !action) return json(route, plan);
    if (method === "PATCH" && !action) {
      const { tasks } = body as { tasks: Array<Omit<FakeTask, "index" | "phi_hash" | "agents">> };
      plan.tasks = tasks.map((t, index) => ({ ...t, index, phi_hash: null, agents: null }));
      return json(route, plan);
    }
    if (method === "POST" && action === "approve") {
      const { agents, funding } = body as { agents: Record<string, string[]>; funding: "wallet" | "credits" };
      const total = plan.tasks.reduce((sum, t) => sum + BigInt(t.budget_usdc_units), 0n).toString();
      plan.tasks = plan.tasks.map((t) => ({
        ...t,
        agents: agents[String(t.index)] ?? null,
        phi_hash: `0x${"cc".repeat(32)}`,
      }));
      Object.assign(plan, { state: "approved", funding, total_budget_usdc_units: total });
      return json(route, { plan_id: plan.plan_id, total_budget_usdc_units: total });
    }
    if (method === "GET" && action === "diff") {
      if (plan.state !== "done") {
        return json(
          route,
          { detail: { message: "the plan is not ready", blockers: ["the plan is " + plan.state] } },
          409,
        );
      }
      return json(route, {
        plan_uuid: plan.plan_uuid,
        repo_url: plan.repo_url,
        base_ref: plan.ref,
        tasks: plan.tasks.map((t) => ({ index: t.index, title: t.title, task_id: taskId(t.index, 1) })),
        diff: "--- a/payments/refund.py\n+++ b/payments/refund.py\n@@ -9,2 +9,2 @@\n-    return min(requested_cents, remaining)\n+    return max(0, min(requested_cents, remaining))\n",
      });
    }
    if (method === "POST" && action === "open-pr") {
      if (prState === "none" || prState === "error") prState = "queued";
      return json(route, prBody(), 202);
    }
    if (method === "GET" && action === "pr") {
      if (prState === "none") return json(route, { detail: "no pull request has been requested" }, 404);
      if (prState === "queued" || prState === "running") prState = prPolls.shift() ?? "done";
      return json(route, prBody());
    }
    if (method === "POST" && action === "abandon") {
      plan.state = "closed";
      return json(route, { plan_id: plan.plan_id, state: "closed" });
    }
    return json(route, { detail: "not found" }, 404);
  });

  return calls;
}
