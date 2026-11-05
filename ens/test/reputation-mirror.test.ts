import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { categoryLabel, foldOutcomes, reputationRecord, type Outcome } from "../src/reputation-mirror.ts";

const CAT = keccak256(toHex("test-repair"));
const CAT2 = keccak256(toHex("bug-fix"));
const ANCHOR = getAddress("0xf9DBfF75887361A67269765DA6F8732b233Fda76");
const task = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
let log = 0;
const o = (p: Partial<Outcome> & { task: number }): Outcome => ({
  taskId: task(p.task), agentId: p.agentId ?? 2n, category: p.category ?? CAT, success: p.success ?? true, tier: p.tier ?? 0,
  source: p.source ?? 0, blockNumber: p.blockNumber ?? 100n, logIndex: p.logIndex ?? log++,
});
const META = { chainId: 84532, contract: ANCHOR, asOfBlock: 123n };
const NOTE = "Mirror of ReputationAnchor tier 0 outcomes. Not a score. Chain is the source of truth.";

test("tier 0 outcomes are counted: audited is every counted task, verified is the successful ones", () => {
  const m = foldOutcomes([o({ task: 1 }), o({ task: 2 }), o({ task: 3, success: false })]);
  const c = m.get(2n)!;
  assert.equal(c.auditedStaked, 3);
  assert.equal(c.verifiedStaked, 2);
  assert.deepEqual(c.byCategory.get(CAT), { auditedStaked: 3, verifiedStaked: 2 });
});

test("tier 1 (faucet) outcomes are never counted, and an agent with only tier 1 outcomes is absent", () => {
  const m = foldOutcomes([o({ task: 1, tier: 1 }), o({ task: 2, tier: 1, agentId: 5n }), o({ task: 3 })]);
  assert.deepEqual([...m.keys()], [2n]);
  assert.equal(m.get(2n)!.auditedStaked, 1);
});

test("a task recorded twice (audit verdict, then challenge ruling) counts once and the ruling wins, in any input order", () => {
  const overturned = [o({ task: 1, source: 0, success: true, blockNumber: 100n }), o({ task: 1, source: 1, success: false, blockNumber: 120n })];
  const upheld = [o({ task: 2, source: 0, success: false, blockNumber: 100n }), o({ task: 2, source: 1, success: true, blockNumber: 120n })];
  for (const input of [overturned, [...overturned].reverse()]) {
    const c = foldOutcomes(input).get(2n)!;
    assert.equal(c.auditedStaked, 1, "counted once");
    assert.equal(c.verifiedStaked, 0, "the ruling (failure) wins over the audit (success)");
  }
  for (const input of [upheld, [...upheld].reverse()]) {
    const c = foldOutcomes(input).get(2n)!;
    assert.equal(c.auditedStaked, 1);
    assert.equal(c.verifiedStaked, 1, "the ruling (success) wins over the audit (failure)");
  }
});

test("agents and categories are kept apart", () => {
  const m = foldOutcomes([o({ task: 1, agentId: 2n }), o({ task: 2, agentId: 3n, category: CAT2 }), o({ task: 3, agentId: 3n, category: CAT2, success: false })]);
  assert.equal(m.get(2n)!.auditedStaked, 1);
  assert.deepEqual(m.get(3n)!.byCategory.get(CAT2), { auditedStaked: 2, verifiedStaked: 1 });
  assert.equal(m.get(3n)!.byCategory.has(CAT), false);
});

test("a category shows its label only when the label is known, otherwise the hash", () => {
  assert.equal(categoryLabel(CAT, ["test-repair", "bug-fix"]), "test-repair");
  assert.equal(categoryLabel(CAT2, ["test-repair", "bug-fix"]), "bug-fix");
  assert.equal(categoryLabel(CAT, []), CAT);
  assert.equal(categoryLabel(CAT.toUpperCase().replace("0X", "0x") as Hex, ["test-repair"]), "test-repair", "hash comparison ignores case");
});

test("the record has exactly the HLD 6.3 shape, is compact and deterministic, with categories sorted", () => {
  const counts = foldOutcomes([o({ task: 1 }), o({ task: 2, category: CAT2, success: false })]).get(2n)!;
  const s = reputationRecord(counts, META, ["test-repair", "bug-fix"]);
  assert.equal(s, reputationRecord(counts, META, ["test-repair", "bug-fix"]));
  assert.ok(!s.includes("\n") && !s.includes(": "), "compact JSON, no whitespace, to keep calldata small");
  assert.deepEqual(JSON.parse(s), {
    v: 0, mirror: true, source: { chainId: 84532, contract: ANCHOR }, asOfBlock: 123,
    auditedStaked: 2, verifiedStaked: 1,
    byCategory: { "bug-fix": { auditedStaked: 1, verifiedStaked: 0 }, "test-repair": { auditedStaked: 1, verifiedStaked: 1 } },
    note: NOTE,
  });
  assert.deepEqual(Object.keys(JSON.parse(s).byCategory), ["bug-fix", "test-repair"]);
});
