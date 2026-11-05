import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";

export const EDIT_KEYS = ["agent-context", "agent-endpoint[web]"] as const;
export type EditKey = (typeof EDIT_KEYS)[number];
export type EditRequest = { agentId: number; key: EditKey; value: string; nonce: string; issuedAt: number; expiresAt: number };
/** `reserve` is atomic (no await between check and set); a request that is later refused calls `release`. */
export type NonceStore = { has(nonce: string): boolean; reserve(nonce: string, expiresAt: number): boolean; release(nonce: string): void };

const MAX_WINDOW_S = 600;
const MAX_FUTURE_SKEW_S = 60;

/** A refused edit request. `status` is the HTTP status the service answers with. */
export class EditRefused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EditRefused";
    this.status = status;
  }
}

export function memoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  return {
    has: (n) => seen.has(n),
    reserve(n, expiresAt) {
      if (seen.has(n)) return false;
      seen.set(n, expiresAt);
      const now = Math.floor(Date.now() / 1000);
      for (const [k, exp] of seen) if (exp < now - MAX_WINDOW_S) seen.delete(k);
      return true;
    },
    release: (n) => { seen.delete(n); },
  };
}

/** The exact text the operator signs: it names the chain, the Identity contract and every field of the request. */
export function editMessage(req: EditRequest, binding: { chainId: number; identity: Address }): string {
  return [
    "Mergit ENS edit request",
    `Chain: eip155:${binding.chainId}`,
    `Identity: ${binding.identity}`,
    `Agent: ${req.agentId}`,
    `Key: ${req.key}`,
    `Value: ${JSON.stringify(req.value)}`,
    `Nonce: ${req.nonce}`,
    `Issued at: ${req.issuedAt}`,
    `Expires at: ${req.expiresAt}`,
    "I authorize Mergit to write this record for my agent under mergit.eth.",
  ].join("\n");
}

const bad = (message: string): never => { throw new EditRefused(400, message); };

function checkValue(key: EditKey, value: string): void {
  if (key === "agent-endpoint[web]") {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* refused below */ }
    if (value.length === 0 || value.length > 300 || !/^[^\s\u0000-\u001f\u007f]+$/.test(value) || !url || url.protocol !== "https:" || !url.hostname) {
      bad("invalid value: agent-endpoint[web] must be an https URL of at most 300 characters without whitespace or control characters");
    }
  } else if (value.length === 0 || value.length > 2000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)) {
    bad("invalid value: agent-context must be 1 to 2,000 characters; newlines are allowed, other control characters are not");
  }
}

/**
 * Checks a signed edit request. Cheap checks first, nothing is recorded unless every check passes. The operator is read from
 * Base at verification time, so a transferred agent's previous owner is refused immediately. EOA signatures only (EIP-191).
 */
export async function verifyEdit(
  req: EditRequest, signature: Hex,
  ctx: { base: { readContract(args: { address: Address; abi: readonly unknown[]; functionName: "operatorOf"; args: readonly unknown[] }): Promise<unknown> };
         identity: Address; chainId: number; now: number; seenNonces: NonceStore; startedAt: number },
): Promise<{ operator: Address }> {
  const r = req as Partial<EditRequest> | null;
  if (!r || !Number.isSafeInteger(r.agentId) || (r.agentId as number) <= 0 || typeof r.key !== "string" || typeof r.value !== "string"
      || typeof r.nonce !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(r.nonce)
      || !Number.isSafeInteger(r.issuedAt) || !Number.isSafeInteger(r.expiresAt)) bad("invalid request: missing or malformed field");
  if (!(EDIT_KEYS as readonly string[]).includes(req.key)) throw new EditRefused(403, `key not allowed: only ${EDIT_KEYS.join(" and ")} can be edited`);
  checkValue(req.key, req.value);
  if (req.expiresAt <= ctx.now) bad("request expired");
  if (req.expiresAt - req.issuedAt > MAX_WINDOW_S) bad(`validity window too long: at most ${MAX_WINDOW_S} seconds`);
  if (req.issuedAt > ctx.now + MAX_FUTURE_SKEW_S) bad("request issued in the future");
  if (req.issuedAt < ctx.startedAt) bad("request issued before the service started; sign a new one");
  // reserve the nonce before any await, so two concurrent copies of one request cannot both pass; give it back if the request is refused
  if (!ctx.seenNonces.reserve(req.nonce, req.expiresAt)) throw new EditRefused(409, "nonce replayed");
  try {
    let signer: Address;
    try { signer = await recoverMessageAddress({ message: editMessage(req, { chainId: ctx.chainId, identity: ctx.identity }), signature }); }
    catch { throw new EditRefused(400, "invalid signature"); }
    const operator = getAddress((await ctx.base.readContract({
      address: ctx.identity, abi: [{ type: "function", name: "operatorOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
      functionName: "operatorOf", args: [BigInt(req.agentId)],
    })) as string);
    if (getAddress(signer) !== operator) throw new EditRefused(403, "signer is not the operator of this agent on Base");
    return { operator };
  } catch (e) { ctx.seenNonces.release(req.nonce); throw e; }
}
