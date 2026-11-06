import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { LedgerRecord, LedgerState, SnapshotSummary } from "../../chain/ens/ledger.ts";
import { LEDGER_COMMITMENT, NO_LEDGER, ledgerView } from "./ledgerView";

const HASH: Hex = `0x${"ab".repeat(32)}`;
const OTHER: Hex = `0x${"cd".repeat(32)}`;
const ANCHOR = "0xf9DBfF75887361A67269765DA6F8732b233Fda76" as Address;
const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" as Address;
const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const URI = "https://mergit.site/ledger/final-200.json";
const CTX = { chainName: "Base Sepolia" };

const record: LedgerRecord = {
  chainId: 84532,
  anchor: ANCHOR,
  identity: IDENTITY,
  fromBlock: 100,
  toBlock: 200,
  outcomes: 3,
  agents: 2,
  hash: HASH,
  uri: URI,
  note: "Final ledger.",
};

const summary: SnapshotSummary = {
  createdAt: "2026-11-06T12:00:00Z",
  chainId: 84532,
  identity: IDENTITY,
  anchor: ANCHOR,
  fromBlock: 100,
  toBlock: 200,
  agents: [
    {
      agentId: 2,
      operator: OPERATOR,
      ensName: "coder-0.mergit.eth",
      outcomes: 2,
      successes: 1,
      auditedStaked: 2,
      verifiedStaked: 1,
    },
    { agentId: 3, operator: null, ensName: null, outcomes: 1, successes: 1, auditedStaked: 1, verifiedStaked: 1 },
  ],
  totals: { agents: 2, outcomes: 3, successes: 2, auditedStaked: 3, verifiedStaked: 2 },
  outcomeCount: 3,
  firstOutcomes: [],
  commitmentCount: 4,
};

const OK: Extract<LedgerState, { status: "ok" }> = { status: "ok", record, summary, hash: HASH, verified: true };
const all = (v: ReturnType<typeof ledgerView>) =>
  [v.title, v.verdict.text, ...v.sentences, v.hashCheck?.sentence ?? ""].join(" ");

describe("ledgerView", () => {
  it("says plainly that nothing is published when the record is absent", () => {
    const v = ledgerView({ status: "absent" }, CTX);
    expect(v.title).toBe(NO_LEDGER);
    expect(NO_LEDGER).toBe("No final ledger has been published yet.");
    expect(v).toMatchObject({ fileUrl: null, hashCheck: null, agents: [], record: [], commitment: null });
  });

  it("says the record could not be read when the RPC failed, without blaming the ledger", () => {
    const v = ledgerView({ status: "unavailable" }, CTX);
    expect(all(v)).toMatch(/could not read the ENS record mergit\.ledger/i);
    expect(v).toMatchObject({ fileUrl: null, hashCheck: null, agents: [] });
  });

  it("shows a verified ledger: the hash matches, the range, the totals and each agent", () => {
    const v = ledgerView(OK, CTX);
    expect(v.verdict.tone).toBe("ok");
    expect(v.commitment).toBe(LEDGER_COMMITMENT);
    expect(LEDGER_COMMITMENT).toBe("Committed on Ethereum mainnet in the ENS record mergit.ledger of mergit.eth.");
    expect(v.hashCheck).toEqual({
      matches: true,
      sentence: "The snapshot file matches the hash committed on ENS.",
      committed: HASH,
      computed: HASH,
    });
    expect(v.range).toBe("Base Sepolia blocks 100 to 200");
    expect(v.fileUrl).toBe(URI);
    expect(v.totals).toContainEqual({ label: "Outcomes", value: "3" });
    expect(v.totals).toContainEqual({ label: "Passed", value: "2" });
    expect(v.agents).toEqual([
      {
        agentId: "2",
        name: "coder-0.mergit.eth",
        outcomes: "2",
        passed: "1",
        audited: "2",
        verified: "1",
        operator: OPERATOR,
      },
      { agentId: "3", name: "Agent #3", outcomes: "1", passed: "1", audited: "1", verified: "1", operator: null },
    ]);
    expect(v.record).toContainEqual({ label: "Hash (keccak256)", value: HASH });
    expect(v.createdAt).toBe("2026-11-06T12:00:00Z");
  });

  it("shows a hash mismatch with both hashes and nothing from the file", () => {
    const v = ledgerView({ status: "mismatch", field: "hash", expected: HASH, actual: OTHER, record }, CTX);
    expect(v.verdict.tone).toBe("bad");
    expect(v.hashCheck).toMatchObject({ matches: false, committed: HASH, computed: OTHER });
    expect(v.hashCheck?.sentence).toMatch(/does not match/);
    expect(v.agents).toEqual([]);
    expect(v.totals).toEqual([]);
    expect(v.fileUrl).toBe(URI);
    expect(v.commitment).toBe(LEDGER_COMMITMENT);
  });

  it("explains a file that matches its hash but disagrees with the record, and shows nothing from it", () => {
    const v = ledgerView({ status: "mismatch", field: "range", expected: "100-200", actual: "100-250", record }, CTX);
    expect(v.verdict.tone).toBe("bad");
    expect(v.hashCheck?.matches).toBe(true);
    expect(all(v)).toMatch(/block range/);
    expect(all(v)).toContain("100-200");
    expect(all(v)).toContain("100-250");
    expect(v.agents).toEqual([]);
  });

  it("says the hash was not checked when the file could not be fetched", () => {
    const v = ledgerView({ status: "unreachable", detail: "The ledger file could not be fetched (404).", record }, CTX);
    expect(v.hashCheck).toBeNull();
    expect(all(v)).toMatch(/could not be fetched/);
    expect(all(v)).toMatch(/not checked/);
    expect(v.fileUrl).toBe(URI);
  });

  it("refuses to show a malformed record and quotes its detail on one capped line", () => {
    const detail = `line one\nline two <script>alert(1)</script>${"x".repeat(300)}`;
    const v = ledgerView({ status: "malformed", where: "record", detail }, CTX);
    expect(all(v)).toMatch(/not shown because it is not valid/);
    const quoted = v.sentences.find((s) => s.startsWith('"'));
    expect(quoted).toBeDefined();
    expect(quoted).not.toContain("\n");
    expect((quoted ?? "").length).toBeLessThanOrEqual(122);
    expect(v).toMatchObject({ fileUrl: null, hashCheck: null, commitment: null });
  });

  it("says a committed file that is not a valid snapshot is not shown", () => {
    const v = ledgerView({ status: "malformed", where: "file", detail: "The ledger file is not JSON.", record }, CTX);
    expect(all(v)).toMatch(/snapshot file is not a valid/i);
    expect(v.agents).toEqual([]);
    expect(v.fileUrl).toBe(URI);
  });

  it("keeps a hostile note as plain text lines, without invisible or bidi-override characters", () => {
    const note = "first <b>bold</b> [x](javascript:alert(1))\nsecond‮evil​";
    const v = ledgerView({ ...OK, record: { ...record, note } }, CTX);
    expect(v.note).toEqual(["first <b>bold</b> [x](javascript:alert(1))", "secondevil"]);
  });

  it("links only to an https file", () => {
    const v = ledgerView({ ...OK, record: { ...record, uri: "javascript:alert(1)" } }, CTX);
    expect(v.fileUrl).toBeNull();
  });
});
