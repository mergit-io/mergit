import { defineConfig, devices } from "@playwright/test";

// Set PLAYWRIGHT_CHANNEL=chrome to run against an installed Chrome instead of
// the bundled Chromium (`npx playwright install chromium`).
const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5173",
    // The design is drawn at 1440 x 900.
    viewport: { width: 1440, height: 900 },
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
