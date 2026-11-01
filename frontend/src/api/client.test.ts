import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, listPlans, onSessionEnded } from "./client";

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
