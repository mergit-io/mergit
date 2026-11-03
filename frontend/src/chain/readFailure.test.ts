import { afterEach, describe, expect, it, vi } from "vitest";
import { readFailure } from "./readFailure";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a failed chain read says", () => {
  it("names the chain when the browser is online", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(readFailure("receipts", "Base Sepolia")).toBe(
      "Could not read receipts from Base Sepolia. Try again in a moment.",
    );
  });

  it("says the browser is offline instead of blaming the chain", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(readFailure("receipts", "Base Sepolia")).toBe("You appear to be offline. Reconnect and try again.");
  });

  it("names the chain where there is no navigator to ask", () => {
    vi.stubGlobal("navigator", undefined);
    expect(readFailure("receipts", "Base Sepolia")).toContain("Base Sepolia");
  });
});
