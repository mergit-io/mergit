import { describe, expect, it } from "vitest";
import { redeemCode } from "./accountApi";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
  );

describe("redeemCode", () => {
  it("sends the trimmed code with the session cookie and returns the amount added, in base units", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const added = await redeemCode("  MRG-AAAA-BBBB-CCCC-DDDD \n", "https://app.test", (url, init) => {
      seen = { url, init };
      return reply(200, { amount_usdc_units: "20000000" });
    });
    expect(added).toBe(20_000_000n);
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("https://app.test/v0/account/redeem");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("include");
    expect(JSON.parse(call.init.body as string)).toEqual({ code: "MRG-AAAA-BBBB-CCCC-DDDD" });
  });

  it("does not call the server for an empty code", async () => {
    let calls = 0;
    const send = () => {
      calls += 1;
      return reply(200, { amount_usdc_units: "1" });
    };
    for (const blank of ["", "   ", "\n"]) {
      await expect(redeemCode(blank, "https://app.test", send)).rejects.toThrow(/enter a code/i);
    }
    expect(calls).toBe(0);
  });

  it("explains each refusal in words the person can act on", async () => {
    const t = (status: number, headers: Record<string, string> = {}) =>
      redeemCode("MRG-AAAA-BBBB-CCCC-DDDD", "https://app.test", () => reply(status, {}, headers));
    await expect(t(400)).rejects.toThrow(/not valid/i);
    await expect(t(409)).rejects.toThrow(/already been used/i);
    await expect(t(410)).rejects.toThrow(/expired/i);
    await expect(t(401)).rejects.toThrow(/sign in again/i);
    await expect(t(422)).rejects.toThrow(/does not look like a code/i);
    await expect(t(500)).rejects.toThrow(/could not check the code/i);
  });

  it("says how long to wait when too many tries were made, rounding up to whole minutes", async () => {
    const t = (retryAfter?: string) =>
      redeemCode("MRG-AAAA-BBBB-CCCC-DDDD", "https://app.test", () =>
        reply(429, {}, retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      );
    await expect(t("61")).rejects.toThrow(/2 minutes/);
    await expect(t("30")).rejects.toThrow(/1 minute\b/);
    await expect(t("3600")).rejects.toThrow(/60 minutes/);
    await expect(t()).rejects.toThrow(/too many tries.*later/i);
    await expect(t("soon")).rejects.toThrow(/too many tries.*later/i);
  });

  it("says when the server cannot be reached, and when it does not answer like the redeem service", async () => {
    await expect(
      redeemCode("MRG-AAAA-BBBB-CCCC-DDDD", "https://app.test", () => Promise.reject(new TypeError("Failed"))),
    ).rejects.toThrow(/unreachable/i);
    for (const body of [{}, { amount_usdc_units: 20 }, { amount_usdc_units: "-1" }, { amount_usdc_units: "1.5" }]) {
      await expect(redeemCode("MRG-AAAA-BBBB-CCCC-DDDD", "https://app.test", () => reply(200, body))).rejects.toThrow(
        /did not answer like/i,
      );
    }
  });
});
