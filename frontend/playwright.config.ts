import { defineConfig, devices } from "@playwright/test";

// Set PLAYWRIGHT_CHANNEL=chrome to run against an installed Chrome instead of
// the bundled Chromium (`npx playwright install chromium`), or PLAYWRIGHT_CHROME_PATH to a Chrome binary
// (needed on NixOS, where the bundled Chromium cannot start).
const channel = process.env.PLAYWRIGHT_CHANNEL;
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;

/** Live mode under test talks to fake hosts that the specs intercept; nothing leaves the machine. */
export const LIVE_ENV = {
  VITE_DATA_MODE: "live",
  VITE_API_URL: "http://api.test",
  VITE_GATEWAY_URL: "http://gateway.test",
  VITE_STORE_URL: "http://store.test",
  VITE_RPC_URL: "http://rpc.test",
  VITE_CHAIN_ID: "84532",
  VITE_CHAIN_NAME: "Base Sepolia",
  VITE_DEPLOY_BLOCK: "1",
  VITE_USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  VITE_ESCROW: "0x00000000000000000000000000000000000000e5",
  // The registry in the EIP-712 domain of the receipts in spec/vectors: their signatures only verify against it.
  VITE_RECEIPT_REGISTRY: "0x0000000000000000000000000000000000000001",
  VITE_IDENTITY: "0x00000000000000000000000000000000000000d1",
  // ENS answers come from fixed chain fixtures (src/chain/ens/stubClients.ts) that still go through the real two-way
  // check, one agent per outcome; nothing reaches a real mainnet RPC.
  VITE_ENS_READER: "stub",
  VITE_ENS_RPC_URL: "http://mainnet.test",
};

const shared = {
  ...devices["Desktop Chrome"],
  // The design is drawn at 1440 x 900.
  viewport: { width: 1440, height: 900 },
  ...(channel ? { channel } : {}),
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  projects: [
    { name: "mock", testIgnore: /live\//, use: { ...shared, baseURL: "http://localhost:5173" } },
    { name: "live", testMatch: /live\/.*\.spec\.ts/, use: { ...shared, baseURL: "http://localhost:5174" } },
  ],
  webServer: [
    { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI },
    {
      command: "npx vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: !process.env.CI,
      env: LIVE_ENV,
    },
  ],
});
