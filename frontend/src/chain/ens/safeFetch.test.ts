import { describe, expect, it, vi } from "vitest";
import { fetchJsonSafely, fetchTextSafely } from "./safeFetch.ts";

const ok = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
const stub = (res: Response | (() => Promise<Response>)) =>
  vi.fn(() => (typeof res === "function" ? res() : Promise.resolve(res)));

describe("fetchJsonSafely", () => {
  it("returns the parsed JSON of a good https response", async () => {
    const fetchStub = stub(ok('{"name":"coder-0"}'));
    expect(await fetchJsonSafely("https://mergit.site/agents/coder-0.json", { fetch: fetchStub })).toEqual({
      name: "coder-0",
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("refuses every URL that is not https without making a request", async () => {
    for (const url of [
      "http://mergit.site/a.json",
      "data:application/json;base64,e30=",
      "file:///etc/passwd",
      "ipfs://abc",
      "/relative.json",
      "//evil.example/a.json",
      "javascript:alert(1)",
      "",
      "not a url",
    ]) {
      const fetchStub = stub(ok("{}"));
      await expect(fetchJsonSafely(url, { fetch: fetchStub }), url).rejects.toThrow(/https/i);
      expect(fetchStub, url).not.toHaveBeenCalled();
    }
  });

  it("asks for no credentials and no referrer", async () => {
    const fetchStub = stub(ok("{}"));
    await fetchJsonSafely("https://mergit.site/a.json", { fetch: fetchStub });
    const init = (fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("rejects a non-2xx answer", async () => {
    await expect(
      fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(new Response("no", { status: 404 })) }),
    ).rejects.toThrow(/404/);
  });

  it("rejects a body larger than the limit, whether the server announces it or not", async () => {
    const big = "x".repeat(2000);
    await expect(
      fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(ok(big)), maxBytes: 1000 }),
    ).rejects.toThrow(/too large/i);
    await expect(
      fetchJsonSafely("https://mergit.site/a.json", {
        fetch: stub(ok("{}", { headers: { "content-length": "999999" } })),
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("rejects text that is not JSON", async () => {
    await expect(fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(ok("<html>")) })).rejects.toThrow(/JSON/);
  });

  it("rejects when a redirect ended somewhere that is not https", async () => {
    const res = ok("{}");
    Object.defineProperty(res, "url", { value: "http://elsewhere.example/a.json" });
    await expect(fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(res) })).rejects.toThrow(/https/i);
  });

  it("gives up after the timeout and aborts the request", async () => {
    let aborted = false;
    const hang = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    await expect(fetchJsonSafely("https://mergit.site/a.json", { fetch: hang, timeoutMs: 20 })).rejects.toThrow(
      /too long/i,
    );
    expect(aborted).toBe(true);
  });

  it("turns a network failure into a plain message", async () => {
    await expect(
      fetchJsonSafely("https://mergit.site/a.json", {
        fetch: stub(() => Promise.reject(new TypeError("fetch failed"))),
      }),
    ).rejects.toThrow(/could not be fetched/i);
  });
});

describe("fetchTextSafely", () => {
  it("returns the exact text, byte for byte, without parsing it", async () => {
    const body = ' {"a": 1}\n\u00e9\r\n';
    expect(await fetchTextSafely("https://mergit.site/ledger/final-1.json", { fetch: stub(ok(body)) })).toBe(body);
    expect(await fetchTextSafely("https://mergit.site/x.txt", { fetch: stub(ok("<html>not json")) })).toBe(
      "<html>not json",
    );
  });

  it("keeps a byte-order mark, so a hash of the text is a hash of the file", async () => {
    expect(await fetchTextSafely("https://mergit.site/a.json", { fetch: stub(ok("\uFEFF{}")) })).toBe("\uFEFF{}");
    expect(await fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(ok("\uFEFF{}")) })).toEqual({});
  });

  it("allows 2 MB by default, more than the JSON fetch, and no more", async () => {
    const big = "x".repeat(1024 * 1024);
    expect(await fetchTextSafely("https://mergit.site/a.json", { fetch: stub(ok(big)) })).toHaveLength(big.length);
    await expect(
      fetchTextSafely("https://mergit.site/a.json", { fetch: stub(ok("x".repeat(2 * 1024 * 1024 + 1))) }),
    ).rejects.toThrow(/too large/i);
    await expect(
      fetchJsonSafely("https://mergit.site/a.json", { fetch: stub(ok(`"${"x".repeat(200 * 1024)}"`)) }),
    ).rejects.toThrow(/too large/i);
  });

  it("keeps every guard of the JSON fetch: https only, no credentials, no referrer, no redirect off https", async () => {
    const never = stub(ok("x"));
    await expect(fetchTextSafely("http://mergit.site/a.json", { fetch: never })).rejects.toThrow(/https/i);
    expect(never).not.toHaveBeenCalled();
    const fetchStub = stub(ok("x"));
    await fetchTextSafely("https://mergit.site/a.json", { fetch: fetchStub });
    const init = (fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    const res = ok("x");
    Object.defineProperty(res, "url", { value: "http://elsewhere.example/a.json" });
    await expect(fetchTextSafely("https://mergit.site/a.json", { fetch: stub(res) })).rejects.toThrow(/https/i);
    await expect(
      fetchTextSafely("https://mergit.site/a.json", { fetch: stub(new Response("no", { status: 500 })) }),
    ).rejects.toThrow(/500/);
  });

  it("names what it was fetching in its messages", async () => {
    await expect(
      fetchTextSafely("https://mergit.site/a.json", {
        fetch: stub(ok("x".repeat(20))),
        maxBytes: 10,
        what: "The ledger file",
      }),
    ).rejects.toThrow("The ledger file is too large.");
  });
});
