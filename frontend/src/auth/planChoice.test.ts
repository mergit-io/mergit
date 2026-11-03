import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "./account";
import { choiceReason, dismissalKey, forgetDismissal, isDismissed, rememberDismissal } from "./planChoice";

const account = (over: Partial<Account> = {}): Account => ({
  userId: "u1",
  address: "0x0",
  name: null,
  email: null,
  avatarUrl: null,
  identities: [],
  wallets: [],
  trialAddress: null,
  trialStartedAt: null,
  ...over,
});
const onTrial = account({ trialStartedAt: "2026-11-01T00:00:00Z", trialAddress: "0x1" });

describe("when the plan choice is needed", () => {
  it("is open for an account that has neither a wallet nor a trial", () => {
    expect(choiceReason(account(), null)).toBe("new");
    expect(choiceReason(account(), 5_000_000n)).toBe("new");
  });

  it("is open for a trial account with no wallet once its credits are spent", () => {
    expect(choiceReason(onTrial, 0n)).toBe("exhausted");
  });

  it("stays closed while credits remain, and while they are still unknown", () => {
    expect(choiceReason(onTrial, 1n)).toBeNull();
    expect(choiceReason(onTrial, null)).toBeNull();
  });

  it("stays closed for anyone with a wallet, however few credits are left", () => {
    expect(choiceReason(account({ wallets: ["0xabc"] }), 0n)).toBeNull();
    expect(choiceReason(account({ trialStartedAt: "2026-11-01T00:00:00Z", wallets: ["0xabc"] }), 0n)).toBeNull();
  });

  it("stays closed with no account, or one from before accounts existed", () => {
    expect(choiceReason(null, 0n)).toBeNull();
    expect(choiceReason(account({ userId: null }), 0n)).toBeNull();
  });
});

describe("remembering a dismissal", () => {
  beforeEach(() => {
    // The unit tests run in Node, which has no sessionStorage.
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });

  it("holds for the same account and reason", () => {
    const key = dismissalKey("u1", "new");
    expect(isDismissed(key)).toBe(false);
    rememberDismissal(key);
    expect(isDismissed(key)).toBe(true);
  });

  it("does not carry over to another account", () => {
    rememberDismissal(dismissalKey("u1", "new"));
    expect(isDismissed(dismissalKey("u2", "new"))).toBe(false);
  });

  it("is gone after signing out or in", () => {
    const key = dismissalKey("u1", "new");
    rememberDismissal(key);
    forgetDismissal();
    expect(isDismissed(key)).toBe(false);
  });

  it("does not hide running out of credits after dismissing the first choice", () => {
    rememberDismissal(dismissalKey("u1", "new"));
    expect(isDismissed(dismissalKey("u1", "exhausted"))).toBe(false);
  });
});
