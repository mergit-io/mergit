import { getAddress, toHex, type Address } from "viem";
import { LIVE } from "../config/live";
import { short, type Session } from "../auth/session";
import { injected, switchChain, walletChainId } from "./client";
import { NoAccountError, type Intent } from "../auth/intent";
import { parseWalletTaken, WalletTakenError } from "../auth/merge";
import { buildSignIn } from "./siwe";

/** The API's address without a trailing slash. An empty one would send sign-in to the page's own origin. */
export function apiBase(url: string = LIVE.apiUrl): string {
  if (!url) throw new Error("Mergit's API address is not configured for this build (VITE_API_URL).");
  return url.replace(/\/+$/, "");
}

/** Connects the browser wallet, checks the chain and has it sign an EIP-4361 message for a fresh server nonce. */
async function signWithWallet(onMessage?: (message: string) => void) {
  const provider = injected();
  if (!provider)
    throw new Error("MetaMask was not found in this browser. Install it, reload this page, then try again.");
  const [first] = await provider.request({ method: "eth_requestAccounts" });
  if (!first) throw new Error("The wallet did not share an account.");
  const address = getAddress(first);
  if ((await walletChainId()) !== LIVE.chainId && !(await switchChain())) {
    throw new Error(`Switch your wallet to ${LIVE.chainName}, then sign in again.`);
  }

  const api = apiBase();
  const nonceRes = await fetch(`${api}/v0/auth/nonce`, { credentials: "include" }).catch(() => {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  });
  if (!nonceRes.ok) throw new Error("Mergit could not start a sign-in. Try again in a moment.");
  const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string };
  if (!nonce) throw new Error("Mergit's API did not answer like the sign-in service. Check its address.");
  const message = buildSignIn({
    address,
    nonce,
    domain: window.location.host,
    uri: window.location.origin,
    chainId: LIVE.chainId,
  });
  onMessage?.(message);
  // personal_sign takes the message hex-encoded (EIP-1474); the wallet shows it as text.
  const signature = await provider.request({ method: "personal_sign", params: [toHex(message), address] });
  return { api, address, message, signature };
}

export const walletSession = (address: Address): Session => ({
  address,
  addressShort: short(address),
  method: "browser",
  since: Date.now(),
});

/** Signs in with the browser wallet: connect, check the chain, sign an EIP-4361 message, open a session. */
export async function connectAndSignIn(
  onMessage?: (message: string) => void,
  intent: Intent = "register",
): Promise<Session> {
  const { api, address, message, signature } = await signWithWallet(onMessage);
  const verify = await fetch(`${api}/v0/auth/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature, intent }),
  });
  if (verify.status === 404) throw new NoAccountError();
  if (!verify.ok) throw new Error("Mergit did not accept the signature. Try signing in again.");
  return walletSession(address);
}

/** Connects a wallet to the account that is already signed in; from then on the session acts as that wallet. */
export async function connectAndLinkWallet(onMessage?: (message: string) => void): Promise<Session> {
  const { api, address, message, signature } = await signWithWallet(onMessage);
  const link = await fetch(`${api}/v0/auth/wallet/link`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (link.status === 409) {
    // The wallet has its own account. When it is the same person's, they can merge it into this one.
    const offer = parseWalletTaken(await link.json().catch(() => null));
    if (offer) throw new WalletTakenError(offer);
    throw new Error("That wallet already belongs to another Mergit account.");
  }
  if (!link.ok) throw new Error("Mergit did not accept the signature. Try connecting the wallet again.");
  return walletSession(address);
}

export async function signOutLive(): Promise<void> {
  await fetch(`${apiBase()}/v0/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
}

/** Calls `onChange` when the wallet switches to an account other than `address`, or disconnects. */
export function watchAccount(address: Address, onChange: () => void): () => void {
  const provider = injected();
  if (!provider) return () => undefined;
  const listener = (accounts: Address[]) => {
    const next = accounts[0];
    if (!next || getAddress(next) !== getAddress(address)) onChange();
  };
  provider.on("accountsChanged", listener);
  return () => {
    provider.removeListener("accountsChanged", listener);
  };
}
