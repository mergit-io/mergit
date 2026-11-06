import { keccak256, toBytes, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { LEDGER_KEY, loadLedger, parseLedgerRecord, parseSnapshot, type LedgerClients } from "./ledger.ts";

const ANCHOR = "0xf9DBfF75887361A67269765DA6F8732b233Fda76" as Address;
const IDENTITY = "0x72eAc041Ee897fF0385022639452fE08Dcd4B7D6" as Address;
const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RESOLVER = "0x06fdd07f007adac667177b46ab2eb9a75132cfd5" as Address;
const EXPECTED = { chainId: 84532, anchor: ANCHOR };
const CFG = { universalResolver: RESOLVER, ...EXPECTED };
const TASK = `0x${"ab".repeat(32)}`;
const CATEGORY = `0x${"cd".repeat(32)}`;

const outcome = (agentId: number, success: boolean, blockNumber = 150) => ({
  taskId: TASK,
  agentId,
  category: CATEGORY,
  categoryLabel: "test-repair",
  success,
  costMicros: "120000",
  tier: 0,
  source: 0,
  blockNumber,
});

const snapshot = (edit: (s: Record<string, unknown>) => void = () => undefined): Record<string, unknown> => {
  const s: Record<string, unknown> = {
    v: 0,
    kind: "mergit-ledger-snapshot",
    createdAt: "2026-11-06T12:00:00Z",
    chain: { id: 84532, identity: IDENTITY, anchor: ANCHOR },
    range: { fromBlock: 100, toBlock: 200 },
    agents: [
      {
        agentId: 2,
        operator: OPERATOR,
        metadataUri: "https://mergit.site/registrations/coder-0.json",
        ensName: "coder-0.mergit.eth",
      },
      { agentId: 3, operator: OPERATOR, metadataUri: "https://mergit.site/registrations/coder-1.json", ensName: null },
    ],
    outcomes: [outcome(2, true), outcome(2, false), outcome(3, true)],
    counts: [
      {
        agentId: 2,
        auditedStaked: 2,
        verifiedStaked: 1,
        byCategory: { "test-repair": { auditedStaked: 2, verifiedStaked: 1 } },
      },
      { agentId: 3, auditedStaked: 1, verifiedStaked: 1, byCategory: {} },
    ],
    commitments: [{ any: "gateway row" }],
    terms: { anything: true },
  };
  edit(s);
  return s;
};

const record = (text: string, edit: (r: Record<string, unknown>) => void = () => undefined): string => {
  const r: Record<string, unknown> = {
    v: 0,
    kind: "ledger-snapshot",
    chainId: 84532,
    anchor: ANCHOR,
    identity: IDENTITY,
    fromBlock: 100,
    toBlock: 200,
    outcomes: 3,
    agents: 2,
    hash: keccak256(toBytes(text)),
    uri: "https://mergit.site/ledger/final-200.json",
    note: "Final ledger of the run.",
  };
  edit(r);
  return JSON.stringify(r);
};

const FILE = JSON.stringify(snapshot(), null, 2);

describe("parseLedgerRecord", () => {
  it("reads a record the publisher wrote, and tolerates fields it does not know", () => {
    const r = parseLedgerRecord(
      record(FILE, (x) => (x.extra = { nested: [1] })),
      EXPECTED,
    );
    expect(r).toMatchObject({
      chainId: 84532,
      anchor: ANCHOR,
      identity: IDENTITY,
      fromBlock: 100,
      toBlock: 200,
      outcomes: 3,
      agents: 2,
      hash: keccak256(toBytes(FILE)),
      uri: "https://mergit.site/ledger/final-200.json",
      note: "Final ledger of the run.",
    });
  });

  it("compares the anchor without regard to case and lower-cases the hash", () => {
    const upper = `0x${keccak256(toBytes(FILE)).slice(2).toUpperCase()}`;
    const r = parseLedgerRecord(
      record(FILE, (x) => {
        x.anchor = ANCHOR.toLowerCase();
        x.hash = upper;
      }),
      EXPECTED,
    );
    expect(r.hash).toBe(upper.toLowerCase());
  });

  it("refuses a record for another version, kind, chain or anchor", () => {
    const bad: ((x: Record<string, unknown>) => void)[] = [
      (x) => (x.v = 1),
      (x) => delete x.v,
      (x) => (x.kind = "mergit-ledger-snapshot"),
      (x) => (x.chainId = 8453),
      (x) => (x.chainId = "84532"),
      (x) => (x.anchor = IDENTITY),
      (x) => (x.anchor = 5),
      (x) => (x.identity = "0x123"),
    ];
    for (const edit of bad) expect(() => parseLedgerRecord(record(FILE, edit), EXPECTED), String(edit)).toThrow();
  });

  it("refuses counts and blocks that are not non-negative safe integers, and a range that runs backwards", () => {
    for (const value of [-1, 1.5, "3", null, 2 ** 53, Number.NaN]) {
      for (const key of ["fromBlock", "toBlock", "outcomes", "agents"]) {
        expect(
          () =>
            parseLedgerRecord(
              record(FILE, (x) => (x[key] = value)),
              EXPECTED,
            ),
          `${key}=${String(value)}`,
        ).toThrow();
      }
    }
    expect(() =>
      parseLedgerRecord(
        record(FILE, (x) => (x.fromBlock = 201)),
        EXPECTED,
      ),
    ).toThrow(/range/i);
  });

  it("refuses a hash that is not 0x and 64 hex digits", () => {
    for (const hash of ["0x1234", "a".repeat(64), `0x${"g".repeat(64)}`, `0x${"a".repeat(65)}`, 7, null]) {
      expect(
        () =>
          parseLedgerRecord(
            record(FILE, (x) => (x.hash = hash)),
            EXPECTED,
          ),
        String(hash),
      ).toThrow(/hash/i);
    }
  });

  it("refuses a uri that is not an https URL", () => {
    for (const uri of [
      "http://mergit.site/ledger/final-200.json",
      "javascript:alert(1)",
      "data:application/json,{}",
      "/ledger/final-200.json",
      "//evil.example/x.json",
      "https://user:pass@mergit.site/x.json",
      "",
      42,
      `https://mergit.site/${"x".repeat(3000)}`,
    ]) {
      expect(
        () =>
          parseLedgerRecord(
            record(FILE, (x) => (x.uri = uri)),
            EXPECTED,
          ),
        String(uri),
      ).toThrow(/https|address/i);
    }
  });

  it("caps the note and drops one that is not text", () => {
    expect(
      parseLedgerRecord(
        record(FILE, (x) => (x.note = "n".repeat(900))),
        EXPECTED,
      ).note,
    ).toHaveLength(500);
    expect(
      parseLedgerRecord(
        record(FILE, (x) => (x.note = { html: "<b>" })),
        EXPECTED,
      ).note,
    ).toBe("");
    expect(
      parseLedgerRecord(
        record(FILE, (x) => delete x.note),
        EXPECTED,
      ).note,
    ).toBe("");
  });

  it("refuses anything that is not a JSON object, and a huge record before parsing it", () => {
    for (const raw of ["", "not json", "[]", "null", "42", '"text"']) {
      expect(() => parseLedgerRecord(raw, EXPECTED), raw).toThrow();
    }
    const padded = record(FILE, (x) => (x.pad = " ".repeat(10_000)));
    expect(() => parseLedgerRecord(padded, EXPECTED)).toThrow(/too large/i);
    expect(() => parseLedgerRecord(123 as unknown as string, EXPECTED)).toThrow();
  });

  it("does not read fields through __proto__, and never pollutes Object.prototype", () => {
    const sneaky = `{"__proto__":{"v":0,"kind":"ledger-snapshot"},"chainId":84532}`;
    expect(() => parseLedgerRecord(sneaky, EXPECTED)).toThrow();
    const withProto = record(FILE).replace("{", '{"__proto__":{"polluted":true},');
    expect(parseLedgerRecord(withProto, EXPECTED).outcomes).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parseSnapshot", () => {
  it("summarises the file: range, chain, totals and per-agent counts", () => {
    const s = parseSnapshot(FILE);
    expect(s).toMatchObject({
      createdAt: "2026-11-06T12:00:00Z",
      chainId: 84532,
      identity: IDENTITY,
      anchor: ANCHOR,
      fromBlock: 100,
      toBlock: 200,
      outcomeCount: 3,
      commitmentCount: 1,
      totals: { agents: 2, outcomes: 3, successes: 2, auditedStaked: 3, verifiedStaked: 2 },
    });
    expect(s.agents).toEqual([
      {
        agentId: 2,
        operator: OPERATOR,
        ensName: "coder-0.mergit.eth",
        outcomes: 2,
        successes: 1,
        auditedStaked: 2,
        verifiedStaked: 1,
      },
      { agentId: 3, operator: OPERATOR, ensName: null, outcomes: 1, successes: 1, auditedStaked: 1, verifiedStaked: 1 },
    ]);
    expect(s.firstOutcomes).toHaveLength(3);
    expect(s.firstOutcomes[0]).toMatchObject({
      agentId: 2,
      success: true,
      costMicros: "120000",
      categoryLabel: "test-repair",
    });
  });

  it("keeps only the first 50 outcomes, but counts them all", () => {
    const many = Array.from({ length: 60 }, (_, i) => outcome(2, i % 2 === 0));
    const s = parseSnapshot(JSON.stringify(snapshot((x) => (x.outcomes = many))));
    expect(s.outcomeCount).toBe(60);
    expect(s.firstOutcomes).toHaveLength(50);
    expect(s.totals.successes).toBe(30);
  });

  it("tolerates a file with no counts, commitments or terms, and an outcome of an agent it does not list", () => {
    const s = parseSnapshot(
      JSON.stringify(
        snapshot((x) => {
          delete x.counts;
          delete x.commitments;
          delete x.terms;
          delete x.createdAt;
          x.outcomes = [outcome(9, true)];
        }),
      ),
    );
    expect(s.createdAt).toBeNull();
    expect(s.commitmentCount).toBe(0);
    expect(s.agents.map((a) => a.agentId)).toEqual([2, 3, 9]);
    expect(s.agents[2]).toMatchObject({ ensName: null, operator: null, outcomes: 1, auditedStaked: 0 });
  });

  it("shows no ENS name that is not a mergit.eth name", () => {
    for (const ensName of ["evil.eth", "a.b.mergit.eth", "<script>.mergit.eth", 7, "x".repeat(70) + ".mergit.eth"]) {
      const s = parseSnapshot(
        JSON.stringify(
          snapshot((x) => ((x.agents as Record<string, unknown>[])[0] = { agentId: 2, operator: OPERATOR, ensName })),
        ),
      );
      expect(s.agents[0]?.ensName, String(ensName)).toBeNull();
    }
  });

  it("refuses a file of another kind or version, or one that is not an object", () => {
    for (const text of [
      "",
      "nope",
      "[]",
      "null",
      JSON.stringify(snapshot((x) => (x.v = 1))),
      JSON.stringify(snapshot((x) => (x.kind = "ledger-snapshot"))),
    ]) {
      expect(() => parseSnapshot(text), text.slice(0, 40)).toThrow();
    }
  });

  it("refuses wrong types anywhere it reads", () => {
    const bad: ((x: Record<string, unknown>) => void)[] = [
      (x) => (x.chain = { id: "84532", identity: IDENTITY, anchor: ANCHOR }),
      (x) => (x.chain = { id: 84532, identity: "nope", anchor: ANCHOR }),
      (x) => (x.range = { fromBlock: 300, toBlock: 200 }),
      (x) => (x.range = { fromBlock: -1, toBlock: 200 }),
      (x) => (x.agents = "all"),
      (x) => (x.agents = [{ agentId: "2" }]),
      (x) => (x.agents = [{ agentId: 2 }, { agentId: 2 }]),
      (x) => (x.agents = [{ agentId: 2, operator: "0x12" }]),
      (x) => (x.outcomes = { 0: outcome(2, true) }),
      (x) => (x.outcomes = [{ ...outcome(2, true), success: "true" }]),
      (x) => (x.outcomes = [{ ...outcome(2, true), costMicros: 120000 }]),
      (x) => (x.outcomes = [{ ...outcome(2, true), costMicros: "-1" }]),
      (x) => (x.outcomes = [{ ...outcome(2, true), taskId: "<script>" }]),
      (x) => (x.outcomes = [{ ...outcome(2, true), agentId: 1.5 }]),
      (x) => (x.outcomes = [outcome(2, true, 99)]),
      (x) => (x.counts = [{ agentId: 2, auditedStaked: 1, verifiedStaked: 2 }]),
      (x) => (x.counts = [{ agentId: 2, auditedStaked: "1", verifiedStaked: 0 }]),
    ];
    for (const edit of bad) expect(() => parseSnapshot(JSON.stringify(snapshot(edit))), String(edit)).toThrow();
  });

  it("refuses arrays larger than any real run before reading their items", () => {
    expect(() =>
      parseSnapshot(JSON.stringify(snapshot((x) => (x.outcomes = Array.from({ length: 20_001 }, () => 0))))),
    ).toThrow(/too many/i);
    expect(() =>
      parseSnapshot(JSON.stringify(snapshot((x) => (x.agents = Array.from({ length: 1_001 }, () => 0))))),
    ).toThrow(/too many/i);
    expect(() => parseSnapshot(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(/too large/i);
  });

  it("does not read through __proto__ and does not pollute Object.prototype", () => {
    const text = FILE.replace('"agentId": 2,', '"agentId": 2, "__proto__": {"agentId": 99, "polluted": true},');
    expect(parseSnapshot(text).agents[0]?.agentId).toBe(2);
    expect(() => parseSnapshot('{"__proto__":{"v":0,"kind":"mergit-ledger-snapshot"}}')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("loadLedger", () => {
  const clients = (
    text: string | null | Error,
    file: string | Error = FILE,
  ): LedgerClients & { calls: unknown[]; fetched: () => number } => {
    const calls: unknown[] = [];
    return {
      calls,
      fetched: () => calls.filter((x) => typeof x === "string").length,
      getEnsText: vi.fn((args) => {
        calls.push(args);
        return text instanceof Error ? Promise.reject(text) : Promise.resolve(text);
      }),
      fetchText: vi.fn((url: string) => {
        calls.push(url);
        return file instanceof Error ? Promise.reject(file) : Promise.resolve(file);
      }),
    };
  };

  it("verifies a published ledger: the file's hash matches and it agrees with the record", async () => {
    const c = clients(record(FILE));
    const state = await loadLedger(c, CFG);
    expect(state.status).toBe("ok");
    if (state.status !== "ok") return;
    expect(state.verified).toBe(true);
    expect(state.hash).toBe(keccak256(toBytes(FILE)));
    expect(state.summary.totals.outcomes).toBe(3);
    expect(c.calls).toEqual([
      { name: "mergit.eth", key: LEDGER_KEY, universalResolverAddress: RESOLVER },
      "https://mergit.site/ledger/final-200.json",
    ]);
    expect(LEDGER_KEY).toBe("mergit.ledger");
  });

  it("matches a hash written in upper case", async () => {
    const upper = `0x${keccak256(toBytes(FILE)).slice(2).toUpperCase()}`;
    expect((await loadLedger(clients(record(FILE, (x) => (x.hash = upper))), CFG)).status).toBe("ok");
  });

  it("hashes the UTF-8 bytes of the text, not its characters", async () => {
    const file = JSON.stringify(snapshot((x) => (x.note = "é ✓ 💡")));
    expect((await loadLedger(clients(record(file), file), CFG)).status).toBe("ok");
  });

  it("is absent when the record is not set", async () => {
    expect(await loadLedger(clients(null), CFG)).toEqual({ status: "absent" });
    expect(await loadLedger(clients(""), CFG)).toEqual({ status: "absent" });
  });

  it("is unavailable when the record could not be read, and fetches nothing", async () => {
    const c = clients(new Error("rpc down"));
    expect(await loadLedger(c, CFG)).toEqual({ status: "unavailable" });
    expect(c.fetched()).toBe(0);
  });

  it("is malformed when the record is not one the publisher wrote, and fetches nothing", async () => {
    const c = clients(record(FILE, (x) => (x.chainId = 1)));
    const state = await loadLedger(c, CFG);
    expect(state).toMatchObject({ status: "malformed", where: "record" });
    expect(c.fetched()).toBe(0);
  });

  it("is unreachable when the file could not be fetched, whatever was thrown", async () => {
    expect(
      await loadLedger(clients(record(FILE), new Error("The ledger file could not be fetched (404).")), CFG),
    ).toMatchObject({
      status: "unreachable",
      detail: "The ledger file could not be fetched (404).",
    });
    const odd: LedgerClients = {
      getEnsText: () => Promise.resolve(record(FILE)),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is a rejection that is not an Error
      fetchText: () => Promise.reject("a string, not an Error"),
    };
    expect((await loadLedger(odd, CFG)).status).toBe("unreachable");
  });

  it("is a hash mismatch when the file was changed after it was committed", async () => {
    const tampered = FILE.replace('"success": false', '"success": true');
    expect(tampered).not.toBe(FILE);
    const state = await loadLedger(clients(record(FILE), tampered), CFG);
    expect(state).toMatchObject({
      status: "mismatch",
      field: "hash",
      expected: keccak256(toBytes(FILE)),
      actual: keccak256(toBytes(tampered)),
    });
  });

  it("is a mismatch when the committed file names another chain, anchor, identity or range than the record", async () => {
    const cases: [string, (x: Record<string, unknown>) => void][] = [
      ["chain", (x) => (x.chain = { id: 1, identity: IDENTITY, anchor: ANCHOR })],
      ["anchor", (x) => (x.chain = { id: 84532, identity: IDENTITY, anchor: IDENTITY })],
      ["identity", (x) => (x.chain = { id: 84532, identity: ANCHOR, anchor: ANCHOR })],
      ["range", (x) => (x.range = { fromBlock: 100, toBlock: 250 })],
      ["outcomes", (x) => (x.outcomes = [outcome(2, true)])],
      ["agents", (x) => (x.agents = [{ agentId: 2, operator: OPERATOR, ensName: null }])],
    ];
    for (const [field, edit] of cases) {
      // The record commits to this very file (the hash matches), so only the cross-check can catch it.
      const file = JSON.stringify(snapshot(edit));
      const state = await loadLedger(clients(record(file), file), CFG);
      expect(state, field).toMatchObject({ status: "mismatch", field });
    }
  });

  it("is malformed when the committed file is not a valid snapshot", async () => {
    const file = '{"v":0,"kind":"something else"}';
    expect(await loadLedger(clients(record(file), file), CFG)).toMatchObject({ status: "malformed", where: "file" });
    const huge = JSON.stringify(snapshot((x) => (x.outcomes = Array.from({ length: 20_001 }, () => 0))));
    expect(await loadLedger(clients(record(huge), huge), CFG)).toMatchObject({ status: "malformed", where: "file" });
  });

  it("never throws for a client that misbehaves", async () => {
    const weird: LedgerClients = {
      getEnsText: () => Promise.resolve(42 as unknown as string),
      fetchText: () => Promise.resolve(42 as unknown as string),
    };
    expect((await loadLedger(weird, CFG)).status).toBe("malformed");
    const throwsSync: LedgerClients = {
      getEnsText: () => {
        throw new Error("sync");
      },
      fetchText: () => Promise.resolve(FILE),
    };
    expect(await loadLedger(throwsSync, CFG)).toEqual({ status: "unavailable" });
  });
});
