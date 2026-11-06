import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import { editMessage, memoryNonceStore, verifyEdit, type EditRequest } from "../src/edit-request.ts";
import { testAccount } from "../src/test-accounts.ts";

const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const CHAIN_ID = 84532;
const alice = testAccount(2), bob = testAccount(3), carol = testAccount(5);
const NOW = 1_800_000_000;
const STARTED = NOW - 3600;

const base = (operator: Address) => {
  const state = { operator, reads: 0 };
  return { state, client: { async readContract(a: { functionName: string; args: readonly unknown[] }) {
    assert.equal(a.functionName, "operatorOf");
    state.reads++;
    return state.operator;
  } } };
};
const req = (over: Partial<EditRequest> = {}): EditRequest => ({
  agentId: 2, key: "agent-endpoint[web]", value: "https://mergit.site/agents/coder-0.mergit.eth", nonce: "n-1",
  issuedAt: NOW - 10, expiresAt: NOW + 290, ...over,
});
const sign = (who: typeof alice, r: EditRequest) => who.signMessage({ message: editMessage(r, { chainId: CHAIN_ID, identity: IDENTITY }) });
const ctx = (b: ReturnType<typeof base>, store = memoryNonceStore(), now = NOW) =>
  ({ base: b.client, identity: IDENTITY, chainId: CHAIN_ID, now, seenNonces: store, startedAt: STARTED });

test("a request signed by the current operator is accepted and returns the operator", async () => {
  const b = base(alice.address);
  const r = req();
  assert.deepEqual(await verifyEdit(r, await sign(alice, r), ctx(b)), { operator: alice.address });
});

test("a request signed by anyone else is refused", async () => {
  const b = base(alice.address);
  const r = req();
  await assert.rejects(verifyEdit(r, await sign(bob, r), ctx(b)), /not the operator/);
});

test("a signature over a different value, agent, key or expiry does not carry over to the submitted request", async () => {
  const b = base(alice.address);
  const signed = req();
  const sig = await sign(alice, signed);
  for (const tampered of [req({ value: "https://evil.example/x" }), req({ agentId: 3 }), req({ key: "agent-context", value: "hi" }), req({ expiresAt: NOW + 590 })]) {
    await assert.rejects(verifyEdit(tampered, sig, ctx(b)), /not the operator/, JSON.stringify(tampered));
  }
});

test("expired requests, requests with too long a validity window and requests older than the service are refused", async () => {
  const b = base(alice.address);
  const expired = req({ expiresAt: NOW });
  await assert.rejects(verifyEdit(expired, await sign(alice, expired), ctx(b)), /expired/);
  const long = req({ issuedAt: NOW - 10, expiresAt: NOW + 700 });
  await assert.rejects(verifyEdit(long, await sign(alice, long), ctx(b)), /validity window/);
  const old = req({ issuedAt: NOW - 10, expiresAt: NOW + 290 });
  await assert.rejects(verifyEdit(old, await sign(alice, old), { ...ctx(b), startedAt: NOW - 5 }), /before the service started/);
});

test("a nonce cannot be reused, and a refused request does not burn its nonce", async () => {
  const b = base(alice.address);
  const store = memoryNonceStore();
  const r = req({ nonce: "once" });
  await assert.rejects(verifyEdit(r, await sign(bob, r), ctx(b, store)), /not the operator/);
  assert.equal(store.has("once"), false, "a refused request must not record its nonce");
  await verifyEdit(r, await sign(alice, r), ctx(b, store));
  assert.equal(store.has("once"), true);
  await assert.rejects(verifyEdit(r, await sign(alice, r), ctx(b, store)), /replayed/);
});

test("only agent-context and agent-endpoint[web] may be edited", async () => {
  const b = base(alice.address);
  for (const key of ["mergit.reputation", "mergit.operator", "agent-registration[0x0001000003014a341472eac041ee897ff0385022639452fe08dcd4b7d6][2]", "", "agent-endpoint[api]"]) {
    const r = req({ key: key as never, value: "https://x.example" });
    await assert.rejects(verifyEdit(r, await sign(alice, r), ctx(b)), /key not allowed/, JSON.stringify(key));
  }
});

test("endpoint values must be short https URLs without whitespace or control characters", async () => {
  const b = base(alice.address);
  for (const value of ["http://mergit.site/a", "ftp://x", "not a url", "https://mergit.site/a b", "https://mergit.site/a\nb", "https://mergit.site/\u0000", "https://x.example/" + "a".repeat(300), ""]) {
    const r = req({ value });
    await assert.rejects(verifyEdit(r, await sign(alice, r), ctx(b)), /invalid value/, JSON.stringify(value).slice(0, 40));
  }
});

test("context values may use newlines but not other control characters and not more than 2,000 characters", async () => {
  const b = base(alice.address);
  const ok = req({ key: "agent-context", value: "# coder-0\n\nA coding agent." });
  await verifyEdit(ok, await sign(alice, ok), ctx(b));
  for (const value of ["tab\there", "bell\u0007", "a".repeat(2001), ""]) {
    const r = req({ key: "agent-context", value, nonce: "c" + value.length });
    await assert.rejects(verifyEdit(r, await sign(alice, r), ctx(b)), /invalid value/, JSON.stringify(value).slice(0, 20));
  }
});

test("after the agent is transferred, the previous owner's still-valid signed request is refused (ownership is read at verification time)", async () => {
  const b = base(alice.address);
  const r = req();
  const sig = await sign(alice, r);
  b.state.operator = carol.address; // transferred on Base
  await assert.rejects(verifyEdit(r, sig, ctx(b)), /not the operator/);
  const r2 = req({ nonce: "n-2" });
  assert.equal((await verifyEdit(r2, await sign(carol, r2), ctx(b))).operator, carol.address);
});

test("operatorOf is read on every verification, never cached", async () => {
  const b = base(alice.address);
  const store = memoryNonceStore();
  for (const n of ["a", "b", "c"]) { const r = req({ nonce: n }); await verifyEdit(r, await sign(alice, r), ctx(b, store)); }
  assert.equal(b.state.reads, 3);
});

test("two concurrent copies of the same signed request: exactly one is accepted (the nonce is reserved before any await)", async () => {
  const b = base(alice.address);
  const slow = { async readContract(a: { functionName: string; args: readonly unknown[] }) { await new Promise((r) => setTimeout(r, 10)); return b.client.readContract(a); } };
  const store = memoryNonceStore();
  const r = req({ nonce: "race" });
  const sig = await sign(alice, r);
  const results = await Promise.allSettled([verifyEdit(r, sig, { ...ctx(b, store), base: slow }), verifyEdit(r, sig, { ...ctx(b, store), base: slow })]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
  assert.match(rejected.reason.message, /replayed/);
});

test("a request refused after its nonce was reserved gives the nonce back", async () => {
  const b = base(alice.address);
  const store = memoryNonceStore();
  const r = req({ nonce: "give-back" });
  await assert.rejects(verifyEdit(r, await sign(bob, r), ctx(b, store)), /not the operator/);
  assert.equal(store.has("give-back"), false);
});
