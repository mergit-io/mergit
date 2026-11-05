import { describe, expect, it } from "vitest";
import { parseMirror, parseOperator } from "./mirror.ts";

const ANCHOR = "0xf9DBfF75887361A67269765DA6F8732b233Fda76";
const EXPECTED = { chainId: 84532, contract: ANCHOR } as const;
const NOTE = "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth.";
// The record the publisher writes (ens/src/reputation-mirror.ts, HLD 6.3), as the exact compact string.
const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 0,
    mirror: true,
    source: { chainId: 84532, contract: ANCHOR },
    asOfBlock: 54982000,
    auditedStaked: 3,
    verifiedStaked: 2,
    byCategory: {
      "bug-fix": { auditedStaked: 1, verifiedStaked: 0 },
      "test-repair": { auditedStaked: 2, verifiedStaked: 2 },
    },
    note: NOTE,
    ...over,
  });

describe("parseMirror", () => {
  it("reads the publisher's record, categories in name order", () => {
    expect(parseMirror(good(), EXPECTED)).toEqual({
      asOfBlock: 54982000,
      auditedStaked: 3,
      verifiedStaked: 2,
      byCategory: [
        { category: "bug-fix", auditedStaked: 1, verifiedStaked: 0 },
        { category: "test-repair", auditedStaked: 2, verifiedStaked: 2 },
      ],
      note: NOTE,
    });
  });

  it("accepts a record with no outcomes yet", () => {
    const empty = good({ auditedStaked: 0, verifiedStaked: 0, byCategory: {} });
    expect(parseMirror(empty, EXPECTED).byCategory).toEqual([]);
  });

  it("matches the contract address case-insensitively", () => {
    const lower = good({ source: { chainId: 84532, contract: ANCHOR.toLowerCase() } });
    expect(parseMirror(lower, EXPECTED).auditedStaked).toBe(3);
  });

  it("refuses a record from another chain or another contract", () => {
    expect(() => parseMirror(good({ source: { chainId: 1, contract: ANCHOR } }), EXPECTED)).toThrow(/source/i);
    expect(() =>
      parseMirror(
        good({ source: { chainId: 84532, contract: "0x0000000000000000000000000000000000000001" } }),
        EXPECTED,
      ),
    ).toThrow(/source/i);
    expect(() => parseMirror(good({ source: undefined }), EXPECTED)).toThrow(/source/i);
  });

  it("refuses the wrong version or a record that does not call itself a mirror", () => {
    expect(() => parseMirror(good({ v: 1 }), EXPECTED)).toThrow(/version/i);
    expect(() => parseMirror(good({ mirror: false }), EXPECTED)).toThrow(/mirror/i);
    expect(() => parseMirror(good({ mirror: "true" }), EXPECTED)).toThrow(/mirror/i);
  });

  it("refuses counts that are negative, fractional, not numbers, unsafe, or inconsistent", () => {
    for (const bad of [-1, 1.5, "3", null, 2 ** 53, Number.NaN]) {
      expect(() => parseMirror(good({ auditedStaked: bad }), EXPECTED), String(bad)).toThrow();
      expect(() => parseMirror(good({ asOfBlock: bad }), EXPECTED), String(bad)).toThrow();
    }
    expect(() => parseMirror(good({ verifiedStaked: 4 }), EXPECTED)).toThrow(/verified/i);
    expect(() => parseMirror(good({ auditedStaked: 9 }), EXPECTED)).toThrow(/add up/i);
    expect(() =>
      parseMirror(
        good({ byCategory: { x: { auditedStaked: 1, verifiedStaked: 2 } }, auditedStaked: 1, verifiedStaked: 2 }),
        EXPECTED,
      ),
    ).toThrow(/verified/i);
    expect(() => parseMirror(good({ byCategory: [] }), EXPECTED)).toThrow(/categor/i);
    expect(() => parseMirror(good({ byCategory: { x: 5 } }), EXPECTED)).toThrow(/categor/i);
  });

  it("refuses text that is not a JSON object, without choking on huge input", () => {
    for (const bad of ["", "not json", "[]", "null", "42", '"text"'])
      expect(() => parseMirror(bad, EXPECTED), bad).toThrow();
    expect(() => parseMirror("x".repeat(100_000), EXPECTED)).toThrow(/too large/i);
    expect(() => parseMirror(undefined as unknown as string, EXPECTED)).toThrow();
  });

  it("does not let a __proto__ category pollute anything, and caps the number of categories", () => {
    const hostile =
      '{"v":0,"mirror":true,"source":{"chainId":84532,"contract":"' +
      ANCHOR +
      '"},"asOfBlock":1,"auditedStaked":1,"verifiedStaked":1,"byCategory":{"__proto__":{"auditedStaked":1,"verifiedStaked":1}},"note":""}';
    const m = parseMirror(hostile, EXPECTED);
    expect(m.byCategory).toEqual([{ category: "__proto__", auditedStaked: 1, verifiedStaked: 1 }]);
    expect(({} as Record<string, unknown>).auditedStaked).toBeUndefined();
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`c${String(i)}`, { auditedStaked: 0, verifiedStaked: 0 }]),
    );
    expect(() => parseMirror(good({ auditedStaked: 0, verifiedStaked: 0, byCategory: many }), EXPECTED)).toThrow(
      /categor/i,
    );
  });
});

describe("parseOperator", () => {
  it("returns a checksummed address for a checksummed or lowercase address", () => {
    const sum = "0x040510eE34d76253FCF94abDb65b67358fF5fa94";
    expect(parseOperator(sum)).toBe(sum);
    expect(parseOperator(sum.toLowerCase())).toBe(sum);
  });

  it("returns null for anything else", () => {
    for (const bad of [
      "",
      "0x",
      "hello",
      "0x" + "a".repeat(41),
      "0x" + "g".repeat(40),
      " 0x040510eE34d76253FCF94abDb65b67358fF5fa94",
    ]) {
      expect(parseOperator(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
