import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  approvePlan,
  createPlan,
  discardPlan,
  listPlans,
  onSessionEnded,
  openPullRequest,
  worldProofRequired,
} from "./client";

const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => {
  onSessionEnded(null);
  vi.unstubAllGlobals();
});

describe("a 401 from the API", () => {
  it("tells the app the session ended, and still throws so the caller stops", async () => {
    vi.stubGlobal("fetch", () => answer(401, { detail: "session expired or revoked" }));
    const ended = vi.fn();
    onSessionEnded(ended);
    await expect(listPlans()).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledOnce();
  });

  it("is not reported for other failures or for success", async () => {
    const ended = vi.fn();
    onSessionEnded(ended);
    vi.stubGlobal("fetch", () => answer(403, { detail: "no" }));
    await expect(listPlans()).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", () => answer(200, []));
    await expect(listPlans()).resolves.toEqual([]);
    expect(ended).not.toHaveBeenCalled();
  });

  it("is harmless when nobody is listening", async () => {
    vi.stubGlobal("fetch", () => answer(401, {}));
    await expect(listPlans()).rejects.toMatchObject({ status: 401 });
  });
});

describe("with the API on the page's own hostname (VITE_API_URL=same-origin)", () => {
  // One build serves both mergit.site and app.mergit.site, so each page calls the API on the hostname it was loaded
  // from. The setting is a word, not an address: using it as one sends "same-origin/v0/plans" to the web server,
  // which answers a POST with 405.
  async function clientOn(origin: string) {
    vi.resetModules();
    vi.stubEnv("VITE_API_URL", "same-origin");
    vi.stubGlobal("window", { location: { origin, pathname: "/app" } });
    return import("./client");
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("calls the plan routes on whichever hostname the page is served from", async () => {
    for (const origin of ["https://mergit.site", "https://app.mergit.site"]) {
      const c = await clientOn(origin);
      const seen: string[] = [];
      vi.stubGlobal("fetch", (url: string) => {
        seen.push(url);
        return answer(200, []);
      });
      await c.listPlans();
      await c.listAgents();
      expect(seen).toEqual([`${origin}/v0/plans`, `${origin}/v0/agents`]);
    }
  });

  it("opens a plan's live stream on the same hostname too", async () => {
    const c = await clientOn("https://mergit.site");
    expect(c.planEventsUrl("0b7f6a52-3a7c-4c2e-9d1f-1c0e5a6b7d88")).toBe(
      "https://mergit.site/v0/plans/0b7f6a52-3a7c-4c2e-9d1f-1c0e5a6b7d88/events",
    );
  });

  it("never builds a URL from the word itself", async () => {
    const seen: string[] = [];
    const c = await clientOn("https://mergit.site");
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(url);
      return answer(200, []);
    });
    await c.listPlans();
    expect(seen.join()).not.toContain("same-origin");
  });
});

describe("drafting and discarding a plan", () => {
  const request = {
    goal: "g",
    repo_url: "https://github.com/o/r",
    ref: "main",
    budget_usdc_units: "1",
    category: "bug-fix",
  };

  it("sends the Idempotency-Key when there is one, and none when there is not", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers ?? {});
      return answer(201, { plan_uuid: "p" });
    });
    await createPlan(request, "key-1");
    await createPlan(request);
    expect(seen[0]?.["Idempotency-Key"]).toBe("key-1");
    expect(seen[1]?.["Idempotency-Key"]).toBeUndefined();
  });

  it("discards with DELETE and accepts the empty 204 answer", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", (url: string, init: { method: string }) => {
      calls.push({ url, method: init.method });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await expect(discardPlan("a b")).resolves.toBeUndefined();
    expect(calls).toEqual([{ url: expect.stringContaining("/v0/plans/a%20b") as string, method: "DELETE" }]);
  });

  it("surfaces a refusal to discard", async () => {
    vi.stubGlobal("fetch", () => answer(409, { detail: "the plan is approved; only a draft can change" }));
    await expect(discardPlan("p")).rejects.toMatchObject({ status: 409 });
  });
});

describe("a refused World ID approval (403 human_approval_invalid)", () => {
  const approve = { agents: { "0": ["1"] }, funding: "wallet" as const };
  const refuse = (reason: string) => () => answer(403, { detail: { code: "human_approval_invalid", reason } });

  it("says what was wrong with the approval, not that only the requester may do this", async () => {
    vi.stubGlobal("fetch", refuse("action_mismatch"));
    const error = (await approvePlan("p", approve, "a1").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain("Only the requester");
    expect(error.message).toContain("changed after you approved it");
    // DraftPlanEditor shows `problems`, so the same words must be there too.
    expect(error.problems).toEqual([error.message]);
  });

  it("names an expired approval on the pull-request route too", async () => {
    vi.stubGlobal("fetch", refuse("expired"));
    await expect(openPullRequest("p", "a1")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("expired") as string,
    });
  });

  it("still shows a reason it has no words for, rather than dropping it", async () => {
    vi.stubGlobal("fetch", refuse("something_new"));
    await expect(approvePlan("p", approve, "a1")).rejects.toMatchObject({
      message: expect.stringContaining("something_new") as string,
    });
  });

  it("leaves every other 403 as it was", async () => {
    vi.stubGlobal("fetch", () => answer(403, { detail: "only the requester can approve this plan" }));
    await expect(approvePlan("p", approve)).rejects.toMatchObject({
      message: "Only the requester who created this plan can do that.",
    });
  });
});

describe("a credits approval from an account with no World ID claim yet", () => {
  it("is told to verify, in words, not the raw code and not a false 'already used'", async () => {
    vi.stubGlobal("fetch", () => answer(428, { detail: "world_proof_required" }));
    const refused = await approvePlan("p-1", { agents: { "0": ["1"] }, funding: "credits" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    const error = refused as ApiError;
    expect(error.status).toBe(428);
    expect(error.message).toMatch(/one-time World ID check/);
    expect(error.problems).toEqual([error.message]);
    expect(error.message).not.toMatch(/already used/);
    expect(worldProofRequired(error)).toBe(true);
  });

  it("is not confused with Agent Pass's own 428, or any other refusal", async () => {
    vi.stubGlobal("fetch", () =>
      answer(428, {
        detail: {
          code: "human_approval_required",
          approval_id: "a-1",
          start_url: "/v0/world/approvals/a-1/start",
          expires_at: "2026-11-06T00:05:00Z",
          summary: {},
        },
      }),
    );
    const humanApproval = await approvePlan("p-1", { agents: { "0": ["1"] }, funding: "credits" }).catch(
      (e: unknown) => e,
    );
    expect(worldProofRequired(humanApproval)).toBe(false);

    vi.stubGlobal("fetch", () => answer(403, { detail: "the free credits were already used by this person" }));
    const used = await approvePlan("p-1", { agents: { "0": ["1"] }, funding: "credits" }).catch((e: unknown) => e);
    expect(worldProofRequired(used)).toBe(false);
    expect(worldProofRequired(new Error("world_proof_required"))).toBe(false);
  });
});
