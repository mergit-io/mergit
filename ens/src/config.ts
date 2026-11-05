import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import type { OneShotConfig } from "./oneshot.ts";
import type { OneShotAgent } from "./oneshot-plan.ts";
import { ensNameOf } from "./registration.ts";
import { isTestAddress } from "./test-accounts.ts";

const bad = (msg: string): never => { throw new Error(`config: ${msg}`); };

function address(raw: unknown, field: string, opts: { allowTestAddresses?: boolean; role?: boolean } = {}): Address {
  if (typeof raw !== "string" || !isAddress(raw)) bad(`"${field}" is not a valid address`);
  const a = getAddress(raw as string);
  if (opts.role && !opts.allowTestAddresses && isTestAddress(a)) {
    bad(`"${field}" is an anvil test address (its private key is public); use a real account. Test addresses are only allowed in --fork runs`);
  }
  return a;
}

/** Loads and validates the one-shot config. Anvil's public test addresses are refused for roles unless `allowTestAddresses` (fork runs). */
export function loadConfig(path: string, opts: { allowTestAddresses?: boolean } = {}): OneShotConfig {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return bad(`cannot read ${path}: ${(e as Error).message}`); }
  if (!Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) bad(`"chainId" must be a positive integer`);
  const identity = address(raw.identity, "identity");
  const publisher = address(raw.publisher, "publisher", { ...opts, role: true });
  const editor = address(raw.editor, "editor", { ...opts, role: true });
  if (raw.saltNonce !== undefined && (!Number.isSafeInteger(raw.saltNonce) || raw.saltNonce < 0)) bad(`"saltNonce" must be a non-negative integer`);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) bad(`"agents" must be a non-empty list`);

  const labels = new Set<string>();
  const ids = new Set<number>();
  const agents: OneShotAgent[] = raw.agents.map((a: any, i: number) => {
    const where = `agents[${i}]`;
    try { ensNameOf(a?.label); } catch (e) { bad(`${where}.label: ${(e as Error).message}`); }
    // agentId may be omitted until the agent is registered on Base; the planner refuses to run an agent without one
    if (a.agentId !== undefined && (!Number.isSafeInteger(a.agentId) || a.agentId <= 0)) bad(`${where}.agentId must be a positive integer`);
    for (const f of ["name", "description"] as const) if (typeof a[f] !== "string" || !a[f].trim()) bad(`${where}.${f} must be a non-empty string`);
    if (typeof a.profileUrl !== "string") bad(`${where}.profileUrl is required`);
    let url: URL | undefined;
    try { url = new URL(a.profileUrl); } catch { /* handled below */ }
    if (!url || url.protocol !== "https:") bad(`${where}.profileUrl must be an https URL`);
    if (labels.has(a.label)) bad(`duplicate label ${a.label}`);
    if (a.agentId !== undefined && ids.has(a.agentId)) bad(`duplicate agent id ${a.agentId}`);
    labels.add(a.label); if (a.agentId !== undefined) ids.add(a.agentId);
    return { label: a.label, agentId: a.agentId, name: a.name, description: a.description, profileUrl: a.profileUrl,
      ...(a.image ? { image: a.image } : {}), ...(a.supportedTrust ? { supportedTrust: a.supportedTrust } : {}) };
  });
  return { chain: { chainId: raw.chainId, identity }, publisher, editor, agents, ...(raw.saltNonce !== undefined ? { saltNonce: raw.saltNonce } : {}) };
}
