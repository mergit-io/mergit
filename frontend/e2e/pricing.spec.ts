import { expect, test as signedIn } from "./fixtures";
import { test as signedOut } from "@playwright/test";

// Mock project: /pricing is served at the site root, never under /demo, so the dashboard is /app.
signedOut.describe("pricing, signed out", () => {
  signedOut("shows the three plans, with Premium visible but not available", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing");
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

  signedOut("has no sample prices: Premium shows none, and nothing is priced in dollars", async ({ page }) => {
    await page.goto("/pricing");
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\$\s?\d/);
    await expect(page.locator(".plan-premium .plan-amount")).toHaveText("Coming soon");
  });
});

signedIn.describe("pricing, signed in", () => {
  signedIn("Free opens the dashboard, where the plan choice starts the trial", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("link", { name: "Open dashboard" }).first()).toHaveAttribute("href", "/app");
  });
});
