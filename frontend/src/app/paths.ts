import { IN_DEMO } from "../config/live";
import { appBase } from "../config/mode";
import { agentPath } from "./agentRoute";

/** Every route in one place, so the landing page and the dashboard can't drift apart. */
const APP = appBase(IN_DEMO);

export const paths = {
  landing: "/",
  signIn: "/signin",
  pricing: "/pricing",
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
  /** An agent's public profile, under its full ENS name. Public and live only, so never under the demo's base. */
  agent: (label: string) => agentPath(label),
  /** The public final-ledger page. Only the bare path: /ledger/<name>.json are the snapshot files themselves. */
  ledger: "/ledger",
  proofs: `${APP}/proofs`,
  proof: (id: string) => `${APP}/proofs/${id}`,
  leaderboard: `${APP}/leaderboard`,
  integrations: `${APP}/integrations`,
  wallet: `${APP}/wallet`,
  settings: `${APP}/settings`,
} as const;
