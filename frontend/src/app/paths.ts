import { IN_DEMO } from "../config/live";
import { appBase } from "../config/mode";

/** Every route in one place, so the landing page and the dashboard can't drift apart. */
const APP = appBase(IN_DEMO);

export const paths = {
  landing: "/",
  signIn: "/signin",
  app: APP,
  /** The demo and the real app are different page loads, so these two never depend on where this page is. */
  demo: "/demo",
  liveApp: "/app",
  runs: `${APP}/runs`,
  newRun: `${APP}/runs/new`,
  run: (id: string) => `${APP}/runs/${id}`,
  agents: `${APP}/agents`,
  proofs: `${APP}/proofs`,
  proof: (id: string) => `${APP}/proofs/${id}`,
  leaderboard: `${APP}/leaderboard`,
  integrations: `${APP}/integrations`,
  wallet: `${APP}/wallet`,
} as const;
