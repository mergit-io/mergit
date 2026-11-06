import { describe, expect, it } from "vitest";
import { fieldProblems, INITIAL, STARTERS, toRepoUrl } from "./newRunForm";

const ok = { ...INITIAL, goal: "Fix the refund test", repo: "acme/widgets" };

describe("fieldProblems", () => {
  it("accepts a complete form", () => {
    expect(fieldProblems(ok)).toEqual([]);
  });

  it("names each missing field, in form order", () => {
    expect(fieldProblems({ goal: " ", repo: "", ref: "", budget: "0", category: "docs" })).toEqual([
      "Describe the goal.",
      "Choose a repository, or type its owner/name or https URL.",
      "Give the branch, tag or commit to start from.",
      "The budget must be a positive USDC amount.",
    ]);
  });

  it("refuses a starting point's blanks left unfilled, and a budget over the cap", () => {
    expect(fieldProblems({ ...ok, goal: STARTERS[0]?.goal ?? "", budget: "1000.01" })).toEqual([
      "Replace the <…> parts of the goal with your own words.",
      "The budget can be at most 1000.00 USDC for one plan.",
    ]);
  });
});

describe("toRepoUrl", () => {
  it("turns what was typed into the https URL, and passes an unparseable value through for the API to refuse", () => {
    expect(toRepoUrl("acme/widgets")).toBe("https://github.com/acme/widgets");
    expect(toRepoUrl(" git@example.com:a/b ")).toBe("git@example.com:a/b");
  });
});
