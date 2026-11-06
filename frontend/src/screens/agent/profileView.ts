import type { AgentInfo } from "../../api/types";
import type { AgentEns } from "../../chain/ens/agentEns.ts";
import { failureText } from "../../chain/ens/identityView.ts";
import { labelForAgent } from "../../chain/ens/names.ts";

/** Everything the profile page shows, as display-ready strings that are already cleaned and capped. */
export type ProfileView = {
  title: string;
  verification: { badge: AgentEns["badge"]; sentences: string[] };
  /** `context` is the agent's description as plain lines of text; `endpoint` is the https link the reader allowed, or null. */
  records: { context: string[]; endpoint: string | null };
  operator: { onBase: string | null; onEns: string | null; sentence: string };
  registry: { identity: string; agentId: string };
  /** The owner and resolver of the parent name on Ethereum. */
  parent: { owner: string | null; resolver: string | null };
  mirror: { sentence: string; rows: { category: string; audited: number; verified: number }[]; note: string };
};

const CONTEXT_MAX = 2_000;
const DETAIL_MAX = 120;

/** True for a character that must never reach the page from chain text: controls, zero-width and bidi overrides. */
function hidden(code: number, keepNewline: boolean): boolean {
  if (code === 0x0a) return !keepNewline;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/**
 * Text from a chain record or a fetched file, made safe to show as a text node: control, zero-width and bidi-override
 * characters are dropped (newlines are kept unless `singleLine`, which turns them into spaces). It is still only ever
 * rendered as text, never as markup.
 */
export function plainText(raw: string, opts: { singleLine?: boolean } = {}): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (opts.singleLine && code === 0x0a) out += " ";
    else if (!hidden(code, true)) out += ch;
  }
  return out;
}

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A reader's detail string as a short quoted fragment on one line. */
const quoted = (detail: string): string =>
  `"${cap(plainText(detail, { singleLine: true }).replace(/\s+/g, " ").trim(), DETAIL_MAX)}"`;

/** `0x1234…abcd`. */
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** An explorer page for an address, or null if there is no explorer or the value is not a plain 20-byte hex address. */
export function explorerAddressUrl(explorer: string | undefined, address: string): string | null {
  return explorer && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${explorer}/address/${address}` : null;
}

/**
 * The reader's endpoint, unchanged, or null. The reader already allows only plain https URLs; one that still holds an
 * invisible or bidi-override character (which could make the link read as a different address) is not shown at all.
 */
const endpointOf = (url: string | null): string | null =>
  url !== null && plainText(url, { singleLine: true }) === url ? url : null;

function contextLines(raw: string | null): string[] {
  if (!raw) return [];
  const text = plainText(raw);
  const capped = text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
  return capped
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

const BOTH_WAYS = "The ENS name and the agent's registry entry on Base point at each other (the two-way check passed).";

function sentences(ens: AgentEns): string[] {
  if (ens.verification.status === "failed") {
    return [
      failureText(ens.verification.reason),
      `The reader said: ${quoted(ens.verification.detail)}`,
      "Without the two-way check, nothing on this page is confirmed by ENS.",
    ];
  }
  switch (ens.badge) {
    case "verified":
      return [BOTH_WAYS, "The operator recorded on ENS is still the operator on Base."];
    case "owner-changed":
      return [
        BOTH_WAYS,
        "But the agent was sold since its ENS records were last updated: the operator on Base is not the one recorded on ENS.",
      ];
    default:
      return [
        BOTH_WAYS,
        "But the owner record is not on ENS yet, so a change of owner since then cannot be ruled out.",
      ];
  }
}

function operatorSentence(op: AgentEns["operator"]): string {
  if (op.state === "current") return "The operator on Base is the one recorded on ENS.";
  if (op.state === "changed")
    return "The operator on Base is not the one recorded on ENS: the agent changed hands after its ENS records were last updated.";
  if (op.onBase === null) return "The operator on Base could not be read this time.";
  return "The operator is not recorded on ENS yet.";
}

function mirrorView(m: AgentEns["mirror"]): ProfileView["mirror"] {
  switch (m.status) {
    case "ok":
      return {
        sentence: `Mirror of audited, staked outcomes read from Base at block ${String(m.mirror.asOfBlock)}, not a score.`,
        rows: m.mirror.byCategory.map((c) => ({
          category: plainText(c.category, { singleLine: true }),
          audited: c.auditedStaked,
          verified: c.verifiedStaked,
        })),
        note: plainText(m.mirror.note, { singleLine: true }),
      };
    case "absent":
      return {
        sentence: "No on-chain record yet: no mirror of audited, staked outcomes has been published for this agent.",
        rows: [],
        note: "",
      };
    case "malformed":
      return {
        sentence: "The on-chain mirror on ENS is not shown because it is not valid.",
        rows: [],
        note: "",
      };
    case "unavailable":
      return { sentence: "The on-chain mirror could not be read this time.", rows: [], note: "" };
  }
}

/** What the profile page says about an agent's ENS result. `ctx.identity` is the Identity registry the app reads. */
export function profileView(ens: AgentEns, ctx: { identity: string }): ProfileView {
  return {
    title: ens.name,
    verification: { badge: ens.badge, sentences: sentences(ens) },
    records: { context: contextLines(ens.records.context), endpoint: endpointOf(ens.records.endpointWeb) },
    operator: { onBase: ens.operator.onBase, onEns: ens.operator.onEns, sentence: operatorSentence(ens.operator) },
    registry: { identity: ctx.identity, agentId: String(ens.agentId) },
    parent: { owner: ens.parentOwner, resolver: ens.resolver },
    mirror: mirrorView(ens.mirror),
  };
}

export type AgentMatch =
  | { kind: "found"; agent: AgentInfo; agentId: bigint }
  /** An agent is called this, but its name is not an ENS label (for example it has capitals or spaces). */
  | { kind: "no-ens-name"; agent: AgentInfo }
  | { kind: "unknown" };

/** The agent in the public list whose ENS label is `label`. Only a name that already is that label matches. */
export function findAgent(agents: readonly AgentInfo[], label: string): AgentMatch {
  const exact = agents.find((a) => labelForAgent(a.name) === label);
  if (exact)
    return /^\d+$/.test(exact.agent_id)
      ? { kind: "found", agent: exact, agentId: BigInt(exact.agent_id) }
      : { kind: "unknown" };
  const near = agents.find((a) => a.name.toLowerCase() === label);
  return near ? { kind: "no-ens-name", agent: near } : { kind: "unknown" };
}
