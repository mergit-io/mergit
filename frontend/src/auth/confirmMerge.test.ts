import { describe, expect, it } from "vitest";
import { confirmMerge } from "./accountApi";

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("confirmMerge", () => {
  it("sends the offer's token, with the session cookie, and returns the wallet the session now acts as", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const address = await confirmMerge("tok".repeat(15), "https://app.test", (url, init) => {
      seen = { url, init };
      return reply(200, { address: "0x1725a458a3fc8bb3d7460d262c7f94766fef585d" });
    });
    expect(address).toBe("0x1725a458a3fc8bb3d7460d262c7f94766fef585d");
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("https://app.test/v0/auth/merge");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("include");
    expect(JSON.parse(call.init.body as string)).toEqual({ merge_token: "tok".repeat(15) });
  });

  it("explains each refusal in words the person can act on", async () => {
    const t = (status: number) => confirmMerge("x".repeat(30), "https://app.test", () => reply(status));
    await expect(t(404)).rejects.toThrow(/expired.*again/i);
    await expect(t(403)).rejects.toThrow(/different account/i);
    await expect(t(401)).rejects.toThrow(/sign in again/i);
    await expect(t(500)).rejects.toThrow(/could not merge/i);
  });

  it("says when the server cannot be reached, and when it does not answer like the merge service", async () => {
    await expect(
      confirmMerge("x".repeat(30), "https://app.test", () => Promise.reject(new TypeError("Failed to fetch"))),
    ).rejects.toThrow(/unreachable/i);
    await expect(confirmMerge("x".repeat(30), "https://app.test", () => reply(200, {}))).rejects.toThrow(
      /did not answer like/i,
    );
  });
});
