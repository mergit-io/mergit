import { expect, test } from "@playwright/test";

/**
 * The demo lives at /demo on the same site: the same bundle over sample data, signed in as the sample account, with a
 * banner saying so, and its own storage. Moving between it and the rest of the site is a full page load.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
});

test("View demo on the home page opens the demo, with no sign-in", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /View demo/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("note")).toContainText("Everything here is sample data");
  await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("every home page button that shows the demo goes to /demo", async ({ page }) => {
  await page.goto("/");
  // includeHidden: the story's hero and closing scenes are hidden until their turn, and are demo buttons too.
  const demoLinks = page.getByRole("link", { name: /View demo/, includeHidden: true });
  expect(await demoLinks.count()).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < (await demoLinks.count()); i++) {
    await expect(demoLinks.nth(i)).toHaveAttribute("href", "/demo");
  }
});

test("the demo's own links stay inside the demo", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("link", { name: "Agents" }).first().click();
  await expect(page).toHaveURL(/\/demo\/agents$/);
  await expect(page.getByRole("note")).toBeVisible();
  await page.getByRole("link", { name: "Proofs" }).first().click();
  await expect(page).toHaveURL(/\/demo\/proofs$/);
});

test("a deep link into the demo works after a reload", async ({ page }) => {
  await page.goto("/demo/agents");
  await expect(page.getByRole("note")).toContainText("sample data");
  await page.reload();
  await expect(page).toHaveURL(/\/demo\/agents$/);
  await expect(page.getByRole("note")).toBeVisible();
});

test("the banner leads home and to the real app, as page loads", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: "Use the real app" })).toHaveAttribute("href", "/app");
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("the demo keeps its own session record and never touches a real one", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "mergit-session",
      JSON.stringify({ address: "0x1111111111111111111111111111111111111111", method: "browser", since: 1 }),
    );
  });
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mergit-session"))).toContain("0x1111");
  expect(await page.evaluate(() => localStorage.getItem("mergit-demo-session"))).toBeNull();
});

test("a client-side jump across the boundary becomes a page load into the right mode", async ({ page }) => {
  await page.goto("/demo");
  // From inside the demo, a route that belongs to the real app is a reload at that address, in the real mode.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/app");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page).toHaveURL(/\/app$/);
});

test("/demonstration is not the demo", async ({ page }) => {
  await page.goto("/demonstration");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByText(/not found|404/i).first()).toBeVisible();
});
