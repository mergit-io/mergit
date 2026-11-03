import { expect, test } from "@playwright/test";
import { installWallet, mockBackend } from "./fake";

/**
 * A signed-out visitor's console: asking "who is signed in?" is not an error, and nothing behind the Connect window
 * asks for the signed-in user's data. A 401 is printed in red by the browser however well the app handles it, so
 * the way to keep it quiet is not to cause one.
 */

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
  await installWallet(context);
});

test("a signed-out visit makes no request the server answers with a 401", async ({ page }) => {
  const calls = await mockBackend(page, { me: null });
  const refused: string[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 401) refused.push(new URL(r.url()).pathname);
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  for (const path of ["/", "/signin", "/app", "/app/runs"]) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
  }
  await page.waitForTimeout(500);

  expect(refused).toEqual([]);
  expect(consoleErrors.filter((e) => /401/.test(e))).toEqual([]);
  // The dashboard renders behind the Connect window; it must not ask for plans nobody signed in can have.
  expect(calls.some((c) => c.path === "/v0/plans")).toBe(false);
  // It did ask who is signed in, the quiet way.
  expect(calls.some((c) => c.path === "/v0/auth/session")).toBe(true);
  expect(calls.some((c) => c.path === "/v0/auth/me")).toBe(false);
});

test("the sign-in surfaces ask which methods exist once, not once each", async ({ page }) => {
  const calls = await mockBackend(page, {
    me: null,
    providers: { wallet: true, github: true, google: true, email: true },
  });
  await page.goto("/signin");
  await expect(page.getByRole("button", { name: "Email me a code" })).toBeVisible();
  expect(calls.filter((c) => c.path === "/v0/auth/providers")).toHaveLength(1);
});

test("a remembered session the server no longer knows still ends quietly, and the dashboard stops asking", async ({
  page,
}) => {
  const calls = await mockBackend(page, { me: null });
  await page.addInitScript(() => {
    localStorage.setItem(
      "mergit-session",
      JSON.stringify({ address: "0x1111111111111111111111111111111111111111", method: "email", since: Date.now() }),
    );
  });
  await page.goto("/app");
  await expect(page.getByText(/connect to mergit/i)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mergit-session"))).toBeNull();
  expect(calls.some((c) => c.path === "/v0/auth/session")).toBe(true);
});
