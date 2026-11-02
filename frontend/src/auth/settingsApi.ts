import { apiBase } from "../chain/wallet";
import { parseUsdc, usdcText } from "../chain/funding";
import type { IdentityProvider } from "./account";

export type RoutingMode = "greedy" | "explore";
export type Funding = "credits" | "wallet";

/** The user's own defaults and limits. Amounts are USDC base units as strings, like every amount the API sends. */
export type Preferences = {
  planner_model: string | null;
  routing_mode: RoutingMode;
  max_attempts: number;
  default_funding: Funding;
  per_plan_cap_usdc_units: string | null;
  daily_cap_usdc_units: string | null;
};

export type SettingsView = {
  preferences: Preferences;
  /** The models the operator offers for drafting a plan. */
  plannerModels: string[];
  defaultPlannerModel: string;
};

export type SessionInfo = { createdAt: string; expiresAt: string; address: string; current: boolean };

type Send = (url: string, init: RequestInit) => Promise<Response>;
const defaultSend: Send = (url, init) => fetch(url, init);

const UNREACHABLE = "Mergit's API is unreachable. Check your connection and try again.";
const ENDED = "Your session has ended. Sign in again to continue.";

/** Asks the server and throws a sentence for the person; `explain` handles the statuses specific to one call. */
async function call(
  method: string,
  path: string,
  body: unknown,
  base: string,
  send: Send,
  explain: Partial<Record<number, string>>,
): Promise<Response> {
  let response: Response;
  try {
    response = await send(`${base}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (response.status === 401) throw new Error(ENDED);
  const sentence = explain[response.status];
  if (sentence) throw new Error(sentence);
  if (!response.ok) throw new Error("Mergit could not do that. Try again in a moment.");
  return response;
}

const json = (response: Response): Promise<unknown> => response.json().catch(() => null);
const notService = (what: string) => new Error(`Mergit's API did not answer like the ${what} service.`);

const MODES: readonly string[] = ["greedy", "explore"];
const FUNDINGS: readonly string[] = ["credits", "wallet"];
const units = (v: unknown): string | null => (typeof v === "string" && /^[1-9][0-9]*$/.test(v) ? v : null);

function parsePreferences(body: unknown): Preferences | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.routing_mode !== "string" || !MODES.includes(b.routing_mode)) return null;
  if (typeof b.default_funding !== "string" || !FUNDINGS.includes(b.default_funding)) return null;
  if (typeof b.max_attempts !== "number") return null;
  return {
    planner_model: typeof b.planner_model === "string" ? b.planner_model : null,
    routing_mode: b.routing_mode as RoutingMode,
    max_attempts: b.max_attempts,
    default_funding: b.default_funding as Funding,
    per_plan_cap_usdc_units: units(b.per_plan_cap_usdc_units),
    daily_cap_usdc_units: units(b.daily_cap_usdc_units),
  };
}

function parseSettings(body: unknown): SettingsView {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const preferences = parsePreferences(b.preferences);
  const models = Array.isArray(b.planner_models) ? (b.planner_models as unknown[]) : null;
  if (!preferences || !models || typeof b.default_planner_model !== "string") throw notService("settings");
  return {
    preferences,
    plannerModels: models.filter((m): m is string => typeof m === "string"),
    defaultPlannerModel: b.default_planner_model,
  };
}

export async function getSettings(base: string = apiBase(), send: Send = defaultSend): Promise<SettingsView> {
  return parseSettings(await json(await call("GET", "/v0/account/settings", undefined, base, send, {})));
}

export async function putSettings(
  preferences: Preferences,
  base: string = apiBase(),
  send: Send = defaultSend,
): Promise<SettingsView> {
  const response = await call("PUT", "/v0/account/settings", preferences, base, send, {
    422: "Mergit did not accept those settings. Check the model and the amounts, then try again.",
  });
  return parseSettings(await json(response));
}

export async function updateName(name: string, base: string = apiBase(), send: Send = defaultSend): Promise<string> {
  const response = await call("PATCH", "/v0/account/profile", { name }, base, send, {
    422: "A name is 1 to 80 characters.",
  });
  const body = (await json(response)) as { name?: unknown } | null;
  if (typeof body?.name !== "string") throw notService("profile");
  return body.name;
}

const LAST_WAY = "That is your only way to sign in. Add another sign-in method first.";

export async function removeWallet(address: string, base: string = apiBase(), send: Send = defaultSend): Promise<void> {
  await call("DELETE", `/v0/account/wallets/${address}`, undefined, base, send, {
    404: "That wallet is not on your account.",
    409: "That wallet is your only way to sign in, or a plan on it is still running. Add another sign-in method or wait for the plan to finish.",
  });
}

export async function removeIdentity(
  provider: IdentityProvider,
  base: string = apiBase(),
  send: Send = defaultSend,
): Promise<void> {
  await call("DELETE", `/v0/account/identities/${provider}`, undefined, base, send, {
    404: "That sign-in method is not on your account.",
    409: LAST_WAY,
  });
}

export async function listSessions(base: string = apiBase(), send: Send = defaultSend): Promise<SessionInfo[]> {
  const body = await json(await call("GET", "/v0/account/sessions", undefined, base, send, {}));
  if (!Array.isArray(body)) throw notService("sessions");
  return (body as Record<string, unknown>[]).flatMap((s) =>
    typeof s.created_at === "string" &&
    typeof s.expires_at === "string" &&
    typeof s.address === "string" &&
    typeof s.current === "boolean"
      ? [{ createdAt: s.created_at, expiresAt: s.expires_at, address: s.address, current: s.current }]
      : [],
  );
}

/** Signs every other device out. Returns how many sessions ended. */
export async function revokeOtherSessions(base: string = apiBase(), send: Send = defaultSend): Promise<number> {
  const body = (await json(await call("POST", "/v0/account/sessions/revoke-others", undefined, base, send, {}))) as {
    revoked?: unknown;
  } | null;
  return typeof body?.revoked === "number" ? body.revoked : 0;
}

/** Deletes the account. The word has to be typed: the server checks it too, but nothing is sent without it. */
export async function deleteAccount(
  confirm: string,
  base: string = apiBase(),
  send: Send = defaultSend,
): Promise<void> {
  if (confirm.trim().toLowerCase() !== "delete") throw new Error("Type delete to confirm.");
  await call("DELETE", "/v0/account", { confirm: "delete" }, base, send, {
    409: "A plan is approved, funded or running. Wait for it to finish, then delete the account.",
  });
}

/** A cap typed as USDC ("2.5") in base units. An empty box means no cap; anything else must be a positive amount. */
export function capFromInput(text: string): { ok: true; units: string | null } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, units: null };
  const parsed = parseUsdc(text);
  if (parsed === null || parsed <= 0n) {
    return { ok: false, error: "Enter an amount above zero, with at most six decimals." };
  }
  return { ok: true, units: parsed.toString() };
}

/** A stored cap as the box shows it: every digit, no rounding, empty for no cap. */
export const capToInput = (units: string | null): string => (units === null ? "" : usdcText(BigInt(units)));
