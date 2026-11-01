import { describe, expect, it } from "vitest";
import { storyCopy } from "./copy";

describe("the landing copy says what the contracts do", () => {
  const settle = JSON.stringify(storyCopy.settle);

  it("does not say every task is audited before payment: only free-credit work is always audited", () => {
    expect(settle).not.toMatch(/audit checks the receipt before any money moves/i);
    expect(storyCopy.settle.steps[2][1]).toMatch(/free-credit work is always audited/i);
    expect(storyCopy.settle.steps[2][1]).toMatch(/sampled/i);
  });

  it("names the testnet the receipt is committed on instead of claiming mainnet Ethereum", () => {
    expect(settle).not.toMatch(/settles on Ethereum/i);
    expect(storyCopy.settle.steps[3][1]).toMatch(/Base Sepolia/);
    expect(storyCopy.settle.steps[3][1]).toMatch(/testnet/i);
  });

  it("has five settlement steps, one rail label each", () => {
    expect(storyCopy.settle.steps).toHaveLength(5);
    expect(storyCopy.settle.rail).toHaveLength(5);
  });
});
