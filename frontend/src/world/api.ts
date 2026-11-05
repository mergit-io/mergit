import { base } from "../api/client";

/** Resolves a relative URL the API handed the browser (`start_url` in the `human_approval_required` body)
 * against that same base, so it is never opened as a bare path. */
export function resolveApiUrl(path: string): string {
  return `${base()}${path}`;
}

export type ApprovalStatus = {
  status: string;
  reason: string | null;
  expires_at: string;
};

/** `GET /v0/world/config`'s `idkit` object (`routes_world.world_config`): public, no session required.
 * `rp_id` and `environment` are not part of today's response — only `enabled`, `app_id`, `action` and
 * `preset` are (checked against `test_config_exposes_only_public_values`) — but are read here anyway,
 * defensively, against a future response that adds them: IDKit's own `RpContext.rp_id` is required and
 * strictly validated (`rp_<16 hex>`), so `TrialVerify` only renders the live widget once one is present;
 * see its module docstring. */
export type IdkitConfig = {
  enabled: boolean;
  /** IDKit's own app-id shape (`` `app_${string}` ``), checked rather than just typed: a config that failed
   * this is treated as unparseable (same as a missing field), never coerced. */
  app_id: `app_${string}`;
  action: string;
  preset: "selfie_check" | "proof_of_human";
  rp_id: string | null;
  environment: "production" | "staging" | "sandbox" | null;
};

export type WorldConfig = { idkit: IdkitConfig; agentPassEnabled: boolean };

function parseIdkitConfig(raw: unknown): IdkitConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const { enabled, app_id, action, preset, rp_id, environment } = raw as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof app_id !== "string" || !app_id.startsWith("app_")) return null;
  if (typeof action !== "string") return null;
  if (preset !== "selfie_check" && preset !== "proof_of_human") return null;
  return {
    enabled,
    app_id: app_id as `app_${string}`,
    action,
    preset,
    rp_id: typeof rp_id === "string" ? rp_id : null,
    environment: environment === "production" || environment === "staging" || environment === "sandbox" ? environment : null,
  };
}

let worldConfig: Promise<WorldConfig | null> | null = null;

/** Forgets the remembered answer (tests; a failed answer forgets itself — same shape as `fetchProviders`). */
export function resetWorldConfigCache(): void {
  worldConfig = null;
}

/** The World ID setup the server has, asked once per page and shared (the plan choice dialog is the only
 * caller today, but a reload or a second mount must not ask twice). A failure, or a body that does not look
 * like `world_config`'s shape, is treated the same as "not configured" -- `TrialVerify` is never rendered and
 * the plain "Start free" button (unchanged) is what the person sees either way. */
export function fetchWorldConfig(): Promise<WorldConfig | null> {
  worldConfig ??= (async (): Promise<WorldConfig | null> => {
    try {
      const response = await fetch(resolveApiUrl("/v0/world/config"), { credentials: "include" });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      const idkit = parseIdkitConfig(body.idkit);
      if (!idkit) return null;
      const agentPass = body.agent_pass as Record<string, unknown> | undefined;
      return { idkit, agentPassEnabled: agentPass?.enabled === true };
    } catch {
      return null;
    }
  })().then((answer) => {
    if (answer === null) worldConfig = null;
    return answer;
  });
  return worldConfig;
}

/** `POST /v0/world/rp-context`'s body (`routes_world.rp_context` → `RpContext.to_json()`): the field names
 * are World's own (`sig`, not `signature` -- IDKit's browser SDK calls the same thing `signature`, see
 * `TrialVerify`), signed fresh for `action` and good for a few minutes. Session-cookie auth. */
export type RpContextResponse = {
  sig: string;
  nonce: string;
  created_at: number;
  expires_at: number;
};

/** Asks for a freshly signed RP context for the free trial's World ID check. Thrown messages are not shown
 * verbatim to the person (`TrialVerify` wraps this); they exist so a caught failure here is distinguishable
 * from one IDKit itself raised. */
export async function fetchRpContext(action: string): Promise<RpContextResponse> {
  let response: Response;
  try {
    response = await fetch(resolveApiUrl("/v0/world/rp-context"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch {
    throw new Error("Mergit's API is unreachable. Check your connection and try again.");
  }
  if (response.status === 401) throw new Error("Your session has ended. Sign in again to continue.");
  if (!response.ok) throw new Error(`Mergit answered ${String(response.status)} signing a World ID request.`);
  const body = (await response.json().catch(() => null)) as Partial<RpContextResponse> | null;
  if (
    typeof body?.sig !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.created_at !== "number" ||
    typeof body.expires_at !== "number"
  ) {
    throw new Error("Mergit's API did not answer like the World ID signing service.");
  }
  return { sig: body.sig, nonce: body.nonce, created_at: body.created_at, expires_at: body.expires_at };
}

/** Polled while the popup cannot `postMessage` back to its opener (plan sec 1.7): session-cookie auth,
 * owner only. Anything other than `"pending"` is terminal. */
export async function getApprovalStatus(approvalId: string): Promise<ApprovalStatus> {
  const response = await fetch(resolveApiUrl(`/v0/world/approvals/${encodeURIComponent(approvalId)}`), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Mergit answered ${String(response.status)} checking the World approval.`);
  }
  return (await response.json()) as ApprovalStatus;
}
