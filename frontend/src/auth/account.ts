import { getAddress, isAddress } from "viem";
import { apiBase } from "../chain/wallet";
import type { Session, SignInMethod } from "./session";
import { short } from "./session";

export type IdentityProvider = "github" | "google" | "email";
const PROVIDERS: readonly string[] = ["github", "google", "email"];

/** A Mergit account as `GET /v0/auth/me` describes it. `address` is the requester address the session acts as. */
export type Account = {
  /** Null only for a session from before accounts existed. */
  userId: string | null;
  address: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  identities: { provider: IdentityProvider; label: string }[];
  wallets: string[];
  /** The on-chain requester of free-trial plans while the user has no wallet. Not a wallet anyone holds. */
  trialAddress: string | null;
  trialStartedAt: string | null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseAccount(body: unknown): Account | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const address = text(b.address);
  if (!address) return null;
  const identities = (Array.isArray(b.identities) ? (b.identities as unknown[]) : []).flatMap((i) => {
    if (!i || typeof i !== "object") return [];
    const { provider, label } = i as Record<string, unknown>;
    return typeof provider === "string" && PROVIDERS.includes(provider) && typeof label === "string"
      ? [{ provider: provider as IdentityProvider, label }]
      : [];
  });
  const trial = b.trial && typeof b.trial === "object" ? (b.trial as Record<string, unknown>) : null;
  return {
    userId: text(b.user_id),
    address,
    name: text(b.name),
    email: text(b.email),
    avatarUrl: text(b.avatar_url),
    identities,
    wallets: (Array.isArray(b.wallets) ? (b.wallets as unknown[]) : []).filter(
      (w): w is string => typeof w === "string",
    ),
    trialAddress: text(b.trial_address),
    trialStartedAt: trial ? text(trial.started_at) : null,
  };
}

/** What the server says about the session cookie: `expired` when there is none, `unknown` when it cannot be asked. */
export type AccountCheck = { status: "valid"; account: Account } | { status: "expired" } | { status: "unknown" };

/**
 * Asks who is signed in. `/v0/auth/session` answers `200 null` for nobody, where `/v0/auth/me` answers 401, and a
 * 401 is printed in red in the console of every signed-out visitor on every page load. An API from before that route
 * existed answers 404, and is asked the strict way instead.
 */
export async function askServer(request: typeof fetch = fetch): Promise<Response> {
  const base = apiBase();
  const response = await request(`${base}/v0/auth/session`, { credentials: "include" });
  return response.status === 404 ? request(`${base}/v0/auth/me`, { credentials: "include" }) : response;
}

/**
 * The browser remembers a session in localStorage, but the real one is a cookie that expires and does not survive the
 * API losing its database. A server that cannot be reached leaves the remembered session alone: an outage must not
 * sign people out.
 */
export async function fetchAccount(fetchMe: () => Promise<Response> = askServer): Promise<AccountCheck> {
  try {
    const response = await fetchMe();
    if (response.status === 401) return { status: "expired" };
    if (!response.ok) return { status: "unknown" };
    const body: unknown = await response.json();
    if (body === null) return { status: "expired" }; // the quiet probe's "nobody is signed in"
    const account = parseAccount(body);
    return account ? { status: "valid", account } : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/** The browser's session for an account the server just described. */
export function sessionFromAccount(account: Account, since: number = Date.now()): Session {
  const wallet = account.wallets.includes(account.address);
  const method: SignInMethod = wallet ? "browser" : (account.identities[0]?.provider ?? "email");
  // The server sends lowercase addresses; the app shows (and compares) the checksummed form.
  const address = isAddress(account.address) ? getAddress(account.address) : account.address;
  return { address, addressShort: short(address), method, since };
}

/** True when two addresses are the same one, whatever the letter case. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True while the session acts as the trial address: free-credit plans only, and no wallet to read or fund from. */
export function isTrialSession(account: Account | null, address: string | undefined): boolean {
  return !!account && !!address && account.trialAddress !== null && sameAddress(account.trialAddress, address);
}

/** A signed-in account that has neither connected a wallet nor started the free trial still has to choose. */
export function fundingChoiceNeeded(account: Account | null): boolean {
  return !!account && account.userId !== null && account.wallets.length === 0 && account.trialStartedAt === null;
}

/** Up to two capital letters for the avatar: from the name, else from the email. Null when there is neither. */
export function initialsOf(name: string | null, email: string | null): string | null {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("");
  }
  return email ? email.slice(0, 2).toUpperCase() : null;
}
