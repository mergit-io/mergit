import type { IdentityProvider } from "./account";

/** What the account that already has the wallet holds, as the server describes it before anyone confirms. */
export type OtherAccount = {
  identities: { provider: IdentityProvider; label: string }[];
  wallets: number;
  plans: number;
  trialStarted: boolean;
};

export type WalletTakenOffer = { token: string; other: OtherAccount };

/** The wallet is on another account: the person must choose whether to merge it into this one. */
export class WalletTakenError extends Error {
  readonly offer: WalletTakenOffer;
  constructor(offer: WalletTakenOffer) {
    super("That wallet already has its own Mergit account.");
    this.name = "WalletTakenError";
    this.offer = offer;
  }
}

const PROVIDERS = ["github", "google", "email"];

/** The body of a 409 from linking a wallet, or null when it is some other conflict. */
export function parseWalletTaken(body: unknown): WalletTakenOffer | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (d.code !== "wallet_taken" || typeof d.merge_token !== "string" || d.merge_token === "") return null;
  const o = (d.other && typeof d.other === "object" ? d.other : {}) as Record<string, unknown>;
  const identities = (Array.isArray(o.identities) ? (o.identities as unknown[]) : []).flatMap((i) => {
    if (!i || typeof i !== "object") return [];
    const { provider, label } = i as Record<string, unknown>;
    return typeof provider === "string" && PROVIDERS.includes(provider) && typeof label === "string"
      ? [{ provider: provider as IdentityProvider, label }]
      : [];
  });
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    token: d.merge_token,
    other: { identities, wallets: count(o.wallets), plans: count(o.plans), trialStarted: o.trial_started === true },
  };
}

const NAMES: Record<IdentityProvider, string> = { github: "GitHub", google: "Google", email: "email" };
const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? "" : "s"}`;

/** A sentence about what is being merged in, so the person can tell whether it is really their other account. */
export function describeOther(other: OtherAccount): string {
  const via = other.identities.map((i) => `${NAMES[i.provider]} (${i.label})`);
  const holds = [
    plural(other.wallets, "wallet"),
    ...(other.plans > 0 ? [plural(other.plans, "run")] : []),
    ...(other.trialStarted ? ["a started free trial"] : []),
  ];
  if (via.length === 0 && other.wallets <= 1 && other.plans === 0 && !other.trialStarted) {
    return "It has only this wallet and no runs.";
  }
  if (via.length === 0 && !other.trialStarted && other.plans === 0)
    return `It holds ${plural(other.wallets, "wallet")}.`;
  const list = (items: string[]) =>
    items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}` : (items[0] ?? "");
  const created = via.length > 0 ? `It was created with ${list(via)} and holds ` : "It holds ";
  return `${created}${list(holds)}.`;
}
