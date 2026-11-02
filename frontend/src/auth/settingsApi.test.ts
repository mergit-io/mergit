import { describe, expect, it } from "vitest";
import {
  capFromInput,
  capToInput,
  deleteAccount,
  getSettings,
  listSessions,
  putSettings,
  removeIdentity,
  removeWallet,
  revokeOtherSessions,
  updateName,
  type Preferences,
} from "./settingsApi";

const BASE = "https://app.test";
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));

type Seen = { url: string; init: RequestInit };
const recorder = (status: number, body: unknown = {}) => {
  const calls: Seen[] = [];
  return {
    calls,
    send: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(status, body);
    },
  };
};

const PREFS: Preferences = {
  planner_model: null,
  routing_mode: "greedy",
  max_attempts: 1,
  default_funding: "credits",
  per_plan_cap_usdc_units: null,
  daily_cap_usdc_units: "9000000",
};

describe("capFromInput / capToInput", () => {
  it("turns USDC the way people write it into base units, and back", () => {
    expect(capFromInput("3")).toEqual({ ok: true, units: "3000000" });
    expect(capFromInput(" 2.5 ")).toEqual({ ok: true, units: "2500000" });
    expect(capToInput("2500000")).toBe("2.5");
    expect(capToInput("3000000")).toBe("3");
    expect(capToInput(null)).toBe("");
  });

  it("treats an empty box as no cap and refuses anything that is not a positive amount", () => {
    expect(capFromInput("")).toEqual({ ok: true, units: null });
    expect(capFromInput("   ")).toEqual({ ok: true, units: null });
    for (const bad of ["0", "-1", "abc", "1e3", "1.1234567", "0.0"]) {
      expect(capFromInput(bad).ok, bad).toBe(false);
    }
  });
});

describe("settings", () => {
  it("reads the preferences and the models on offer", async () => {
    const { calls, send } = recorder(200, {
      preferences: PREFS,
      planner_models: ["m-a", "m-b"],
      default_planner_model: "m-a",
    });
    const got = await getSettings(BASE, send);
    expect(got.preferences).toEqual(PREFS);
    expect(got.plannerModels).toEqual(["m-a", "m-b"]);
    expect(got.defaultPlannerModel).toBe("m-a");
    expect(calls[0]?.url).toBe(`${BASE}/v0/account/settings`);
    expect(calls[0]?.init.credentials).toBe("include");
  });

  it("refuses an answer that is not the settings service", async () => {
    await expect(getSettings(BASE, () => reply(200, { hello: 1 }))).rejects.toThrow(/did not answer like/i);
  });

  it("saves with PUT and the session cookie", async () => {
    const { calls, send } = recorder(200, { preferences: PREFS, planner_models: [], default_planner_model: "m" });
    await putSettings(PREFS, BASE, send);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual(PREFS);
  });

  it("says what a 422 on save means", async () => {
    await expect(putSettings(PREFS, BASE, () => reply(422, { detail: "bad" }))).rejects.toThrow(/check/i);
  });
});

describe("account changes", () => {
  it("renames with PATCH", async () => {
    const { calls, send } = recorder(200, { name: "Yash" });
    expect(await updateName("Yash", BASE, send)).toBe("Yash");
    expect(calls[0]?.url).toBe(`${BASE}/v0/account/profile`);
    expect(calls[0]?.init.method).toBe("PATCH");
  });

  it("removes a wallet by address and a sign-in method by provider", async () => {
    const wallet = recorder(204);
    await removeWallet("0xAbC0000000000000000000000000000000000001", BASE, wallet.send);
    expect(wallet.calls[0]?.url).toBe(`${BASE}/v0/account/wallets/0xAbC0000000000000000000000000000000000001`);
    expect(wallet.calls[0]?.init.method).toBe("DELETE");
    const identity = recorder(204);
    await removeIdentity("github", BASE, identity.send);
    expect(identity.calls[0]?.url).toBe(`${BASE}/v0/account/identities/github`);
  });

  it("explains the refusals the server gives for removing the last way in or a wallet at work", async () => {
    await expect(removeIdentity("github", BASE, () => reply(409, { detail: "x" }))).rejects.toThrow(
      /only way to sign in|running|another method/i,
    );
    await expect(removeWallet("0x1", BASE, () => reply(404))).rejects.toThrow(/not on your account/i);
  });

  it("lists sessions and signs the others out", async () => {
    const listed = recorder(200, [
      {
        created_at: "2026-11-01T10:00:00+00:00",
        expires_at: "2026-12-01T10:00:00+00:00",
        address: "0xa",
        current: true,
      },
    ]);
    const sessions = await listSessions(BASE, listed.send);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
    const revoke = recorder(200, { revoked: 2 });
    expect(await revokeOtherSessions(BASE, revoke.send)).toBe(2);
    expect(revoke.calls[0]?.init.method).toBe("POST");
  });

  it("deletes only when the word is typed, and never calls the server otherwise", async () => {
    const none = recorder(204);
    await expect(deleteAccount("nope", BASE, none.send)).rejects.toThrow(/type delete/i);
    expect(none.calls).toHaveLength(0);
    const ok = recorder(204);
    await deleteAccount(" Delete ", BASE, ok.send);
    expect(ok.calls[0]?.init.method).toBe("DELETE");
    expect(JSON.parse(ok.calls[0]?.init.body as string)).toEqual({ confirm: "delete" });
  });

  it("says when a plan in flight blocks the deletion", async () => {
    await expect(deleteAccount("delete", BASE, () => reply(409, {}))).rejects.toThrow(/plan/i);
  });

  it("reports an unreachable API in words", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed"));
    await expect(updateName("x", BASE, down)).rejects.toThrow(/unreachable/i);
  });

  it("sends the person to sign in again on a 401", async () => {
    await expect(updateName("x", BASE, () => reply(401))).rejects.toThrow(/session has ended/i);
  });
});
