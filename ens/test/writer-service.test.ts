import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { dnsName } from "../src/dns.ts";
import { editMessage, memoryNonceStore, type EditRequest } from "../src/edit-request.ts";
import { handleEdit, newServiceState, startService, type EditDeps } from "../src/writer-service.ts";
import { testAccount } from "../src/test-accounts.ts";

const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const RESOLVER = getAddress("0x13C6c51B109972043DD487d97961D9f141e846c9");
const alice = testAccount(2), bob = testAccount(3);
const NOW = 1_800_000_000;

function deps(over: Partial<EditDeps> = {}) {
  const sent: { functionName: string; args: unknown[]; address: string }[] = [];
  const logs: string[] = [];
  const d: EditDeps = {
    base: { async readContract() { return alice.address; } },
    ens: {
      async waitForTransactionReceipt() { return { status: "success" as const }; },
      async readContract() { return encodeFunctionResult({ abi: parseAbi(["function text(bytes32 node, string key) view returns (string)"]), functionName: "text", result: "1" }); }, // the agent-registration record exists
    },
    wallet: { async writeContract(a: { functionName: string; args: unknown[]; address: string }) { sent.push(a); return ("0x" + "ab".repeat(32)) as Hex; } },
    identity: IDENTITY, chainId: 84532, resolver: RESOLVER, agents: [{ label: "coder-0", agentId: 2 }],
    seenNonces: memoryNonceStore(), startedAt: NOW - 3600, now: () => NOW, state: newServiceState(), limits: { perAgentPerHour: 6, perHour: 60, requestsPerMinute: 1000 }, secrets: ["SECRET-RPC-KEY"], log: (m: string) => logs.push(m), ...over,
  } as EditDeps;
  return { d, sent, logs };
}
const request = (over: Partial<EditRequest> = {}): EditRequest => ({ agentId: 2, key: "agent-endpoint[web]", value: "https://mergit.site/agents/coder-0.mergit.eth",
  nonce: "n-" + Math.random().toString(36).slice(2), issuedAt: NOW - 5, expiresAt: NOW + 295, ...over });
const body = async (who: typeof alice, r: EditRequest) => ({ request: r, signature: await who.signMessage({ message: editMessage(r, { chainId: 84532, identity: IDENTITY }) }) });

test("a valid signed request makes the editor wallet send exactly one setText for the agent's name", async () => {
  const { d, sent } = deps();
  const r = request();
  const res = await handleEdit(await body(alice, r), d);
  assert.equal(res.status, 200);
  assert.equal((res.body as { operator: string }).operator, alice.address);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].functionName, "setText");
  assert.equal(sent[0].address, RESOLVER);
  assert.deepEqual(sent[0].args, [dnsName("coder-0.mergit.eth"), "agent-endpoint[web]", r.value]);
});

test("every refusal answers with a reason and sends nothing", async () => {
  const cases: [string, () => Promise<unknown>, number, RegExp][] = [
    ["wrong signer", async () => body(bob, request()), 403, /not the operator/],
    ["expired", async () => body(alice, request({ expiresAt: NOW - 1, issuedAt: NOW - 100 })), 400, /expired/],
    ["reputation key", async () => body(alice, request({ key: "mergit.reputation" as never, value: "https://x.example" })), 403, /key not allowed/],
    ["operator key", async () => body(alice, request({ key: "mergit.operator" as never, value: "0x1" })), 403, /key not allowed/],
    ["http endpoint", async () => body(alice, request({ value: "http://mergit.site/a" })), 400, /invalid value/],
    ["not an object", async () => "nope", 400, /body/],
    ["no signature", async () => ({ request: request() }), 400, /signature/],
    ["signature not hex", async () => ({ request: request(), signature: "zz" }), 400, /signature/],
    ["no request", async () => ({ signature: "0x00" }), 400, /request/],
  ];
  for (const [name, make, status, re] of cases) {
    const { d, sent } = deps();
    const res = await handleEdit(await make(), d);
    assert.equal(res.status, status, name);
    assert.match(JSON.stringify(res.body), re, name);
    assert.equal(sent.length, 0, `${name}: nothing may be sent`);
  }
});

test("a replayed nonce is refused with 409 and sends nothing the second time", async () => {
  const { d, sent } = deps();
  const b = await body(alice, request({ nonce: "same" }));
  assert.equal((await handleEdit(b, d)).status, 200);
  const again = await handleEdit(b, d);
  assert.equal(again.status, 409);
  assert.equal(sent.length, 1);
});

test("an agent id the service does not manage answers 404 and sends nothing", async () => {
  const { d, sent } = deps();
  const res = await handleEdit(await body(alice, request({ agentId: 9 })), d);
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0);
});

test("an unexpected failure answers a generic 500, and neither the response nor the log contains the secret", async () => {
  const { d, logs } = deps({ wallet: { async writeContract() { throw new Error("HTTP request failed. URL: https://rpc.example/v2/SECRET-RPC-KEY"); } } as never });
  const res = await handleEdit(await body(alice, request()), d);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal error" });
  assert.ok(logs.length >= 1);
  assert.ok(!logs.join("\n").includes("SECRET-RPC-KEY"));
});

test("the HTTP service answers healthz, rejects bad bodies and unknown paths, limits body size, and survives a failing publish pass", async () => {
  const { d, logs } = deps();
  let passes = 0;
  const svc = await startService({ ...d, port: 0, intervalSeconds: 3600, publish: async () => { passes++; throw new Error("pass failed at https://rpc.example/v2/SECRET-RPC-KEY"); } });
  try {
    const url = `http://127.0.0.1:${svc.port}`;
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/edit`, { method: "POST", body: "{not json" })).status, 400);
    assert.equal((await fetch(`${url}/edit`, { method: "POST", body: JSON.stringify({ request: {}, signature: "0x" }) })).status, 400);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/edit`)).status, 404, "only POST is accepted on /edit");
    assert.equal((await fetch(`${url}/edit`, { method: "POST", body: "x".repeat(20_000) })).status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(passes >= 1, "a publish pass runs at start");
    assert.ok(logs.some((l) => /publish pass failed/.test(l)));
    assert.ok(!logs.join("\n").includes("SECRET-RPC-KEY"), "the log must be redacted");
    assert.equal((await fetch(`${url}/healthz`)).status, 200, "a failing pass must not stop the service");
  } finally { await svc.close(); }
});

test("two concurrent copies of one signed request send exactly one transaction (one 200, one 409)", async () => {
  const { d, sent } = deps({ base: { async readContract() { await new Promise((r) => setTimeout(r, 10)); return alice.address; } } as never });
  const b = await body(alice, request({ nonce: "dup" }));
  const [x, y] = await Promise.all([handleEdit(b, d), handleEdit(b, d)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(sent.length, 1);
});

test("edit transactions from the one editor account are sent one at a time", async () => {
  let inFlight = 0, max = 0;
  const { d } = deps({ wallet: { async writeContract() { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return ("0x" + "cd".repeat(32)) as Hex; } } as never });
  const results = await Promise.all([1, 2, 3].map(async (n) => handleEdit(await body(alice, request({ nonce: "c" + n, value: `https://mergit.site/a${n}` })), d)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(max, 1, "the editor account must never have two writes in flight");
});

test("the per-agent hourly cap answers 429 and sends nothing; other agents and the next hour are unaffected", async () => {
  let now = NOW;
  const { d, sent } = deps({ agents: [{ label: "coder-0", agentId: 2 }, { label: "coder-1", agentId: 3 }], now: () => now, limits: { perAgentPerHour: 2, perHour: 100, requestsPerMinute: 1000 } });
  for (const n of ["a", "b"]) assert.equal((await handleEdit(await body(alice, request({ nonce: n, issuedAt: now - 5, expiresAt: now + 295 })), d)).status, 200);
  const third = await handleEdit(await body(alice, request({ nonce: "c" })), d);
  assert.equal(third.status, 429);
  assert.equal(sent.length, 2);
  assert.equal((await handleEdit(await body(alice, request({ nonce: "d", agentId: 3 })), d)).status, 200, "another agent still has its own budget");
  now += 3601;
  assert.equal((await handleEdit(await body(alice, request({ nonce: "e", issuedAt: now - 5, expiresAt: now + 295 })), d)).status, 200, "the window slides");
});

test("the global hourly cap protects the editor key's gas across all agents", async () => {
  const { d, sent } = deps({ agents: [{ label: "coder-0", agentId: 2 }, { label: "coder-1", agentId: 3 }], limits: { perAgentPerHour: 10, perHour: 2, requestsPerMinute: 1000 } });
  assert.equal((await handleEdit(await body(alice, request({ nonce: "a", agentId: 2 })), d)).status, 200);
  assert.equal((await handleEdit(await body(alice, request({ nonce: "b", agentId: 3 })), d)).status, 200);
  assert.equal((await handleEdit(await body(alice, request({ nonce: "c", agentId: 2 })), d)).status, 429);
  assert.equal(sent.length, 2);
});

test("a request-rate cap bounds RPC reads from callers who never produce a valid signature", async () => {
  const { d } = deps({ limits: { perAgentPerHour: 6, perHour: 60, requestsPerMinute: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await handleEdit("junk", d)).status, 400);
  assert.equal((await handleEdit("junk", d)).status, 429);
});

test("an agent whose name has no agent-registration record is not edited (wrong label or id in the config) and the failure is logged", async () => {
  const { d, sent, logs } = deps({ ens: { async waitForTransactionReceipt() { return { status: "success" as const }; },
    async readContract() { return encodeFunctionResult({ abi: parseAbi(["function text(bytes32 node, string key) view returns (string)"]), functionName: "text", result: "" }); } } as never });
  const res = await handleEdit(await body(alice, request()), d);
  assert.equal(res.status, 503);
  assert.equal(sent.length, 0);
  assert.ok(logs.some((l) => /agent-registration/.test(l)));
});
