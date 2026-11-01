/**
 * Demo session. There is no auth backend yet: connecting a wallet in the
 * Connect window stores the address here. Swap `connectWallet` for a real
 * wallet connector (and a server-issued session) when the backend exists.
 */

import { IN_DEMO } from "../config/live";

export type WalletKind = "browser" | "walletconnect" | "passkey";
export type SignInMethod = WalletKind | "github" | "google" | "email";
export type Session = { address: string; addressShort: string; method: SignInMethod; since: number };

// The demo keeps its own record, so visiting it can neither replace nor sign out a real session in the same browser.
const STORAGE_KEY = IN_DEMO ? "mergit-demo-session" : "mergit-session";

export const DEMO_ADDRESS = "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b";
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Session>;
    return typeof value.address === "string" && typeof value.method === "string" && typeof value.since === "number"
      ? { address: value.address, addressShort: short(value.address), method: value.method, since: value.since }
      : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: the session lasts for this page only.
  }
}

/** The message a wallet is asked to sign, in the Sign-In with Ethereum shape. */
export function signInMessage(address: string, nonce: string) {
  return `mergit.app wants you to sign in\nwith ${short(address)} on the L2 testnet\nNonce: ${nonce}`;
}

export function randomNonce() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A session for the demo account, however the user signed in. */
export function demoSession(method: SignInMethod): Session {
  return { address: DEMO_ADDRESS, addressShort: short(DEMO_ADDRESS), method, since: Date.now() };
}

/** Simulated wallet: resolves with the demo account after a signing delay. */
export async function connectWallet(wallet: WalletKind, signal?: AbortSignal): Promise<Session> {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, 1200);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    });
  });
  return demoSession(wallet);
}
