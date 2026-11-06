import { describe, expect, it } from "vitest";
import { agentPath, parseAgentParam } from "./agentRoute";

describe("parseAgentParam", () => {
  it("accepts the full ENS name as the canonical form", () => {
    expect(parseAgentParam("coder-0.mergit.eth")).toEqual({ label: "coder-0", canonical: true });
  });

  it("accepts a bare label, so the page can redirect it to the full name", () => {
    expect(parseAgentParam("coder-0")).toEqual({ label: "coder-0", canonical: false });
  });

  it("lower-cases a mixed-case name to the same label, and marks it for a redirect", () => {
    expect(parseAgentParam("Coder-0.Mergit.ETH")).toEqual({ label: "coder-0", canonical: false });
    expect(parseAgentParam("CODER-0")).toEqual({ label: "coder-0", canonical: false });
  });

  it.each([
    ["a nested name", "a.b.mergit.eth"],
    ["an empty label", ".mergit.eth"],
    ["another parent", "coder-0.mergit.com"],
    ["a space", "coder 0"],
    ["an empty string", ""],
    ["a 64-character label", `${"a".repeat(64)}.mergit.eth`],
    ["a 64-character bare label", "a".repeat(64)],
    ["a path traversal", "coder-0.mergit.eth/../x"],
    ["a leading hyphen", "-coder.mergit.eth"],
    ["the parent itself", "mergit.eth"],
  ])("rejects %s", (_what, param) => {
    expect(parseAgentParam(param)).toBeNull();
  });

  it("rejects a missing parameter", () => {
    expect(parseAgentParam(undefined)).toBeNull();
  });
});

describe("agentPath", () => {
  it("is the profile URL under the full ENS name", () => {
    expect(agentPath("coder-0")).toBe("/agents/coder-0.mergit.eth");
  });

  it("throws for a label that is not a valid ENS label", () => {
    expect(() => agentPath("Coder 0")).toThrow();
    expect(() => agentPath("a.b")).toThrow();
    expect(() => agentPath("")).toThrow();
  });
});
