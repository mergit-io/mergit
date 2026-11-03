import { expect, test as signedIn } from "./fixtures";
import { test as signedOut } from "@playwright/test";

// The limits are the gateway defaults in src/pricing/plans.ts; e2e is a separate TypeScript project, so it spells them.
// Mock project: /pricing is served at the site root, never under /demo, so the dashboard is /app.
signedOut.describe("pricing, signed out", () => {
  signedOut("shows the three plans, with Premium visible but not available", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing");
    // Headings go h1, then an h2 for each section, then the cards' h3.
    await expect(page.getByRole("heading", { level: 2, name: "Plans", exact: true })).toBeAttached();
    for (const name of ["Free", "Premium", "Pay as you go"])
      await expect(page.getByRole("heading", { level: 3, name })).toBeVisible();
    await expect(page.getByText("5 USDC", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Coming soon" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/signin");
  });

  signedOut("compares the plans in a table with a column each", async ({ page }) => {
    await page.goto("/pricing");
    const table = page.getByRole("table", { name: "What each plan includes" });
    await expect(table.locator("thead").getByRole("columnheader")).toHaveText([
      "Feature",
      "Free",
      "Premium",
      "Pay as you go",
    ]);
    await expect(table.getByRole("row", { name: /Wallet needed/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Plans per day/ })).toContainText("3");
  });

  signedOut("scrolls the table by keyboard, and shows Premium as soon in every row", async ({ page }) => {
    await page.goto("/pricing");
    const region = page.getByRole("region", { name: "Plan comparison table" });
    await expect(region).toHaveAttribute("tabindex", "0");
    const premium = region.locator("tbody tr:not(.pr-group) td:nth-child(3)");
    for (const cell of await premium.all()) await expect(cell).toContainText("Soon");
  });

  signedOut("Pay as you go leads to connecting a wallet", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "Connect a wallet" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toBeVisible();
  });

  signedOut("has no sample prices: Premium shows none, and nothing is priced in dollars", async ({ page }) => {
    await page.goto("/pricing");
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\$\s?\d/);
    await expect(page.locator(".plan-premium .plan-amount")).toHaveText("Coming soon");
  });
});

signedIn.describe("pricing, signed in", () => {
  // The plan choice that starts the trial is the dialog over the dashboard, covered in live/account.spec.ts.
  signedIn("Free links to the dashboard, and Pay as you go still offers a wallet", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("link", { name: "Open dashboard" }).first()).toHaveAttribute("href", "/app");
    await expect(page.getByRole("button", { name: "Connect a wallet" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Coming soon" })).toBeDisabled();
  });
});
