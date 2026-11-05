import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The API address comes from the build's environment, which unit tests do not have (same stub `providers.test.ts`
// uses for `fetchProviders`).
vi.mock("../chain/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chain/wallet")>()),
  apiBase: () => "https://api.test",
}));

import { startTrial } from "./accountApi";

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("startTrial", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the proof unchanged", async () => {
    fetchMock.mockImplementation(() => reply(200, { started_at: "2026-11-06T00:00:00Z" }));
    const proof = { merkle_root: "0xabc", nullifier_hash: "0xdef", proof: "0x123", verification_level: "orb" };
    await startTrial(proof);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v0/account/trial");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ world_proof: proof });
  });

  it("sends world_proof: null when called with no proof (World ID off, or the widget never ran)", async () => {
    fetchMock.mockImplementation(() => reply(200, { started_at: "2026-11-06T00:00:00Z" }));
    await startTrial();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ world_proof: null });
  });

  it("maps world_proof_rejected and the duplicate-human 403 to plain messages", async () => {
    fetchMock.mockImplementationOnce(() => reply(428, { detail: "world_proof_required" }));
    await expect(startTrial()).rejects.toThrow(/world id/i);

    fetchMock.mockImplementationOnce(() =>
      reply(403, { detail: { code: "world_proof_rejected", reason: "wrong_action" } }),
    );
    await expect(startTrial({})).rejects.toThrow(/different action/i);

    fetchMock.mockImplementationOnce(() =>
      reply(403, { detail: { code: "world_proof_rejected", reason: "sybil_score" } }),
    );
    await expect(startTrial({})).rejects.toThrow(/unique human/i);

    fetchMock.mockImplementationOnce(() =>
      reply(403, { detail: "the free credits were already used by this person" }),
    );
    await expect(startTrial({})).rejects.toThrow("the free credits were already used by this person");
  });

  it("says when the server cannot be reached, and falls back on an unrecognized refusal", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(startTrial()).rejects.toThrow(/unreachable/i);

    fetchMock.mockImplementationOnce(() => reply(500));
    await expect(startTrial()).rejects.toThrow(/could not start the trial/i);
  });
});
