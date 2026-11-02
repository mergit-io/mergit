import { describe, expect, it, vi } from "vitest";

// The API address comes from the build's environment, which unit tests do not have.
vi.mock("../chain/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chain/wallet")>()),
  apiBase: () => "https://api.test",
}));

import {
  askServer,
  fetchAccount,
  fundingChoiceNeeded,
  initialsOf,
  isTrialSession,
  parseAccount,
  sessionFromAccount,
  type Account,
} from "./account";

const WALLET = "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D";
const TRIAL = "0x9999999999999999999999999999999999999999";
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const github: Account = {
  userId: "u1",
  address: TRIAL,
  name: "Octo Cat",
  email: "octo@example.com",
  avatarUrl: null,
  identities: [{ provider: "github", label: "octo" }],
  wallets: [],
  trialAddress: TRIAL,
  trialStartedAt: null,
};

describe("parseAccount", () => {
  it("reads what /v0/auth/me sends", () => {
    expect(
      parseAccount({
        address: TRIAL,
        user_id: "u1",
        name: "Octo Cat",
        email: "octo@example.com",
        avatar_url: null,
        identities: [{ provider: "github", label: "octo" }],
        wallets: [],
        trial_address: TRIAL,
        trial: null,
      }),
    ).toEqual(github);
  });

  it("reads a session from before accounts existed: just an address", () => {
    expect(parseAccount({ address: WALLET })).toMatchObject({ address: WALLET, userId: null, wallets: [] });
  });

  it("is null for anything that is not a session answer (a wrong URL returning a web page or an error body)", () => {
    expect(parseAccount({})).toBeNull();
    expect(parseAccount(null)).toBeNull();
    expect(parseAccount("<html>")).toBeNull();
    expect(parseAccount({ address: 5 })).toBeNull();
  });

  it("drops identities of a kind the app does not know instead of showing them", () => {
    const parsed = parseAccount({ address: WALLET, identities: [{ provider: "myspace", label: "x" }, 7] });
    expect(parsed?.identities).toEqual([]);
  });
});

describe("fetchAccount", () => {
  it("returns the account when the server has a live session", async () => {
    const result = await fetchAccount(() => reply(200, { address: WALLET }));
    expect(result).toMatchObject({ status: "valid", account: { address: WALLET } });
  });

  it("is expired when there is no live session (cookie expired or the API restarted)", async () => {
    expect(await fetchAccount(() => reply(401, { detail: "not signed in" }))).toEqual({ status: "expired" });
  });

  it("is expired when the quiet probe answers 200 with null: nobody is signed in, and that is not an error", async () => {
    expect(await fetchAccount(() => reply(200, null))).toEqual({ status: "expired" });
  });

  it("keeps whatever the browser remembers when the API cannot be asked: an outage must not sign people out", async () => {
    expect(await fetchAccount(() => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ status: "unknown" });
    expect(await fetchAccount(() => reply(503))).toEqual({ status: "unknown" });
    expect(await fetchAccount(() => Promise.resolve(new Response("<html>", { status: 200 })))).toEqual({
      status: "unknown",
    });
    expect(await fetchAccount(() => reply(200, {}))).toEqual({ status: "unknown" });
  });
});

describe("askServer", () => {
  const seen: string[] = [];
  const fake = (answers: Record<string, number>) => (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    seen.push(path);
    return reply(answers[path] ?? 404, null);
  };

  it("asks the quiet probe, not the strict /me, so a signed-out visit leaves no 401 in the console", async () => {
    seen.length = 0;
    const response = await askServer(fake({ "/v0/auth/session": 200 }));
    expect(response.status).toBe(200);
    expect(seen).toEqual(["/v0/auth/session"]);
  });

  it("falls back to /me on an API from before the probe existed (it answers 404)", async () => {
    seen.length = 0;
    const response = await askServer(fake({ "/v0/auth/me": 401 }));
    expect(response.status).toBe(401);
    expect(seen).toEqual(["/v0/auth/session", "/v0/auth/me"]);
  });
});

describe("sessionFromAccount", () => {
  it("is a wallet session when the acting address is one of the user's wallets", () => {
    const account = { ...github, address: WALLET, wallets: [WALLET] };
    expect(sessionFromAccount(account)).toMatchObject({ address: WALLET, method: "browser" });
  });

  it("is a session of the way the user signed in when they have no wallet", () => {
    expect(sessionFromAccount(github)).toMatchObject({ address: TRIAL, method: "github" });
    const google = { ...github, identities: [{ provider: "google" as const, label: "a@b.co" }] };
    expect(sessionFromAccount(google).method).toBe("google");
    expect(sessionFromAccount({ ...github, identities: [] }).method).toBe("email");
  });
});

describe("isTrialSession", () => {
  it("is true only while the session acts as the user's trial address", () => {
    expect(isTrialSession(github, TRIAL)).toBe(true);
    expect(isTrialSession(github, WALLET)).toBe(false);
    expect(isTrialSession(null, TRIAL)).toBe(false);
  });
});

describe("fundingChoiceNeeded", () => {
  it("is true for an account with neither a wallet nor a started trial", () => {
    expect(fundingChoiceNeeded(github)).toBe(true);
  });

  it("is false once a trial has started or a wallet is connected", () => {
    expect(fundingChoiceNeeded({ ...github, trialStartedAt: "2026-10-30T10:00:00+00:00" })).toBe(false);
    expect(fundingChoiceNeeded({ ...github, wallets: [WALLET], address: WALLET })).toBe(false);
  });

  it("is false before the account is known, and for sessions from before accounts existed", () => {
    expect(fundingChoiceNeeded(null)).toBe(false);
    expect(fundingChoiceNeeded({ ...github, userId: null })).toBe(false);
  });
});

describe("initialsOf", () => {
  it("uses the first letters of a name, at most two", () => {
    expect(initialsOf("Octo Cat", null)).toBe("OC");
    expect(initialsOf("Ada", null)).toBe("A");
    expect(initialsOf("Ada Augusta King", null)).toBe("AA");
  });

  it("falls back to the email's first letters, then to nothing", () => {
    expect(initialsOf(null, "octo@example.com")).toBe("OC");
    expect(initialsOf(null, null)).toBeNull();
  });
});
