import { describe, expect, it } from "vitest";
import { apiBase, authBase } from "./wallet";

describe("apiBase", () => {
  it("returns the configured API address without a trailing slash", () => {
    expect(apiBase("https://api.mergit.site/")).toBe("https://api.mergit.site");
  });

  it("explains a missing address instead of letting the request go to the page's own origin", () => {
    expect(() => apiBase("")).toThrow(/API address is not configured/);
  });

  it("with `same-origin`, calls the API on whichever hostname the page is served from", () => {
    expect(apiBase("same-origin", "https://mergit.site")).toBe("https://mergit.site");
    expect(apiBase("same-origin", "https://app.mergit.site")).toBe("https://app.mergit.site");
  });
});

describe("authBase", () => {
  it("sends GitHub and Google sign-in to the one hostname registered with them, whichever page the visitor is on", () => {
    expect(authBase("https://app.mergit.site/", "same-origin", "https://mergit.site")).toBe("https://app.mergit.site");
  });

  it("falls back to the API's own address when no sign-in hostname is set", () => {
    expect(authBase("", "https://api.example", "https://mergit.site")).toBe("https://api.example");
    expect(authBase("", "same-origin", "https://mergit.site")).toBe("https://mergit.site");
  });
});
