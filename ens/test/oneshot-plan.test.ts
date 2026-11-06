import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { permissionedResolverAbi } from "../src/abi/permissionedResolver.ts";
import { dnsName } from "../src/dns.ts";
import { agentRecords, recordCalls, type OneShotAgent } from "../src/oneshot-plan.ts";
import { agentRegistrationKey } from "../src/ensip25.ts";

const CHAIN = { chainId: 84532, identity: "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" } as const;
const agents: OneShotAgent[] = [0, 1, 2].map((n) => ({
  label: `coder-${n}`, agentId: n + 2, name: `coder-${n}`,
  description: `Mergit coding agent number ${n}.`, profileUrl: `https://mergit.site/agents/coder-${n}.mergit.eth`,
}));

test("agentRecords returns the ENSIP-25 attestation, the context and the web endpoint, in that order", () => {
  const r = agentRecords(agents[0], CHAIN);
  assert.deepEqual(r, [
    { key: agentRegistrationKey(CHAIN.identity, CHAIN.chainId, 2), value: "1" },
    { key: "agent-context", value: "# coder-0\n\nMergit coding agent number 0." },
    { key: "agent-endpoint[web]", value: "https://mergit.site/agents/coder-0.mergit.eth" },
  ]);
});

test("three agents give nine setText calls with the right DNS-encoded names, keys and values", () => {
  const calls = recordCalls(agents, CHAIN);
  assert.equal(calls.length, 9);
  const expected = agents.flatMap((a) => agentRecords(a, CHAIN).map((r) => ({ name: `${a.label}.mergit.eth`, ...r })));
  calls.forEach((data, i) => {
    const d = decodeFunctionData({ abi: permissionedResolverAbi, data });
    assert.equal(d.functionName, "setText");
    assert.deepEqual(d.args, [dnsName(expected[i].name), expected[i].key, expected[i].value]);
  });
});

test("no planned call writes mergit.reputation (that key belongs to the publisher only)", () => {
  for (const data of recordCalls(agents, CHAIN)) {
    const d = decodeFunctionData({ abi: permissionedResolverAbi, data });
    assert.notEqual((d.args as unknown[])[1], "mergit.reputation");
  }
});

test("duplicate labels, duplicate agent ids and a missing agent id are refused", () => {
  assert.throws(() => recordCalls([agents[0], { ...agents[1], label: "coder-0" }], CHAIN), /duplicate label/i);
  assert.throws(() => recordCalls([agents[0], { ...agents[1], agentId: 2 }], CHAIN), /duplicate agent id/i);
  assert.throws(() => recordCalls([{ ...agents[0], agentId: undefined as unknown as number }], CHAIN), /agent id/i);
  assert.throws(() => recordCalls([{ ...agents[0], agentId: 0 }], CHAIN), /agent id/i);
  assert.throws(() => recordCalls([], CHAIN), /no agents/i);
});

test("an agent with no label is refused by the planner", () => {
  assert.throws(() => recordCalls([{ ...agents[0], label: undefined as unknown as string }], CHAIN), /label/i);
});
