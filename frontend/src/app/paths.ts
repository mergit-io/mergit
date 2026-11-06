import { IN_DEMO } from "../config/live";
import { appBase } from "../config/mode";

/** Every route in one place, so the landing page and the dashboard can't drift apart. */
const APP = appBase(IN_DEMO);

export const paths = {
  landing: "/",
  signIn: "/signin",
  pricing: "/pricing",
  /** An agent's public profile, outside the session gate: the URL its ENS `agent-endpoint[web]` record names. */
  agentProfile: (label: string) => `/agents/${encodeURIComponent(label)}`,
  agentProfileRoute: "/agents/:label",
  app: APP,
  /** The demo and the real app are different page loads, so these two never depend on where this page is. */
  demo: "/demo",
  liveApp: "/app",
  runs: `${APP}/runs`,
  newRun: `${APP}/runs/new`,
  run: (id: string) => `${APP}/runs/${id}`,
  /** The new-run form, filled in from an earlier plan that ended closed or failed. */
  startAgain: (id: string) => `${APP}/runs/new?from=${encodeURIComponent(id)}`,
  agents: `${APP}/agents`,
  proofs: `${APP}/proofs`,
  proof: (id: string) => `${APP}/proofs/${id}`,
  leaderboard: `${APP}/leaderboard`,
  integrations: `${APP}/integrations`,
  wallet: `${APP}/wallet`,
  settings: `${APP}/settings`,
} as const;
