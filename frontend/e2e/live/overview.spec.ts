import { expect, test } from "@playwright/test";
import { seedSession } from "../fixtures";
import { installWallet, mockBackend } from "./fake";
import { draftPlan, mockPlanApi } from "./plans";

// Not the demo account (0x6E2d…9A0b): a signed-in wallet of its own, so a leak of the sample identity is visible.
const USER = "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D";

test.beforeEach(async ({ page, context }) => {
  await seedSession(context, USER);
  await installWallet(context);
  await mockBackend(page, {
    ethWei: 25n * 10n ** 16n,
    usdcUnits: 12_500_000n,
    credits: { granted: "5000000", spent: "1000000", remaining: "4000000", plans_today: 1 },
  });
  await mockPlanApi(page, { plans: [draftPlan()] });
});

test("the shell shows the signed-in wallet and none of the demo identity", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText("0x1725…585D");
  await expect(page.getByRole("button", { name: /^Account, signed in as/ })).toContainText("17");
  const body = page.locator("body");
  await expect(body).not.toContainText("Alex");
  await expect(body).not.toContainText("acme/billing");
  await expect(body).not.toContainText("0x6E2d");
});

test("pages with no real data behind them are not offered", async ({ page }) => {
  await page.goto("/app");
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Overview", "Runs", "Agents", "Proofs", "Leaderboard"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await page.goto("/app/integrations");
  await expect(page).toHaveURL(/\/app$/);
});

test("the leaderboard on live data is the ENS mirror, labelled as counts and not a score", async ({ page }) => {
  await page.goto("/app/leaderboard");
  await expect(page).toHaveURL(/\/app\/leaderboard$/);
  await expect(page.getByTestId("mirror-label")).toContainText("not a score");
});

test("the overview shows real credits, balances and runs", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByTestId("credits-remaining")).toHaveText("4.00");
  await expect(page.getByTestId("usdc-balance")).toHaveText("12.50");
  await expect(page.getByTestId("run-count")).toHaveText("1");
  await expect(page.getByTestId("receipt-count")).toHaveText("0");
  await expect(page.getByText("No receipts committed yet.")).toBeVisible();
});

test("the agents page lists the deployed agents with their on-chain operator", async ({ page }) => {
  await page.goto("/app/agents");
  const rows = page.locator("tbody tr");
  await expect(rows).not.toHaveCount(0);
  await expect(rows.first()).toContainText("0x1111…1111");
});

test("the live header offers no control that is not wired up: no Search, no Notifications bell", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Notifications/ })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("not wired up");
});
