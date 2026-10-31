import { apiBase } from "../chain/wallet";
import { NoAccountError, type Intent } from "./intent";
import type { Providers } from "./signInOptions";

/** The sign-in methods the server has set up, or null when it cannot be asked. */
export async function fetchProviders(): Promise<Providers | null> {
  try {
    const response = await fetch(`${apiBase()}/v0/auth/providers`, { credentials: "include" });
    if (!response.ok) return null;
    const b = (await response.json()) as Record<string, unknown>;
    return { wallet: true, github: b.github === true, google: b.google === true, email: b.email === true };
  } catch {
    return null;
  }
}

/** Where the browser goes to sign in with GitHub or Google. A full-page navigation: the provider redirects back. */
export const oauthStartUrl = (provider: "github" | "google", intent: Intent) =>
  `${apiBase()}/v0/auth/${provider}/start?intent=${intent}`;

const post = (path: string, body?: unknown) =>
  fetch(`${apiBase()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Asks for a one-time code to be emailed. Throws a sentence for the user when the server refuses. */
export async function requestEmailCode(email: string): Promise<void> {
  const response = await post("/v0/auth/email/start", { email }).catch(() => {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  });
  if (response.status === 429) throw new Error("Too many codes were sent to that address. Try again in an hour.");
  if (response.status === 422) throw new Error("That does not look like an email address.");
  if (!response.ok) throw new Error("Mergit could not send the code. Try again in a moment.");
}

/** Signs in with the emailed code. The session is the cookie the server sets. */
export async function submitEmailCode(email: string, code: string, intent: Intent): Promise<void> {
  const response = await post("/v0/auth/email/verify", { email, code, intent }).catch(() => {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  });
  if (response.status === 404) throw new NoAccountError();
  if (response.status === 401) throw new Error("That code is wrong or has expired. Ask for a new one.");
  if (response.status === 422) throw new Error("The code is six digits.");
  if (!response.ok) throw new Error("Mergit could not check the code. Try again in a moment.");
}

/** Chooses the free trial. */
export async function startTrial(): Promise<void> {
  const response = await post("/v0/account/trial").catch(() => {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  });
  if (!response.ok) throw new Error("Mergit could not start the trial. Try again in a moment.");
}

/** Confirms a merge the server offered. Returns the wallet the session acts as from now on. */
export async function confirmMerge(
  token: string,
  base: string = apiBase(),
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<string> {
  let response: Response;
  try {
    response = await send(`${base}/v0/auth/merge`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merge_token: token }),
    });
  } catch {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  }
  if (response.status === 404) throw new Error("That offer has expired. Connect the wallet again to get a new one.");
  if (response.status === 403) throw new Error("That offer belongs to a different account.");
  if (response.status === 401) throw new Error("Your session has ended. Sign in again to continue.");
  if (!response.ok) throw new Error("Mergit could not merge the accounts. Try again in a moment.");
  const body = (await response.json().catch(() => null)) as { address?: unknown } | null;
  if (typeof body?.address !== "string") throw new Error("Mergit's API did not answer like the merge service.");
  return body.address;
}

/**
 * Redeems a code for the signed-in account. Returns the amount added, in USDC base units. Throws a sentence the person
 * can act on: every refusal says what to do next, and the server never says which part of a bad code was wrong.
 */
export async function redeemCode(
  code: string,
  base: string = apiBase(),
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<bigint> {
  const trimmed = code.trim();
  if (trimmed === "") throw new Error("Enter a code.");
  let response: Response;
  try {
    response = await send(`${base}/v0/account/redeem`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: trimmed }),
    });
  } catch {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  }
  if (response.status === 400) throw new Error("That code is not valid. Check it and try again.");
  if (response.status === 409) throw new Error("That code has already been used.");
  if (response.status === 410) throw new Error("That code has expired.");
  if (response.status === 401) throw new Error("Your session has ended. Sign in again to continue.");
  if (response.status === 422) throw new Error("That does not look like a code.");
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Too many tries. Try again later.");
    const minutes = Math.ceil(seconds / 60);
    throw new Error(`Too many tries. Try again in ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}.`);
  }
  if (!response.ok) throw new Error("Mergit could not check the code. Try again in a moment.");
  const body = (await response.json().catch(() => null)) as { amount_usdc_units?: unknown } | null;
  const units = body?.amount_usdc_units;
  if (typeof units !== "string" || !/^[1-9][0-9]*$/.test(units)) {
    throw new Error("Mergit's API did not answer like the redeem service.");
  }
  return BigInt(units);
}
