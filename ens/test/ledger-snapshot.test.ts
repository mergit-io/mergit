import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, stringToBytes, toHex, type Hex } from "viem";
import { buildSnapshot, ledgerRecord, snapshotHash, type SnapshotInput } from "../src/ledger-snapshot.ts";
import type { Outcome } from "../src/reputation-mirror.ts";

const IDENTITY = getAddress("0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6");
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const OP = getAddress("0x040510eE34d76253FCF94abDb65b67358fF5fa94");
const CAT = keccak256(toHex("test-repair"));
const t = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const o = (n: number, over: Partial<Outcome> = {}): Outcome => ({ taskId: t(n), agentId: 2n, category: CAT, success: true, costMicros: 1500n, tier: 0, source: 0, blockNumber: BigInt(100 + n), logIndex: n, ...over });
const input = (outcomes: Outcome[], extra: Partial<SnapshotInput> = {}): SnapshotInput => ({
  chain: { id: 84532, identity: IDENTITY, anchor: ANCHOR }, range: { fromBlock: 100n, toBlock: 200n },
  agents: [{ agentId: 3, operator: OP, metadataUri: "https://mergit.site/registrations/b.json", label: null }, { agentId: 2, operator: OP, metadataUri: "https://mergit.site/registrations/a.json", label: "coder-0" }],
  outcomes, knownCategories: ["test-repair"], createdAt: "2026-11-06T06:00:00.000Z", ...extra,
});

test("the snapshot is deterministic: the order of the input does not change a byte", () => {
  const a = buildSnapshot(input([o(3), o(1), o(2)]));
  const b = buildSnapshot(input([o(2), o(3), o(1)], { agents: input([]).agents.slice().reverse() }));
  assert.equal(a, b);
  assert.ok(a.endsWith("\n") && !a.slice(0, -1).includes("\n"), "compact JSON on one line plus a trailing newline");
});

test("the snapshot carries every outcome (including tier 1) with costs as strings, agents sorted by id, and tier 0 counts with the ruling-wins rule", () => {
  const outcomes = [o(1), o(2, { success: false }), o(3, { tier: 1 }), o(4, { source: 0, success: true }), o(4, { source: 1, success: false, blockNumber: 300n, logIndex: 9 })];
  const s = JSON.parse(buildSnapshot(input(outcomes)));
  assert.equal(s.v, 0);
  assert.equal(s.kind, "mergit-ledger-snapshot");
  assert.equal(s.createdAt, "2026-11-06T06:00:00.000Z");
  assert.deepEqual(s.chain, { id: 84532, identity: IDENTITY, anchor: ANCHOR });
  assert.deepEqual(s.range, { fromBlock: 100, toBlock: 200 });
  assert.deepEqual(s.agents.map((a: { agentId: number }) => a.agentId), [2, 3]);
  assert.equal(s.agents[0].ensName, "coder-0.mergit.eth");
  assert.equal(s.agents[1].ensName, null);
  assert.equal(s.outcomes.length, 5, "every recorded outcome is in the file");
  assert.equal(s.outcomes[0].costMicros, "1500");
  assert.equal(s.outcomes[0].categoryLabel, "test-repair");
  assert.equal(s.outcomes[0].taskId, t(1));
  // tier 0 tasks: 1 (ok), 2 (fail), 4 (audited ok, overturned by the ruling -> fail): audited 3, verified 1; task 3 is tier 1 and not counted
  assert.deepEqual(s.counts, [{ agentId: 2, auditedStaked: 3, verifiedStaked: 1, byCategory: { "test-repair": { auditedStaked: 3, verifiedStaked: 1 } } }]);
});

test("an unknown category keeps its hash and has no label", () => {
  const s = JSON.parse(buildSnapshot(input([o(1, { category: keccak256(toHex("mystery")) })])));
  assert.equal(s.outcomes[0].categoryLabel, null);
  assert.ok(Object.keys(s.counts[0].byCategory)[0]!.startsWith("0x"));
});

test("commitments and terms are included verbatim when given and absent otherwise", () => {
  const plain = JSON.parse(buildSnapshot(input([o(1)])));
  assert.equal("commitments" in plain, false);
  assert.equal("terms" in plain, false);
  const rich = JSON.parse(buildSnapshot(input([o(1)], { commitments: [{ task_id: t(1), root: t(9) }], terms: { disputeWindowSeconds: 600 } })));
  assert.deepEqual(rich.commitments, [{ task_id: t(1), root: t(9) }]);
  assert.deepEqual(rich.terms, { disputeWindowSeconds: 600 });
});

test("an empty ledger is a valid snapshot", () => {
  const s = JSON.parse(buildSnapshot(input([])));
  assert.deepEqual(s.outcomes, []);
  assert.deepEqual(s.counts, []);
});

test("the hash is keccak256 of the file's exact bytes and changes if any outcome changes", () => {
  const text = buildSnapshot(input([o(1), o(2)]));
  assert.equal(snapshotHash(text), keccak256(stringToBytes(text)));
  assert.notEqual(snapshotHash(text), snapshotHash(buildSnapshot(input([o(1), o(2, { success: false })]))));
  assert.notEqual(snapshotHash(text), snapshotHash(buildSnapshot(input([o(1), o(2, { costMicros: 1501n })]))));
});

test("the ENS record is compact JSON in the agreed key order, bound to the file by hash and https uri", () => {
  const text = buildSnapshot(input([o(1), o(2)]));
  const hash = snapshotHash(text);
  const rec = ledgerRecord({ chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock: 100n, toBlock: 200n, outcomes: 2, agents: 2, hash, uri: "https://mergit.site/ledger/final-200.json" });
  assert.deepEqual(Object.keys(JSON.parse(rec)), ["v", "kind", "chainId", "anchor", "identity", "fromBlock", "toBlock", "outcomes", "agents", "hash", "uri", "note"]);
  assert.deepEqual(JSON.parse(rec), { v: 0, kind: "ledger-snapshot", chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock: 100, toBlock: 200, outcomes: 2, agents: 2, hash, uri: "https://mergit.site/ledger/final-200.json", note: JSON.parse(rec).note });
  assert.ok(!rec.includes("\n") && !rec.includes(": "), "compact");
  assert.ok(rec.length < 1000, "small enough to cost little gas");
});

test("the record refuses a non-https uri, a malformed hash and an oversized note", () => {
  const base = { chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock: 1n, toBlock: 2n, outcomes: 0, agents: 0, hash: snapshotHash("x"), uri: "https://mergit.site/ledger/f.json" };
  for (const uri of ["http://mergit.site/f.json", "ipfs://x", "/ledger/f.json", "https://x.example/a b"]) assert.throws(() => ledgerRecord({ ...base, uri }), /uri/i);
  assert.throws(() => ledgerRecord({ ...base, hash: "0x12" as Hex }), /hash/i);
  assert.throws(() => ledgerRecord({ ...base, note: "n".repeat(501) }), /note/i);
});

import { checkLedgerRecord } from "../src/ledger-snapshot.ts";

test("checkLedgerRecord accepts exactly what ledgerRecord writes and refuses anything else", () => {
  const good = ledgerRecord({ chainId: 84532, anchor: ANCHOR, identity: IDENTITY, fromBlock: 1n, toBlock: 2n, outcomes: 0, agents: 0, hash: snapshotHash("x"), uri: "https://mergit.site/ledger/f.json" });
  assert.doesNotThrow(() => checkLedgerRecord(good));
  for (const bad of ["", "not json", "[]", "null", JSON.stringify({ ...JSON.parse(good), v: 1 }), JSON.stringify({ ...JSON.parse(good), kind: "other" }),
    JSON.stringify({ ...JSON.parse(good), uri: "http://x.example/f.json" }), JSON.stringify({ ...JSON.parse(good), hash: "0x12" }), "x".repeat(5000)]) {
    assert.throws(() => checkLedgerRecord(bad), /ledger record/i, bad.slice(0, 40));
  }
});
