import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { categoryLabel, foldOutcomes, type Outcome } from "./reputation-mirror.ts";
import { ensNameOf } from "./registration.ts";

export type SnapshotAgent = { agentId: number; operator: Address; metadataUri: string; /** The agent's ENS label, if it has an ENS name. */ label: string | null };
export type SnapshotInput = {
  chain: { id: number; identity: Address; anchor: Address };
  range: { fromBlock: bigint; toBlock: bigint };
  agents: SnapshotAgent[];
  /** Every `OutcomeRecorded` event in the range, tier 1 included. */
  outcomes: Outcome[];
  knownCategories: string[];
  createdAt: string;
  /** The gateway's receipt commitments, included verbatim when given. */
  commitments?: unknown;
  /** The platform terms in force, included verbatim when given. */
  terms?: unknown;
};

const DEFAULT_NOTE = "Final ledger snapshot of Base Sepolia outcomes. The hash binds the file; the chain is the source of truth.";
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The final ledger as one file: agents, every recorded outcome with its metered cost, the tier 0 counts (a task counts
 * once, the ruling wins) and optionally the receipt commitments and the platform terms. Compact JSON plus a newline, with
 * everything sorted, so the same ledger is always the same bytes and the hash is reproducible.
 */
export function buildSnapshot(input: SnapshotInput): string {
  const known = input.knownCategories;
  const label = (c: Hex) => { const l = categoryLabel(c, known); return l === c.toLowerCase() ? null : l; };
  const outcomes = [...input.outcomes].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const counts = [...foldOutcomes(input.outcomes)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([agentId, c]) => ({
    agentId: Number(agentId), auditedStaked: c.auditedStaked, verifiedStaked: c.verifiedStaked,
    byCategory: Object.fromEntries([...c.byCategory].map(([cat, s]) => [categoryLabel(cat, known), s] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }));
  const file: Record<string, unknown> = {
    v: 0, kind: "mergit-ledger-snapshot", createdAt: input.createdAt,
    chain: { id: input.chain.id, identity: input.chain.identity, anchor: input.chain.anchor },
    range: { fromBlock: Number(input.range.fromBlock), toBlock: Number(input.range.toBlock) },
    agents: [...input.agents].sort((a, b) => a.agentId - b.agentId).map((a) => ({
      agentId: a.agentId, operator: a.operator, metadataUri: a.metadataUri, ensName: a.label ? ensNameOf(a.label) : null,
    })),
    outcomes: outcomes.map((o) => ({
      taskId: o.taskId, agentId: Number(o.agentId), category: o.category, categoryLabel: label(o.category), success: o.success,
      costMicros: o.costMicros.toString(), tier: o.tier, source: o.source, blockNumber: Number(o.blockNumber), logIndex: o.logIndex,
    })),
    counts,
  };
  if (input.commitments !== undefined) file.commitments = input.commitments;
  if (input.terms !== undefined) file.terms = input.terms;
  return JSON.stringify(file) + "\n";
}

/** keccak256 of the file's exact bytes: what a reader recomputes after downloading it. */
export const snapshotHash = (text: string): Hex => keccak256(stringToBytes(text));

/**
 * The `mergit.ledger` ENS record (on `mergit.eth`): a small, fixed-order JSON that points at the snapshot file and commits to
 * it by hash, so a few hundred bytes on Ethereum mainnet bind the whole ledger.
 */
export function ledgerRecord(m: { chainId: number; anchor: Address; identity: Address; fromBlock: bigint; toBlock: bigint; outcomes: number; agents: number; hash: Hex; uri: string; note?: string }): string {
  let url: URL | undefined;
  try { url = new URL(m.uri); } catch { /* refused below */ }
  if (!url || url.protocol !== "https:" || /\s/.test(m.uri) || m.uri.length > 300) throw new Error("ledger record: uri must be an https URL of at most 300 characters without spaces");
  if (!HASH.test(m.hash)) throw new Error("ledger record: hash must be 0x followed by 64 hex characters");
  const note = m.note ?? DEFAULT_NOTE;
  if (note.length > 500) throw new Error("ledger record: note is at most 500 characters");
  return JSON.stringify({
    v: 0, kind: "ledger-snapshot", chainId: m.chainId, anchor: m.anchor, identity: m.identity, fromBlock: Number(m.fromBlock), toBlock: Number(m.toBlock),
    outcomes: m.outcomes, agents: m.agents, hash: m.hash, uri: m.uri, note,
  });
}

/** Validates a `mergit.ledger` record text before it is sent to mainnet: exactly the shape `ledgerRecord` writes. Throws "ledger record: ...". */
export function checkLedgerRecord(raw: string): void {
  const bad = (m: string): never => { throw new Error(`ledger record: ${m}`); };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) bad("is empty or too large");
  let r: unknown;
  try { r = JSON.parse(raw); } catch { return bad("is not JSON"); }
  if (typeof r !== "object" || r === null || Array.isArray(r)) bad("is not a JSON object");
  const o = r as Record<string, unknown>;
  if (o.v !== 0) bad("has an unknown version");
  if (o.kind !== "ledger-snapshot") bad("is not a ledger snapshot record");
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  for (const k of ["chainId", "fromBlock", "toBlock", "outcomes", "agents"]) if (!int(o[k])) bad(`${k} is not a whole number`);
  for (const k of ["anchor", "identity"]) if (typeof o[k] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o[k] as string)) bad(`${k} is not an address`);
  if (typeof o.hash !== "string" || !HASH.test(o.hash)) bad("hash must be 0x followed by 64 hex characters");
  if (typeof o.uri !== "string") bad("uri is missing");
  try { const u = new URL(o.uri as string); if (u.protocol !== "https:") bad("uri must be an https URL"); } catch (e) { if ((e as Error).message.startsWith("ledger record")) throw e; bad("uri must be an https URL"); }
  if (typeof o.note !== "string" || o.note.length > 500) bad("note is missing or too long");
}
