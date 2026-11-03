import { expect, test, type Page } from "@playwright/test";
import { LIVE_ENV } from "../../playwright.config";
import { seedSession } from "../fixtures";
import { installWallet, ME, mockBackend } from "./fake";

/**
 * The real build also serves the demo, at /demo. Same bundle, sample data: it must never reach the API, the gateway,
 * the store or the chain, and it must never read or replace a real session.
 */

const BACKENDS = [LIVE_ENV.VITE_API_URL, LIVE_ENV.VITE_GATEWAY_URL, LIVE_ENV.VITE_STORE_URL, LIVE_ENV.VITE_RPC_URL];

function watchBackends(page: Page) {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (BACKENDS.some((b) => r.url().startsWith(b))) hits.push(`${r.method()} ${r.url()}`);
  });
  return hits;
}

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
  await installWallet(context);
  await mockBackend(page, { me: null });
});

test("the demo shows sample data and calls no backend at all", async ({ page }) => {
  const hits = watchBackends(page);
  await page.goto("/demo");
  await expect(page.getByRole("note")).toContainText("Everything here is sample data");
  await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
  await page.getByRole("link", { name: "Agents" }).first().click();
  await expect(page).toHaveURL(/\/demo\/agents$/);
  await page.getByRole("link", { name: "Proofs" }).first().click();
  await expect(page).toHaveURL(/\/demo\/proofs$/);
  expect(hits).toEqual([]);
});

test("a signed-in real user sees the demo as the sample account and keeps their own session", async ({
  page,
  context,
}) => {
  await seedSession(context, ME);
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("mergit-session"));
  expect(stored).toContain(ME);
});

test("the real app at /app is not the demo", async ({ page, context }) => {
  await seedSession(context, ME);
  await page.goto("/app");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toHaveCount(0);
});

test("View demo on the live home page goes to /demo; Get started still opens the real sign-in", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /View demo/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("note")).toBeVisible();
  await page.goto("/");
  await page
    .getByRole("button", { name: /Get started/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("leaving the demo for the real app starts the real mode", async ({ page, context }) => {
  await seedSession(context, ME);
  await page.goto("/demo");
  await page.getByRole("link", { name: "Use the real app" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("note")).toHaveCount(0);
});
