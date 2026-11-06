import { getAddress, isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { PARENT_NAME } from "./names.ts";

/** The ENS text record on `mergit.eth` that commits to the final ledger snapshot. */
export const LEDGER_KEY = "mergit.ledger";

/** The `mergit.ledger` record: a pointer to a snapshot file and the keccak256 of its exact bytes. */
export type LedgerRecord = {
  chainId: number;
  anchor: Address;
  identity: Address;
  fromBlock: number;
  toBlock: number;
  outcomes: number;
  agents: number;
  /** Lower-case 0x and 64 hex digits. */
  hash: Hex;
  /** An https URL (normalised). */
  uri: string;
  note: string;
};

export type SnapshotAgent = {
  agentId: number;
  operator: Address | null;
  /** A `<label>.mergit.eth` name, or null when the file gives none or one that is not a Mergit name. */
  ensName: string | null;
  outcomes: number;
  successes: number;
  auditedStaked: number;
  verifiedStaked: number;
};

export type SnapshotOutcome = {
  taskId: string;
  agentId: number;
  category: string;
  categoryLabel: string | null;
  success: boolean;
  costMicros: string;
  tier: number;
  source: number;
  blockNumber: number;
};

/** What the page shows of a snapshot file: totals and per-agent counts, never the whole outcome list. */
export type SnapshotSummary = {
  createdAt: string | null;
  chainId: number;
  identity: Address;
  anchor: Address;
  fromBlock: number;
  toBlock: number;
  agents: SnapshotAgent[];
  totals: { agents: number; outcomes: number; successes: number; auditedStaked: number; verifiedStaked: number };
  outcomeCount: number;
  /** The first outcomes in the file, at most FIRST_OUTCOMES of them. */
  firstOutcomes: SnapshotOutcome[];
  commitmentCount: number;
};

export type MismatchField = "hash" | "chain" | "anchor" | "identity" | "range" | "outcomes" | "agents";

export type LedgerState =
  | { status: "absent" }
  /** The record could not be read (the RPC failed). */
  | { status: "unavailable" }
  | { status: "malformed"; where: "record"; detail: string }
  /** The file matched its hash but is not a valid snapshot. */
  | { status: "malformed"; where: "file"; detail: string; record: LedgerRecord }
  | { status: "unreachable"; detail: string; record: LedgerRecord }
  | { status: "mismatch"; field: MismatchField; expected: string; actual: string; record: LedgerRecord }
  | { status: "ok"; record: LedgerRecord; summary: SnapshotSummary; hash: Hex; verified: true };

export type LedgerClients = {
  /** Ethereum mainnet, through the Universal Resolver at `universalResolverAddress`. */
  getEnsText(args: { name: string; key: string; universalResolverAddress: Address }): Promise<string | null>;
  /** Fetches text from an https URL with the guards of safeFetch; rejects on any failure. */
  fetchText(url: string): Promise<string>;
};

export type LedgerConfig = { universalResolver: Address; chainId: number; anchor: Address };

const MAX_RECORD_CHARS = 8_000;
const MAX_URI_CHARS = 2_048;
const MAX_NOTE_CHARS = 500;
const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MAX_AGENTS = 1_000;
const MAX_OUTCOMES = 20_000;
const MAX_COMMITMENTS = 100_000;
export const FIRST_OUTCOMES = 50;

const own = (o: object, key: string): unknown =>
  Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const HEX_ID = /^0x[0-9a-fA-F]{1,64}$/;
const MERGIT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mergit\.eth$/;

function address(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${what} is not an address.`);
  return getAddress(v);
}

function count(o: object, key: string, what: string): number {
  const v = own(o, key);
  if (!isCount(v)) throw new Error(`${what} ${key} is not a whole number.`);
  return v;
}

function jsonObject(raw: string, what: string): object {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not JSON.`);
  }
  if (!isObject(body)) throw new Error(`${what} is not a JSON object.`);
  return body;
}

function httpsUri(v: unknown): string {
  if (typeof v !== "string" || v.length > MAX_URI_CHARS)
    throw new Error("The ledger record's address is not an https URL.");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("The ledger record's address is not an https URL.");
  }
  if (u.protocol !== "https:" || u.hostname === "" || u.username !== "" || u.password !== "")
    throw new Error("The ledger record's address is not an https URL.");
  return u.href;
}

/**
 * Reads the `mergit.ledger` text record. Strict: a record that is not exactly what the publisher writes, or that names
 * another chain or ReputationAnchor than this app trusts, throws and is never shown. Unknown extra fields are ignored.
 */
export function parseLedgerRecord(raw: string, expected: { chainId: number; anchor: Address }): LedgerRecord {
  const what = "The ledger record";
  if (typeof raw !== "string") throw new Error(`${what} is not text.`);
  if (raw.length > MAX_RECORD_CHARS) throw new Error(`${what} is too large to be one the publisher wrote.`);
  const body = jsonObject(raw, what);
  if (own(body, "v") !== 0) throw new Error(`${what} has an unknown version.`);
  if (own(body, "kind") !== "ledger-snapshot") throw new Error(`${what} is not a ledger snapshot record.`);
  if (own(body, "chainId") !== expected.chainId) throw new Error(`${what} is for another chain than this app's.`);
  const anchor = own(body, "anchor");
  if (typeof anchor !== "string" || !sameAddress(anchor, expected.anchor))
    throw new Error(`${what} names another ReputationAnchor than the one this app trusts.`);

  const fromBlock = count(body, "fromBlock", what);
  const toBlock = count(body, "toBlock", what);
  if (fromBlock > toBlock) throw new Error(`${what}'s block range runs backwards.`);
  const hash = own(body, "hash");
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`${what}'s hash is not valid.`);
  const note = own(body, "note");

  return {
    chainId: expected.chainId,
    anchor: getAddress(expected.anchor),
    identity: address(own(body, "identity"), `${what}'s identity`),
    fromBlock,
    toBlock,
    outcomes: count(body, "outcomes", what),
    agents: count(body, "agents", what),
    hash: hash.toLowerCase() as Hex,
    uri: httpsUri(own(body, "uri")),
    note: typeof note === "string" ? note.slice(0, MAX_NOTE_CHARS) : "",
  };
}

function array(o: object, key: string, max: number, required: boolean): unknown[] {
  const v = own(o, key);
  if (v === undefined && !required) return [];
  if (!Array.isArray(v)) throw new Error(`The ledger file's ${key} is not a list.`);
  if (v.length > max) throw new Error(`The ledger file has too many ${key}.`);
  return v;
}

function parseOutcome(o: unknown, range: { fromBlock: number; toBlock: number }): SnapshotOutcome {
  const what = "An outcome in the ledger file:";
  if (!isObject(o)) throw new Error(`${what} it is not an object.`);
  const taskId = own(o, "taskId");
  const category = own(o, "category");
  const label = own(o, "categoryLabel");
  const success = own(o, "success");
  const costMicros = own(o, "costMicros");
  if (typeof taskId !== "string" || !HEX_ID.test(taskId)) throw new Error(`${what} the task id is not valid.`);
  if (typeof category !== "string" || !HEX_ID.test(category)) throw new Error(`${what} the category is not valid.`);
  if (typeof success !== "boolean") throw new Error(`${what} success is not true or false.`);
  if (typeof costMicros !== "string" || !/^\d{1,30}$/.test(costMicros))
    throw new Error(`${what} the cost is not a whole number.`);
  const blockNumber = count(o, "blockNumber", what);
  if (blockNumber < range.fromBlock || blockNumber > range.toBlock)
    throw new Error(`${what} its block is outside the snapshot's range.`);
  return {
    taskId,
    agentId: count(o, "agentId", what),
    category,
    categoryLabel: typeof label === "string" && label.length > 0 && label.length <= 80 ? label : null,
    success,
    costMicros,
    tier: count(o, "tier", what),
    source: count(o, "source", what),
    blockNumber,
  };
}

/**
 * Reads a final ledger snapshot file defensively: arrays are capped before their items are read, every field it uses
 * is type-checked, and anything it does not use (gateway commitments, terms, unknown fields) is ignored. Throws a plain
 * sentence on anything it cannot trust.
 */
export function parseSnapshot(text: string): SnapshotSummary {
  const what = "The ledger file";
  if (typeof text !== "string") throw new Error(`${what} is not text.`);
  if (text.length > MAX_FILE_CHARS) throw new Error(`${what} is too large.`);
  const body = jsonObject(text, what);
  if (own(body, "v") !== 0) throw new Error(`${what} has an unknown version.`);
  if (own(body, "kind") !== "mergit-ledger-snapshot") throw new Error(`${what} is not a Mergit ledger snapshot.`);

  const chain = own(body, "chain");
  if (!isObject(chain)) throw new Error(`${what} does not say which chain it is from.`);
  const chainId = count(chain, "id", `${what}'s chain`);
  const identity = address(own(chain, "identity"), `${what}'s identity`);
  const anchor = address(own(chain, "anchor"), `${what}'s anchor`);
  const range = own(body, "range");
  if (!isObject(range)) throw new Error(`${what} has no block range.`);
  const fromBlock = count(range, "fromBlock", `${what}'s range`);
  const toBlock = count(range, "toBlock", `${what}'s range`);
  if (fromBlock > toBlock) throw new Error(`${what}'s block range runs backwards.`);

  const rawAgents = array(body, "agents", MAX_AGENTS, true);
  const rawOutcomes = array(body, "outcomes", MAX_OUTCOMES, true);
  const rawCounts = array(body, "counts", MAX_AGENTS, false);
  const commitments = own(body, "commitments");
  const commitmentCount = Array.isArray(commitments) ? Math.min(commitments.length, MAX_COMMITMENTS) : 0;

  const agents = new Map<number, SnapshotAgent>();
  const entry = (agentId: number): SnapshotAgent => {
    let a = agents.get(agentId);
    if (!a) {
      a = { agentId, operator: null, ensName: null, outcomes: 0, successes: 0, auditedStaked: 0, verifiedStaked: 0 };
      agents.set(agentId, a);
    }
    return a;
  };

  for (const a of rawAgents) {
    if (!isObject(a)) throw new Error(`An agent in ${what.toLowerCase()} is not an object.`);
    const agentId = count(a, "agentId", "An agent's");
    if (agents.has(agentId)) throw new Error(`${what} lists agent ${String(agentId)} twice.`);
    const operator = own(a, "operator");
    const ensName = own(a, "ensName");
    const listed = entry(agentId);
    listed.operator = operator === undefined || operator === null ? null : address(operator, "An agent's operator");
    listed.ensName = typeof ensName === "string" && MERGIT_NAME.test(ensName) ? ensName : null;
  }
  const listedAgents = agents.size;

  const firstOutcomes: SnapshotOutcome[] = [];
  let successes = 0;
  for (const raw of rawOutcomes) {
    const o = parseOutcome(raw, { fromBlock, toBlock });
    const a = entry(o.agentId);
    a.outcomes += 1;
    if (o.success) {
      a.successes += 1;
      successes += 1;
    }
    if (firstOutcomes.length < FIRST_OUTCOMES) firstOutcomes.push(o);
  }

  const counted = new Set<number>();
  let auditedStaked = 0;
  let verifiedStaked = 0;
  for (const c of rawCounts) {
    if (!isObject(c)) throw new Error(`A count in ${what.toLowerCase()} is not an object.`);
    const agentId = count(c, "agentId", "A count's");
    if (counted.has(agentId)) throw new Error(`${what} counts agent ${String(agentId)} twice.`);
    counted.add(agentId);
    const audited = count(c, "auditedStaked", "A count's");
    const verified = count(c, "verifiedStaked", "A count's");
    if (verified > audited) throw new Error(`${what} has more verified than audited outcomes for an agent.`);
    const a = entry(agentId);
    a.auditedStaked = audited;
    a.verifiedStaked = verified;
    auditedStaked += audited;
    verifiedStaked += verified;
  }

  const createdAt = own(body, "createdAt");
  return {
    createdAt: typeof createdAt === "string" && createdAt.length > 0 && createdAt.length <= 64 ? createdAt : null,
    chainId,
    identity,
    anchor,
    fromBlock,
    toBlock,
    agents: [...agents.values()].sort((a, b) => a.agentId - b.agentId),
    totals: { agents: listedAgents, outcomes: rawOutcomes.length, successes, auditedStaked, verifiedStaked },
    outcomeCount: rawOutcomes.length,
    firstOutcomes,
    commitmentCount,
  };
}

const message = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message.length > 0 ? e.message.slice(0, 300) : fallback;

/** The first place where a committed file disagrees with the record that commits to it, or null. */
function disagreement(
  r: LedgerRecord,
  s: SnapshotSummary,
): { field: MismatchField; expected: string; actual: string } | null {
  const checks: [MismatchField, string, string][] = [
    ["chain", String(r.chainId), String(s.chainId)],
    ["anchor", r.anchor.toLowerCase(), s.anchor.toLowerCase()],
    ["identity", r.identity.toLowerCase(), s.identity.toLowerCase()],
    ["range", `${String(r.fromBlock)}-${String(r.toBlock)}`, `${String(s.fromBlock)}-${String(s.toBlock)}`],
    ["outcomes", String(r.outcomes), String(s.totals.outcomes)],
    ["agents", String(r.agents), String(s.totals.agents)],
  ];
  const found = checks.find(([, expected, actual]) => expected !== actual);
  return found ? { field: found[0], expected: found[1], actual: found[2] } : null;
}

/**
 * Reads `mergit.ledger` on `mergit.eth`, fetches the file it points at, and checks that the keccak256 of the file's
 * UTF-8 bytes is the committed hash and that the file agrees with the record. Never throws: every expected failure is
 * a state. Display data only (HLD E11).
 */
export async function loadLedger(c: LedgerClients, cfg: LedgerConfig): Promise<LedgerState> {
  let raw: string | null;
  try {
    raw = await c.getEnsText({ name: PARENT_NAME, key: LEDGER_KEY, universalResolverAddress: cfg.universalResolver });
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null || raw === "") return { status: "absent" };

  let record: LedgerRecord;
  try {
    record = parseLedgerRecord(raw, { chainId: cfg.chainId, anchor: cfg.anchor });
  } catch (e) {
    return { status: "malformed", where: "record", detail: message(e, "The ledger record is not valid.") };
  }

  let text: string;
  try {
    text = await c.fetchText(record.uri);
  } catch (e) {
    return { status: "unreachable", detail: message(e, "The ledger file could not be fetched."), record };
  }
  if (typeof text !== "string") return { status: "unreachable", detail: "The ledger file could not be read.", record };

  const hash = keccak256(toBytes(text));
  if (hash.toLowerCase() !== record.hash)
    return { status: "mismatch", field: "hash", expected: record.hash, actual: hash, record };

  let summary: SnapshotSummary;
  try {
    summary = parseSnapshot(text);
  } catch (e) {
    return { status: "malformed", where: "file", detail: message(e, "The ledger file is not valid."), record };
  }
  const differs = disagreement(record, summary);
  if (differs) return { status: "mismatch", ...differs, record };
  return { status: "ok", record, summary, hash, verified: true };
}
