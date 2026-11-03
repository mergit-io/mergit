import { expect, test } from "@playwright/test";
import { installWallet, ME, mockBackend, type Backend } from "./fake";

/** Settings on live data: what a signed-in user can change, and what the app sends to make it so. */

const TRIAL = "0x9999999999999999999999999999999999999999";
const WALLET = ME.toLowerCase();
const account = {
  address: WALLET,
  user_id: "u1",
  name: "Octo Cat",
  email: "octo@example.com",
  avatar_url: null,
  identities: [{ provider: "github", label: "octo" }],
  wallets: [WALLET],
  trial_address: TRIAL,
  trial: null,
};
const providers = { wallet: true, github: true, google: true, email: false };

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
  await installWallet(context);
});

const open = async (page: Parameters<typeof mockBackend>[0], b: Backend = {}) => {
  const calls = await mockBackend(page, { me: { ...account }, providers, ...b });
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  return calls;
};

test("the account menu opens Settings", async ({ page }) => {
  await mockBackend(page, { me: { ...account }, providers });
  await page.goto("/app");
  await page.getByRole("button", { name: /Account, signed in as/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
});

test("the name can be changed", async ({ page }) => {
  const calls = await open(page);
  await page.getByLabel("Display name").fill("Yash V");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Name saved.")).toBeVisible();
  expect(calls.find((c) => c.path === "/v0/account/profile")?.body).toEqual({ name: "Yash V" });
});

test("preferences and spend limits are saved as USDC base units", async ({ page }) => {
  const calls = await open(page);
  await page.getByLabel("Model that drafts your plans").selectOption("claude-sonnet-5");
  await page.getByRole("radio", { name: "explore" }).click();
  await page.getByRole("radio", { name: "3" }).click();
  await page.getByLabel("Per plan (USDC)").fill("2.5");
  await page.getByLabel("Per 24 hours (USDC)").fill("10");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved.")).toBeVisible();
  const saved = calls.filter((c) => c.path === "/v0/account/settings").at(-1)?.body;
  expect(saved).toEqual({
    planner_model: "claude-sonnet-5",
    routing_mode: "explore",
    max_attempts: 3,
    default_funding: "credits",
    per_plan_cap_usdc_units: "2500000",
    daily_cap_usdc_units: "10000000",
  });
});

test("a limit that is not an amount is refused before anything is sent", async ({ page }) => {
  const calls = await open(page);
  await page.getByLabel("Per plan (USDC)").fill("lots");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "amount above zero" })).toBeVisible();
  expect(calls.some((c) => c.path === "/v0/account/settings" && c.body !== null)).toBe(false);
});

test("a wallet can be removed, and the list follows", async ({ page }) => {
  const calls = await open(page);
  await page.getByRole("button", { name: /Remove wallet/ }).click();
  await expect(page.getByText("Wallet removed.")).toBeVisible();
  expect(calls.some((c) => c.path === `/v0/account/wallets/${WALLET}`)).toBe(true);
  await expect(page.getByText("No wallet is connected.")).toBeVisible();
});

test("the server's refusal to remove the last way in is shown in words", async ({ page }) => {
  await open(page, { settingsRefusal: 409 });
  await page.getByRole("button", { name: "Remove GitHub sign-in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "only way to sign in" })).toBeVisible();
});

test("Link Google is offered when Google is set up and not yet linked, and GitHub is not", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("link", { name: "Link Google" })).toHaveAttribute(
    "href",
    "http://api.test/v0/auth/google/start?intent=register",
  );
  await expect(page.getByRole("link", { name: "Link GitHub" })).toHaveCount(0);
});

test("other devices can be signed out, this one stays", async ({ page }) => {
  const now = "2026-11-01T10:00:00+00:00";
  const later = "2026-12-01T10:00:00+00:00";
  await open(page, {
    sessions: [
      { created_at: now, expires_at: later, address: WALLET, current: true },
      { created_at: "2026-10-30T08:00:00+00:00", expires_at: later, address: WALLET, current: false },
    ],
  });
  await page.getByRole("button", { name: "Sign out other devices" }).click();
  await expect(page.getByText("Signed out 1 other device.")).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();
});

test("deleting needs the word, then signs out", async ({ page }) => {
  const calls = await open(page);
  const button = page.getByRole("button", { name: "Delete my account" });
  await expect(button).toBeDisabled();
  await page.getByLabel("Type delete to confirm").fill("delete");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const sent = calls.find((c) => c.path === "/v0/account");
  expect(sent?.body).toEqual({ confirm: "delete" });
});

test("a plan in flight blocks deletion and the account stays", async ({ page }) => {
  await open(page, { settingsRefusal: 409 });
  await page.getByLabel("Type delete to confirm").fill("delete");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "approved, funded or running" })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings$/);
});

test("the page fits a phone with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
