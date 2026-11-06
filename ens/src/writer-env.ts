import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import type { PublisherConfig } from "./publisher.ts";
import { ensNameOf } from "./registration.ts";

export type WriterEnv = {
  ensRpc: string; baseRpc: string; publisherKey: Hex; editorKey: Hex; port: number; intervalSeconds: number; configPath: string;
  /** Caps that bound what the hot editor key can spend and how many RPC reads an unauthenticated caller can cause. */
  editsPerAgentPerHour: number; editsPerHour: number; requestsPerMinute: number;
};

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function key(env: Record<string, string | undefined>, name: string): { key: Hex; address: Address } {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  if (!KEY.test(v)) throw new Error(`${name} is not a 0x-prefixed 32-byte hex key`);
  try { return { key: v as Hex, address: privateKeyToAddress(v as Hex) }; }
  catch { throw new Error(`${name} is not a valid private key`); } // the underlying error would print the key as a decimal
}

function int(env: Record<string, string | undefined>, name: string, def: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === "") return def;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** Reads the service's environment. No error message ever contains a key or an RPC URL. */
export function parseWriterEnv(env: Record<string, string | undefined>): WriterEnv {
  for (const name of ["ENS_MAINNET_RPC", "BASE_SEPOLIA_RPC", "WRITER_CONFIG"]) if (!env[name]) throw new Error(`${name} is required`);
  const publisher = key(env, "ENS_PUBLISHER_PRIVATE_KEY");
  const editor = key(env, "ENS_EDITOR_PRIVATE_KEY");
  if (publisher.address === editor.address) throw new Error("ENS_PUBLISHER_PRIVATE_KEY and ENS_EDITOR_PRIVATE_KEY must be different accounts");
  return {
    ensRpc: env.ENS_MAINNET_RPC!, baseRpc: env.BASE_SEPOLIA_RPC!, publisherKey: publisher.key, editorKey: editor.key,
    port: int(env, "WRITER_PORT", 8787, 0, 65535), intervalSeconds: int(env, "WRITER_INTERVAL_SECONDS", 300, 1, 86400), configPath: env.WRITER_CONFIG!,
    editsPerAgentPerHour: int(env, "WRITER_EDITS_PER_AGENT_PER_HOUR", 6, 1, 100000), editsPerHour: int(env, "WRITER_EDITS_PER_HOUR", 60, 1, 100000),
    requestsPerMinute: int(env, "WRITER_REQUESTS_PER_MINUTE", 120, 1, 100000),
  };
}

/** The environment of the one-off publish: the publisher key only (no editor key, no service). */
export function parsePublishOnceEnv(env: Record<string, string | undefined>): { ensRpc: string; baseRpc: string; publisherKey: Hex; configPath: string } {
  for (const name of ["ENS_MAINNET_RPC", "BASE_SEPOLIA_RPC", "WRITER_CONFIG"]) if (!env[name]) throw new Error(`${name} is required`);
  const publisher = key(env, "ENS_PUBLISHER_PRIVATE_KEY");
  return { ensRpc: env.ENS_MAINNET_RPC!, baseRpc: env.BASE_SEPOLIA_RPC!, publisherKey: publisher.key, configPath: env.WRITER_CONFIG! };
}

/** Replaces every secret (keys, RPC URLs and the path or query of an RPC URL, where API keys usually sit) with `[redacted]`. */
export function redact(message: string, secrets: string[]): string {
  const all = new Set<string>();
  for (const s of secrets) {
    if (!s) continue;
    all.add(s);
    try { const u = new URL(s); for (const part of [u.pathname, u.search]) if (part.length > 1) all.add(part); } catch { /* not a URL */ }
  }
  let out = message;
  for (const s of [...all].sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  return out;
}

const bad = (m: string): never => { throw new Error(`writer config: ${m}`); };
const addr = (v: unknown, field: string): Address => (typeof v === "string" && isAddress(v) ? getAddress(v) : bad(`"${field}" is not a valid address`));

/** Loads the publisher's configuration file (addresses, agents, known category labels, first block to read). */
export function loadWriterConfig(path: string): PublisherConfig {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return bad(`cannot read ${path}: ${(e as Error).message}`); }
  if (!Number.isSafeInteger(raw?.chain?.chainId) || raw.chain.chainId <= 0) bad(`"chain.chainId" must be a positive integer`);
  const chain = { chainId: raw.chain.chainId as number, identity: addr(raw.chain.identity, "chain.identity"), anchor: addr(raw.chain.anchor, "chain.anchor") };
  const resolver = addr(raw.resolver, "resolver");
  if (typeof raw.fromBlock !== "string" && typeof raw.fromBlock !== "number") bad(`"fromBlock" is required`);
  if (!/^\d+$/.test(String(raw.fromBlock))) bad(`"fromBlock" must be a non-negative integer`);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) bad(`"agents" must be a non-empty list`);
  const labels = new Set<string>(); const ids = new Set<number>();
  const agents = raw.agents.map((a: any, i: number) => {
    try { ensNameOf(a?.label); } catch (e) { bad(`agents[${i}].label: ${(e as Error).message}`); }
    if (!Number.isSafeInteger(a.agentId) || a.agentId <= 0) bad(`agents[${i}].agentId must be a positive integer`);
    if (labels.has(a.label)) bad(`duplicate label ${a.label}`);
    if (ids.has(a.agentId)) bad(`duplicate agent id ${a.agentId}`);
    labels.add(a.label); ids.add(a.agentId);
    return { label: a.label as string, agentId: a.agentId as number };
  });
  const confirmations = raw.confirmations ?? 5;
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 100) bad(`"confirmations" must be an integer from 0 to 100`);
  const known = raw.knownCategories ?? [];
  if (!Array.isArray(known) || known.some((k: unknown) => typeof k !== "string")) bad(`"knownCategories" must be a list of strings`);
  return { chain, resolver, agents, knownCategories: known, fromBlock: BigInt(String(raw.fromBlock)), confirmations, ...(raw.chunk ? { chunk: BigInt(raw.chunk) } : {}) };
}
