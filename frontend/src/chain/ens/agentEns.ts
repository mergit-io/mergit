import { getAddress, zeroAddress, type Address } from "viem";
import { agentRegistrationKey } from "./ensip25.ts";
import { parseMirror, parseOperator, type Mirror } from "./mirror.ts";
import { PARENT_NAME, ensNameOf } from "./names.ts";
import { parseRegistrationFile } from "./registrationFile.ts";

type ReadArgs = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** What the reader needs, so tests can stub it and the same code runs against real forks. */
export type EnsClients = {
  /** Ethereum mainnet. `getEnsText` must go through the ENSv2 Universal Resolver at `universalResolverAddress`. */
  ens: {
    getEnsText(args: { name: string; key: string; universalResolverAddress: Address }): Promise<string | null>;
    readContract(args: ReadArgs): Promise<unknown>;
  };
  /** Base (where Identity and ReputationAnchor live). */
  base: { readContract(args: ReadArgs): Promise<unknown> };
  /** Fetches and parses JSON from an https URL; rejects on any failure. */
  fetchJson(url: string): Promise<unknown>;
};

export type EnsConfig = {
  identity: Address;
  chainId: number;
  universalResolver: Address;
  /** The mainnet ETH registry, read at runtime for the owner and resolver of `mergit.eth`. */
  registry: Address;
  /** The Base ReputationAnchor a `mergit.reputation` record must name as its source. */
  anchor: Address;
};

export type FailureReason =
  | "no-registration-record"
  | "unknown-agent"
  | "no-metadata-uri"
  | "unsupported-uri"
  | "registration-file-unreachable"
  | "registration-file-invalid"
  | "name-mismatch"
  | "registration-not-listed"
  | "read-failed";

export type Verification = { status: "verified" } | { status: "failed"; reason: FailureReason; detail: string };
export type OperatorState = { state: "current" | "unknown" | "changed"; onBase: Address | null; onEns: Address | null };
export type MirrorState =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "malformed"; detail: string }
  | { status: "ok"; mirror: Mirror };

export type AgentEns = {
  name: string;
  agentId: bigint;
  /** The current owner of `mergit.eth`: records-only subnames have no owner of their own. */
  parentOwner: Address | null;
  /** The resolver `mergit.eth` points at now, read from the registry. */
  resolver: Address | null;
  records: { context: string | null; endpointWeb: string | null; registration: string | null };
  verification: Verification;
  operator: OperatorState;
  mirror: MirrorState;
  /**
   * Show the tick only for "verified". "unconfirmed": the two-way check passed but the operator record is not on ENS yet
   * (the publisher has not run), so a sale cannot be ruled out: draw it as weaker than a tick. "owner-changed": the agent
   * was sold since ENS was last updated. "not-verified": the two-way check did not pass.
   */
  badge: "verified" | "unconfirmed" | "owner-changed" | "not-verified";
  /** Display details that could not be read this time (the tick does not depend on them). */
  unreadable: string[];
};

const PARENT_LABEL = PARENT_NAME.slice(0, PARENT_NAME.indexOf("."));

const registryAbi = [
  {
    type: "function",
    name: "findOwner",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getResolver",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;
const identityReadAbi = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "operatorOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };
const attempt = async <T>(fn: () => Promise<T>): Promise<Read<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
};
const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : "unknown error") ?? "unknown error";
function isRevert(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 8; i++) {
    const err = x as { name?: string; message?: string; cause?: unknown };
    if (err.name === "ContractFunctionRevertedError" || /\brevert(ed)?\b/i.test((err.message ?? "").slice(0, 400)))
      return true;
    x = err.cause;
  }
  return false;
}

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An endpoint shown as a link must be a plain https URL: never `javascript:`, `http:`, relative, or carrying credentials. */
function safeHttpsUrl(value: string | null): string | null {
  if (!value || value.length > 300 || hasControlOrSpace(value)) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "" ? value : null;
  } catch {
    return null;
  }
}

const failed = (reason: FailureReason, detail: string): Verification => ({ status: "failed", reason, detail });

/**
 * Everything the web app shows about an agent's ENS name, as typed values: it never throws for an expected condition
 * (a bad record, an unreachable file, a failing RPC), so the UI cannot show a tick by accident. Throws only for an
 * invalid `label`, which is a programming error (use `labelForAgent`).
 *
 * The two-way check (ENSIP-25): the ENS name must carry `agent-registration[<Identity>][<id>]` AND the agent's metadata
 * file on Base must name this same ENS name and list this same registry entry. The tick also needs the operator recorded
 * on ENS (`mergit.operator`, written by the publisher) to still be the operator on Base; if it is not, the agent was sold.
 */
export async function loadAgentEns(
  c: EnsClients,
  cfg: EnsConfig,
  agent: { agentId: bigint; label: string },
): Promise<AgentEns> {
  const name = ensNameOf(agent.label);
  const regKey = agentRegistrationKey(cfg.identity, cfg.chainId, agent.agentId);
  const text = (key: string) =>
    attempt(async () => (await c.ens.getEnsText({ name, key, universalResolverAddress: cfg.universalResolver })) ?? "");
  const registry = (functionName: "findOwner" | "getResolver") =>
    attempt(
      async () =>
        (await c.ens.readContract({
          address: cfg.registry,
          abi: registryAbi,
          functionName,
          args: [PARENT_LABEL],
        })) as Address,
    );
  const identity = (functionName: "tokenURI" | "operatorOf") =>
    attempt(
      async () =>
        await c.base.readContract({ address: cfg.identity, abi: identityReadAbi, functionName, args: [agent.agentId] }),
    );

  const [reg, context, endpoint, operatorRecord, mirrorRecord, owner, resolver, uri, operatorBase] = await Promise.all([
    text(regKey),
    text("agent-context"),
    text("agent-endpoint[web]"),
    text("mergit.operator"),
    text("mergit.reputation"),
    registry("findOwner"),
    registry("getResolver"),
    identity("tokenURI"),
    identity("operatorOf"),
  ]);

  const unreadable: string[] = [];
  const display = <T>(r: Read<T>, what: string): T | null => {
    if (r.ok) return r.value;
    unreadable.push(what);
    return null;
  };
  const addr = (a: Address | null): Address | null => (a && a !== zeroAddress ? getAddress(a) : null);

  const contextText = display(context, "the agent's description");
  const endpointText = display(endpoint, "the web endpoint");
  const parentOwner = addr(display(owner, `the owner of ${PARENT_NAME}`));
  const resolverAddr = addr(display(resolver, `the resolver of ${PARENT_NAME}`));

  const mirror: MirrorState = !mirrorRecord.ok
    ? (unreadable.push("the reputation record"), { status: "unavailable" })
    : mirrorRecord.value === ""
      ? { status: "absent" }
      : (() => {
          try {
            return {
              status: "ok" as const,
              mirror: parseMirror(mirrorRecord.value, { chainId: cfg.chainId, contract: cfg.anchor }),
            };
          } catch (e) {
            return { status: "malformed" as const, detail: message(e) };
          }
        })();

  // The operator on Base against the one recorded on ENS.
  const onBase = operatorBase.ok ? addr(operatorBase.value as Address) : null;
  const onEns = operatorRecord.ok ? parseOperator(operatorRecord.value) : null;
  const operator: OperatorState = {
    state: onBase && onEns ? (onBase.toLowerCase() === onEns.toLowerCase() ? "current" : "changed") : "unknown",
    onBase,
    onEns,
  };

  const verification = await verify();
  const badge: AgentEns["badge"] =
    verification.status !== "verified"
      ? "not-verified"
      : operator.state === "changed"
        ? "owner-changed"
        : operator.state === "unknown"
          ? "unconfirmed"
          : "verified";
  return {
    name,
    agentId: agent.agentId,
    parentOwner,
    resolver: resolverAddr,
    records: {
      context: contextText || null,
      endpointWeb: safeHttpsUrl(endpointText),
      registration: reg.ok && reg.value ? reg.value : null,
    },
    verification,
    operator,
    mirror,
    badge,
    unreadable,
  };

  async function verify(): Promise<Verification> {
    // Reads the check depends on: any failure means "cannot confirm", never a tick.
    if (!reg.ok) return failed("read-failed", `Could not read the ENSIP-25 record: ${message(reg.error)}`);
    if (!uri.ok) {
      return isRevert(uri.error)
        ? failed("unknown-agent", `Agent ${String(agent.agentId)} is not registered on Base.`)
        : failed("read-failed", `Could not read the agent's metadata URI: ${message(uri.error)}`);
    }
    if (!operatorBase.ok)
      return failed("read-failed", `Could not read the agent's operator on Base: ${message(operatorBase.error)}`);
    if (!operatorRecord.ok)
      return failed("read-failed", `Could not read the operator record: ${message(operatorRecord.error)}`);

    if (reg.value === "") return failed("no-registration-record", `${name} carries no ${regKey} record.`);
    const metadataUri = uri.value as string;
    if (metadataUri === "")
      return failed("no-metadata-uri", `Agent ${String(agent.agentId)} was registered without a metadata URI.`);
    if (!metadataUri.startsWith("https://"))
      return failed("unsupported-uri", `The metadata URI is not an https URL: ${metadataUri.slice(0, 80)}`);

    const body = await attempt(() => c.fetchJson(metadataUri));
    if (!body.ok) return failed("registration-file-unreachable", message(body.error));
    let info;
    try {
      info = parseRegistrationFile(body.value);
    } catch (e) {
      return failed("registration-file-invalid", message(e));
    }
    if (info.ensName === null || info.ensName.toLowerCase() !== name.toLowerCase()) {
      return failed(
        "name-mismatch",
        `The registration file names ${info.ensName ?? "no ENS name"} but this agent's name is ${name}.`,
      );
    }
    const registry = `eip155:${String(cfg.chainId)}:${cfg.identity}`.toLowerCase();
    if (
      !info.registrations.some((r) => r.agentId === String(agent.agentId) && r.agentRegistry.toLowerCase() === registry)
    ) {
      return failed(
        "registration-not-listed",
        `The registration file does not list agent ${String(agent.agentId)} in ${registry}.`,
      );
    }
    return { status: "verified" };
  }
}
