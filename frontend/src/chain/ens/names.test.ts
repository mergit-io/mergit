import { describe, expect, it } from "vitest";
import { PARENT_NAME, ensNameOf, labelForAgent } from "./names.ts";

describe("ensNameOf", () => {
  it("puts one label under mergit.eth", () => {
    expect(PARENT_NAME).toBe("mergit.eth");
    expect(ensNameOf("coder-0")).toBe("coder-0.mergit.eth");
    expect(ensNameOf("a".repeat(63))).toBe(`${"a".repeat(63)}.mergit.eth`);
  });

  it("refuses anything that is not one lowercase DNS label", () => {
    for (const bad of ["A", "-x", "x-", "a.b", "", "a b", "é", "a".repeat(64)]) {
      expect(() => ensNameOf(bad), JSON.stringify(bad)).toThrow(/label/i);
    }
    expect(() => ensNameOf(undefined as unknown as string)).toThrow(/label/i);
  });
});

describe("labelForAgent", () => {
  it("returns an agent's name only when it is already a valid label", () => {
    expect(labelForAgent("mergit-coder-0")).toBe("mergit-coder-0");
    expect(labelForAgent("claude-worker")).toBe("claude-worker");
  });

  it("never rewrites a name into a different label: an agent whose name is not a label simply has no ENS name", () => {
    for (const name of ["Mergit Coder", "coder.0", "a_b", "", "a".repeat(64), "-x", "Claude-Worker"]) {
      expect(labelForAgent(name), JSON.stringify(name)).toBeNull();
    }
    expect(labelForAgent(undefined as unknown as string)).toBeNull();
  });
});
