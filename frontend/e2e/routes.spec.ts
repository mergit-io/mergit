import { expect, test } from "./fixtures";

const ROUTES: [string, string, string | null][] = [
  ["/app", "Good morning, Alex", "Overview"],
  ["/app/runs/RUN-2048", "Fix authentication bug", "Runs"],
  ["/app/runs/new", "Describe the outcome, not the steps", "Runs"],
  ["/app/agents", "Agents", "Agents"],
  ["/app/proofs", "Proof ledger & analytics", "Proofs"],
  ["/app/proofs/1840", "Work proof", "Proofs"],
  ["/app/leaderboard", "Leaderboard", "Leaderboard"],
  ["/app/integrations", "Integrations", "Integrations"],
  ["/app/wallet", "Wallet and identity", null],
  ["/signin", "AI agents that do real work.", null],
];

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    for (const [path, heading, tab] of ROUTES) {
      test(`${path} renders`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        if (tab)
          await expect(page.getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
        expect(errors).toEqual([]);
      });
    }
  });
}

for (const width of [320, 390]) {
  test(`no page scrolls sideways at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, heading] of ROUTES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(0);
    }
  });
}

test("integration cards keep their contents inside on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/app/integrations");
  const spills = await page.locator(".in-app").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const box = card.getBoundingClientRect();
      return Array.from(card.querySelectorAll("*"))
        .filter((el) => el.getBoundingClientRect().right > box.right + 0.5)
        .map((el) => el.textContent.trim() || el.tagName);
    }),
  );
  expect(spills).toEqual([]);
});

test("the runs tab opens the demo run", async ({ page }) => {
  await page.goto("/app/runs");
  await expect(page).toHaveURL(/\/runs\/RUN-2048$/);
});

test("design copy uses the current protocol terms", async ({ page }) => {
  for (const path of [
    "/",
    "/app",
    "/app/runs/RUN-2048",
    "/app/proofs/1840",
    "/app/wallet",
    "/app/agents",
    "/app/leaderboard",
  ]) {
    await page.goto(path);
    const text = await page.locator("body").innerText();
    expect(text, path).not.toMatch(/Monad|AgentPassport|ProofOfWork|proof of work|passport/i);
    // Case-sensitive: "Mon" is a weekday label on the overview chart.
    expect(text, path).not.toMatch(/\bMON\b/);
  }
});

test("run filters and approvals respond", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("radio", { name: "Failed" }).click();
  await expect(page.getByRole("link", { name: /Code review for PR #134/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Fix authentication bug/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByText("1 waiting")).toBeVisible();
});

test("selecting a flow node updates the side panel", async ({ page }) => {
  await page.goto("/app/runs/RUN-2048");
  await page.getByRole("button", { name: /Coder Patched session check/ }).click();
  await expect(page.getByRole("heading", { name: "Code agent" })).toBeVisible();
});

test("segmented controls follow the radio-group keyboard pattern", async ({ page }) => {
  await page.goto("/app");
  const all = page.getByRole("radio", { name: "All" });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  const running = page.getByRole("radio", { name: "Running" });
  await expect(running).toHaveAttribute("aria-checked", "true");
  await expect(running).toBeFocused();
  await expect(page.getByRole("link", { name: /Implement CSV import validation/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Fix authentication bug/ })).toHaveCount(0);
});

test("buttons without a backend say so instead of doing nothing", async ({ page }) => {
  await page.goto("/app/wallet");
  await page.getByRole("button", { name: "Fund wallet" }).click();
  await expect(page.getByRole("status")).toHaveText("Needs the backend, not wired up yet");
});
