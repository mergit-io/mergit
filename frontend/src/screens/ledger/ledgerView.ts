import type { LedgerRecord, LedgerState, MismatchField } from "../../chain/ens/ledger.ts";
import { plainText } from "../agent/profileView";

export const NO_LEDGER = "No final ledger has been published yet.";
export const LEDGER_COMMITMENT = "Committed on Ethereum mainnet in the ENS record mergit.ledger of mergit.eth.";

type Row = { label: string; value: string };

export type LedgerAgentRow = {
  agentId: string;
  name: string;
  outcomes: string;
  passed: string;
  audited: string;
  verified: string;
  operator: string | null;
};

/** Display-ready strings for the ledger page. Everything is shown as text; the only link is the https file URL. */
export type LedgerView = {
  title: string;
  verdict: { tone: "ok" | "bad" | "warn" | "none"; text: string };
  sentences: string[];
  /** Present once a record was read; null while there is none. */
  commitment: string | null;
  /** The hash check, when the file was fetched: null when it never was. */
  hashCheck: { matches: boolean; sentence: string; committed: string; computed: string } | null;
  record: Row[];
  note: string[];
  fileUrl: string | null;
  range: string | null;
  createdAt: string | null;
  totals: Row[];
  agents: LedgerAgentRow[];
};

const DETAIL_MAX = 120;
const FIELD: Record<Exclude<MismatchField, "hash">, string> = {
  chain: "chain",
  anchor: "ReputationAnchor",
  identity: "Identity registry",
  range: "block range",
  outcomes: "number of outcomes",
  agents: "number of agents",
};

const quoted = (detail: string): string => {
  const line = plainText(detail, { singleLine: true }).replace(/\s+/g, " ").trim();
  return `"${line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line}"`;
};

const httpsOnly = (url: string): string | null => (url.startsWith("https://") ? url : null);

const MATCHES = "The snapshot file matches the hash committed on ENS.";

function recordRows(r: LedgerRecord): Row[] {
  return [
    { label: "Chain id", value: String(r.chainId) },
    { label: "ReputationAnchor", value: r.anchor },
    { label: "Identity registry", value: r.identity },
    { label: "Blocks", value: `${String(r.fromBlock)} to ${String(r.toBlock)}` },
    { label: "Outcomes", value: String(r.outcomes) },
    { label: "Agents", value: String(r.agents) },
    { label: "Hash (keccak256)", value: r.hash },
    { label: "File", value: r.uri },
  ];
}

const empty = (title: string, tone: LedgerView["verdict"]["tone"], text: string, sentences: string[]): LedgerView => ({
  title,
  verdict: { tone, text },
  sentences,
  commitment: null,
  hashCheck: null,
  record: [],
  note: [],
  fileUrl: null,
  range: null,
  createdAt: null,
  totals: [],
  agents: [],
});

/** What the ledger page says for each state of `loadLedger`. */
export function ledgerView(state: LedgerState, ctx: { chainName: string }): LedgerView {
  if (state.status === "absent")
    return empty(NO_LEDGER, "none", "Nothing to check yet.", [
      "When the run ends, the final ledger is published as a file and committed to in the ENS record mergit.ledger of mergit.eth.",
    ]);
  if (state.status === "unavailable")
    return empty("Final ledger", "warn", "Could not read the ENS record mergit.ledger from Ethereum.", [
      "Try again in a moment.",
    ]);
  if (state.status === "malformed" && state.where === "record")
    return empty("Final ledger", "bad", "The ENS record mergit.ledger is not shown because it is not valid.", [
      quoted(state.detail),
    ]);

  const record = state.record;
  const base = {
    title: "Final ledger",
    commitment: LEDGER_COMMITMENT,
    record: recordRows(record),
    note: record.note === "" ? [] : plainText(record.note).split("\n"),
    fileUrl: httpsOnly(record.uri),
    range: `${ctx.chainName} blocks ${String(record.fromBlock)} to ${String(record.toBlock)}`,
    createdAt: null,
    totals: [],
    agents: [],
  };

  switch (state.status) {
    case "unreachable":
      return {
        ...base,
        verdict: { tone: "warn", text: "The snapshot file could not be fetched, so its hash was not checked." },
        sentences: [quoted(state.detail)],
        hashCheck: null,
      };
    case "malformed":
      return {
        ...base,
        verdict: { tone: "bad", text: "The snapshot file is not a valid Mergit ledger snapshot, so it is not shown." },
        sentences: [quoted(state.detail)],
        hashCheck: { matches: true, sentence: MATCHES, committed: record.hash, computed: record.hash },
      };
    case "mismatch":
      if (state.field === "hash")
        return {
          ...base,
          verdict: { tone: "bad", text: "The snapshot file does not match the hash committed on ENS." },
          sentences: ["It may have been changed after it was published, so nothing from it is shown."],
          hashCheck: {
            matches: false,
            sentence: "The snapshot file does not match the hash committed on ENS.",
            committed: state.expected,
            computed: state.actual,
          },
        };
      return {
        ...base,
        verdict: { tone: "bad", text: `The snapshot file's ${FIELD[state.field]} does not agree with the ENS record.` },
        sentences: [
          `The record says ${state.expected}; the file says ${state.actual}. Nothing from the file is shown.`,
        ],
        hashCheck: { matches: true, sentence: MATCHES, committed: record.hash, computed: record.hash },
      };
    case "ok": {
      const s = state.summary;
      return {
        ...base,
        verdict: { tone: "ok", text: MATCHES },
        sentences: ["The file agrees with the record on the chain, the contracts, the block range and the counts."],
        hashCheck: { matches: true, sentence: MATCHES, committed: record.hash, computed: state.hash },
        createdAt: s.createdAt === null ? null : plainText(s.createdAt, { singleLine: true }),
        totals: [
          { label: "Agents", value: String(s.totals.agents) },
          { label: "Outcomes", value: String(s.totals.outcomes) },
          { label: "Passed", value: String(s.totals.successes) },
          { label: "Audited (staked)", value: String(s.totals.auditedStaked) },
          { label: "Verified (staked)", value: String(s.totals.verifiedStaked) },
          { label: "Gateway commitments", value: String(s.commitmentCount) },
        ],
        agents: s.agents.map((a) => ({
          agentId: String(a.agentId),
          name: a.ensName ?? `Agent #${String(a.agentId)}`,
          outcomes: String(a.outcomes),
          passed: String(a.successes),
          audited: String(a.auditedStaked),
          verified: String(a.verifiedStaked),
          operator: a.operator,
        })),
      };
    }
  }
}
