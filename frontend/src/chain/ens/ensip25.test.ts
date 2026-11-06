import { describe, expect, it } from "vitest";
import { agentRegistrationKey, erc7930Address } from "./ensip25.ts";

// The same vectors the ens/ package pins (ens/test/ensip25.test.ts): the two packages must agree on the key.
const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6";
const ERC8004_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

describe("erc7930Address", () => {
  it("matches the HLD value for Identity on Base Sepolia (three-byte chain reference)", () => {
    expect(erc7930Address(84532, IDENTITY)).toBe("0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6");
  });

  it("matches ENSIP-25's worked example (one-byte chain reference)", () => {
    expect(erc7930Address(1, ERC8004_MAINNET)).toBe("0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432");
  });

  it("uses the minimal chain reference: 8453 (0x2105) takes two bytes", () => {
    const v = erc7930Address(8453, IDENTITY);
    expect(v.startsWith("0x00010000022105" + "14")).toBe(true);
    expect(v.length).toBe(2 + 2 * (2 + 2 + 1 + 2 + 1 + 20));
  });

  it("refuses a bad chain id or address", () => {
    expect(() => erc7930Address(0, IDENTITY)).toThrow(/chain id/i);
    expect(() => erc7930Address(1.5, IDENTITY)).toThrow(/chain id/i);
    expect(() => erc7930Address(1, "0x1234")).toThrow(/address/i);
  });
});

describe("agentRegistrationKey", () => {
  it("builds the ENSIP-25 key for Identity on Base Sepolia and for ENSIP-25's own example", () => {
    expect(agentRegistrationKey(IDENTITY, 84532, 5n)).toBe(
      "agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][5]",
    );
    expect(agentRegistrationKey(ERC8004_MAINNET, 1, 167)).toBe(
      "agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]",
    );
  });

  it("refuses agent ids with brackets or empty ones", () => {
    for (const id of ["a[b", "x]", "", "[1]"])
      expect(() => agentRegistrationKey(IDENTITY, 84532, id)).toThrow(/agent id/i);
  });
});
