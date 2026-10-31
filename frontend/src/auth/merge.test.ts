import { describe, expect, it } from "vitest";
import { describeOther, parseWalletTaken } from "./merge";

const token = "t".repeat(43);
const body = (over: Record<string, unknown> = {}) => ({
  detail: {
    code: "wallet_taken",
    merge_token: token,
    other: { identities: [], wallets: 1, plans: 0, trial_started: false },
    ...over,
  },
});

describe("parseWalletTaken", () => {
  it("reads the server's offer to merge the account that already has the wallet", () => {
    expect(parseWalletTaken(body())).toEqual({
      token,
      other: { identities: [], wallets: 1, plans: 0, trialStarted: false },
    });
  });

  it("is null for any other 409, so an unrelated conflict is not shown as a merge", () => {
    expect(parseWalletTaken({ detail: "that wallet belongs to another account" })).toBeNull();
    expect(parseWalletTaken(body({ code: "something_else" }))).toBeNull();
    expect(parseWalletTaken(body({ merge_token: 5 }))).toBeNull();
    expect(parseWalletTaken(body({ merge_token: "" }))).toBeNull();
    expect(parseWalletTaken(null)).toBeNull();
  });

  it("keeps only the sign-in methods it knows", () => {
    const parsed = parseWalletTaken(
      body({
        other: {
          identities: [{ provider: "github", label: "octo" }, { provider: "myspace", label: "x" }, 7],
          wallets: 2,
          plans: 3,
          trial_started: true,
        },
      }),
    );
    expect(parsed?.other.identities).toEqual([{ provider: "github", label: "octo" }]);
    expect(parsed?.other.wallets).toBe(2);
  });
});

describe("describeOther", () => {
  it("says what the other account holds, so the person knows what they are merging", () => {
    expect(
      describeOther({
        identities: [{ provider: "github", label: "octo" }],
        wallets: 1,
        plans: 3,
        trialStarted: true,
      }),
    ).toBe("It was created with GitHub (octo) and holds 1 wallet, 3 runs and a started free trial.");
  });

  it("is plain when it holds only a wallet", () => {
    expect(describeOther({ identities: [], wallets: 1, plans: 0, trialStarted: false })).toBe(
      "It has only this wallet and no runs.",
    );
  });

  it("uses singular and plural correctly", () => {
    expect(describeOther({ identities: [], wallets: 2, plans: 1, trialStarted: false })).toBe(
      "It holds 2 wallets and 1 run.",
    );
  });

  it("names each way of signing in", () => {
    const text = describeOther({
      identities: [
        { provider: "google", label: "a@b.co" },
        { provider: "email", label: "a@b.co" },
      ],
      wallets: 1,
      plans: 0,
      trialStarted: false,
    });
    expect(text).toContain("Google (a@b.co) and email (a@b.co)");
  });
});
