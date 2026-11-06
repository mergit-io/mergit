import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRegistrationKey, erc7930Address } from "../src/ensip25.ts";

const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6";
const ERC8004_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

test("erc7930Address matches the HLD value for Identity on Base Sepolia (chain 84532, three-byte chain reference)", () => {
  assert.equal(erc7930Address(84532, IDENTITY), "0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6");
});

test("erc7930Address matches ENSIP-25's worked example (chain 1, one-byte chain reference)", () => {
  assert.equal(erc7930Address(1, ERC8004_MAINNET), "0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432");
});

test("a two-byte chain id (Base mainnet 8453 = 0x2105) uses a two-byte chain reference, not a fixed width", () => {
  const v = erc7930Address(8453, IDENTITY);
  assert.ok(v.startsWith("0x0001000002" + "2105" + "14"), v);
  assert.equal(v.length, 2 + 2 * (2 + 2 + 1 + 2 + 1 + 20));
});

test("agentRegistrationKey builds the ENSIP-25 key for the HLD's agent and for ENSIP-25's own example", () => {
  assert.equal(agentRegistrationKey(IDENTITY, 84532, 5n),
    "agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][5]");
  assert.equal(agentRegistrationKey(ERC8004_MAINNET, 1, 167),
    "agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]");
});

test("agent ids containing brackets or empty are refused, as are bad chain ids and addresses", () => {
  for (const id of ["a[b", "x]", "", "[1]"]) assert.throws(() => agentRegistrationKey(IDENTITY, 84532, id), /agent id/i);
  assert.throws(() => erc7930Address(0, IDENTITY), /chain id/i);
  assert.throws(() => erc7930Address(1.5, IDENTITY), /chain id/i);
  assert.throws(() => erc7930Address(1, "0x1234" as `0x${string}`), /address/i);
});
