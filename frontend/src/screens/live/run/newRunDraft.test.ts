import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, draftKey, isEmptyDraft, loadDraft, type NewRunDraft, parseDraft, saveDraft } from "./newRunDraft";
import { GOAL_LIMIT, INITIAL } from "./newRunForm";

const typed: NewRunDraft = {
  fields: { goal: "The refund test passes", repo: "acme/shop", ref: "dev", budget: "3", category: "bug-fix" },
  refTouched: true,
  budgetTouched: true,
};
const empty: NewRunDraft = { fields: { ...INITIAL }, refTouched: false, budgetTouched: false };

describe("keeping the new-run form across pages", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    // The unit tests run in Node, which has no sessionStorage.
    store = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives back what was typed", () => {
    const key = draftKey("0xAbC");
    saveDraft(key, typed);
    expect(loadDraft(key)).toEqual(typed);
  });

  it("is kept per signed-in address, so another account in the same tab does not see it", () => {
    saveDraft(draftKey("0xabc"), typed);
    expect(loadDraft(draftKey("0xdef"))).toBeNull();
    expect(loadDraft(draftKey("0xABC"))).toEqual(typed);
  });

  it("forgets the draft when the form is back to its starting state", () => {
    const key = draftKey("0xabc");
    saveDraft(key, typed);
    saveDraft(key, empty);
    expect(store.has(key)).toBe(false);
  });

  it("is gone once cleared (after the plan is drafted)", () => {
    const key = draftKey("0xabc");
    saveDraft(key, typed);
    clearDraft(key);
    expect(loadDraft(key)).toBeNull();
  });

  it("keeps working when storage is unavailable (private mode)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    const key = draftKey("0xabc");
    expect(() => {
      saveDraft(key, typed);
      clearDraft(key);
    }).not.toThrow();
    expect(loadDraft(key)).toBeNull();
  });
});

describe("reading a stored draft", () => {
  it("ignores anything that is not a draft this form wrote", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("not json")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(parseDraft(JSON.stringify({ fields: typed.fields }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...typed, fields: { ...typed.fields, goal: 7 } }))).toBeNull();
  });

  it("refuses a kind of work the form does not offer", () => {
    expect(parseDraft(JSON.stringify({ ...typed, fields: { ...typed.fields, category: "mining" } }))).toBeNull();
  });

  it("refuses a goal longer than the form allows", () => {
    const long = { ...typed, fields: { ...typed.fields, goal: "x".repeat(GOAL_LIMIT + 1) } };
    expect(parseDraft(JSON.stringify(long))).toBeNull();
  });

  it("calls a form with nothing typed or chosen empty, and anything else not", () => {
    expect(isEmptyDraft(empty)).toBe(true);
    expect(isEmptyDraft(typed)).toBe(false);
    expect(isEmptyDraft({ ...empty, fields: { ...INITIAL, category: "docs" } })).toBe(false);
    expect(isEmptyDraft({ ...empty, budgetTouched: true })).toBe(false);
  });
});
