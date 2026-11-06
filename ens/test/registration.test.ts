import { test } from "node:test";
import assert from "node:assert/strict";
import { ensNameOf, registrationFile, serializeRegistration, type AgentInput } from "../src/registration.ts";

const CHAIN = { chainId: 84532, identity: "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" } as const;
const agent = (over: Partial<AgentInput> = {}): AgentInput => ({
  label: "coder-0", name: "coder-0", description: "A Mergit coding agent. Its work is audited on chain.",
  profileUrl: "https://mergit.site/agents/coder-0.mergit.eth", ...over,
});

test("the file declares the ERC-8004 registration type and is active without x402", () => {
  const f = registrationFile(agent({ agentId: 2 }), CHAIN);
  assert.equal(f.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(f.active, true);
  assert.equal(f.x402Support, false);
  assert.equal(f.name, "coder-0");
});

test("services name the ENS name and the profile page", () => {
  const f = registrationFile(agent(), CHAIN);
  assert.deepEqual(f.services, [
    { name: "ENS", endpoint: "coder-0.mergit.eth", version: "v1" },
    { name: "web", endpoint: "https://mergit.site/agents/coder-0.mergit.eth" },
  ]);
});

test("once the agent id is known the file lists the Identity registration on Base Sepolia", () => {
  const f = registrationFile(agent({ agentId: 2 }), CHAIN);
  assert.deepEqual(f.registrations, [{ agentId: 2, agentRegistry: "eip155:84532:0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" }]);
});

test("before the agent id is known (HLD 8.1 step 1) registrations is absent, not an empty or placeholder list", () => {
  const f = registrationFile(agent(), CHAIN);
  assert.equal("registrations" in f, false);
  assert.equal("registrations" in JSON.parse(serializeRegistration(f)), false);
});

test("supportedTrust defaults to reputation only, and can be overridden", () => {
  assert.deepEqual(registrationFile(agent(), CHAIN).supportedTrust, ["reputation"]);
  assert.deepEqual(registrationFile(agent({ supportedTrust: ["reputation", "crypto-economic"] }), CHAIN).supportedTrust, ["reputation", "crypto-economic"]);
});

test("labels that are not valid single DNS labels are refused", () => {
  for (const label of ["A", "coder.0", "", "-x", "x-", "a b", "é", "a".repeat(64)]) {
    assert.throws(() => ensNameOf(label), /label/i, `label ${JSON.stringify(label)} should be refused`);
  }
  assert.equal(ensNameOf("coder-0"), "coder-0.mergit.eth");
  assert.equal(ensNameOf("a".repeat(63)), `${"a".repeat(63)}.mergit.eth`);
});

test("serializeRegistration is two-space JSON with a trailing newline that round-trips", () => {
  const f = registrationFile(agent({ agentId: 2 }), CHAIN);
  const s = serializeRegistration(f);
  assert.ok(s.endsWith("}\n"));
  assert.ok(s.includes('\n  "type"'));
  assert.deepEqual(JSON.parse(s), JSON.parse(JSON.stringify(f)));
});

test("a label that is missing or not a string is refused, never turned into 'undefined.mergit.eth'", () => {
  for (const bad of [undefined, null, 5, {}, ["a"]]) {
    assert.throws(() => ensNameOf(bad as unknown as string), /label/i, `label ${JSON.stringify(bad)} should be refused`);
  }
});
