/** Every route in one place, so the landing page and the dashboard can't drift apart. */
const APP = "/app";

export const paths = {
  landing: "/",
  signIn: "/signin",
  app: APP,
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
