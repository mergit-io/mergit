import { describe, expect, it } from "vitest";
import { appBase, DEMO_PREFIX, isDemoPath, resolveMode } from "./mode";

describe("isDemoPath", () => {
  it("is the demo only at /demo and below it", () => {
    for (const p of ["/demo", "/demo/", "/demo/runs", "/demo/runs/run-1", "/demo/proofs/abc"]) {
      expect(isDemoPath(p), p).toBe(true);
    }
  });

  it("is not the demo for anything that merely starts with the letters", () => {
    for (const p of ["/", "/app", "/app/demo", "/demonstration", "/demo-site", "/Demo", "/DEMO/runs", "/x/demo", ""]) {
      expect(isDemoPath(p), p).toBe(false);
    }
  });
});

describe("resolveMode", () => {
  it("is always sample data in the demo, whatever the build is", () => {
    expect(resolveMode("/demo", "live")).toBe("mock");
    expect(resolveMode("/demo/runs", "live")).toBe("mock");
    expect(resolveMode("/demo", "mock")).toBe("mock");
  });

  it("is the build's own mode everywhere else", () => {
    expect(resolveMode("/app", "live")).toBe("live");
    expect(resolveMode("/", "live")).toBe("live");
    expect(resolveMode("/app/wallet", "mock")).toBe("mock");
  });
});

describe("appBase", () => {
  it("roots the dashboard's links at /demo in the demo and at /app otherwise", () => {
    expect(DEMO_PREFIX).toBe("/demo");
    expect(appBase(true)).toBe("/demo");
    expect(appBase(false)).toBe("/app");
  });
});
