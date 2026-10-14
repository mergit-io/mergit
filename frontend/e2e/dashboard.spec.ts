import { expect, test } from "./fixtures";

test.describe("agents", () => {
  test("adding a registry agent mints an identity and puts it on the team", async ({ page }) => {
    await page.goto("/app/agents");
    await expect(page.getByText("6 agents · identities on the L2 testnet")).toBeVisible();

    await page.getByRole("button", { name: "Add Security Auditor" }).click();
    const drawer = page.getByRole("dialog", { name: "Add Security Auditor" });
    await expect(drawer).toBeVisible();
    // Suggested permissions switch on after the drawer opens.
    await expect(drawer.getByRole("switch", { name: /Read repositories/ })).toHaveAttribute("aria-checked", "true");
    await drawer.getByLabel("Model").selectOption("Claude Opus 5.5");

    await drawer.getByRole("button", { name: "Add & mint identity" }).click();
    await expect(drawer.getByRole("button", { name: /Minting on the L2 testnet/ })).toBeDisabled();
    await expect(drawer.getByText(/Identity #0418 minted/)).toBeVisible();
    await expect(drawer).toHaveCount(0);

    await expect(page.getByText("7 agents · identities on the L2 testnet")).toBeVisible();
    await expect(page.locator(".ag-member.new")).toContainText("ID #0418 · new");
    await expect(page.getByRole("button", { name: "Add Security Auditor" })).toHaveCount(0);
    await expect(page.locator(".ag-card", { hasText: "Security Auditor" }).getByRole("status")).toHaveText(/Added/);
  });

  test("Escape closes the drawer without adding", async ({ page }) => {
    await page.goto("/app/agents");
    await page.getByRole("button", { name: "Add Data Analyst" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("6 agents · identities on the L2 testnet")).toBeVisible();
  });

  test("category, search and the verified switch filter the registry", async ({ page }) => {
    await page.goto("/app/agents");
    const names = page.locator(".ag-card h3");
    await expect(names).toHaveCount(6);
    await page.getByRole("switch", { name: "Verified only" }).click();
    await expect(names).toHaveCount(7);
    await expect(page.getByText("Unverified")).toBeVisible();

    await page.getByRole("radio", { name: "DevOps" }).click();
    await expect(names).toHaveText(["Deploy Agent", "Incident Responder", "Flaky Test Hunter"]);

    await page.getByRole("radio", { name: "All" }).click();
    await page.getByRole("searchbox", { name: "Search registry" }).fill("contracts");
    await expect(names).toHaveText(["Solidity Auditor"]);
  });
});

test.describe("proof ledger", () => {
  test("stats count up, receipts confirm, and the first opens its receipt", async ({ page }) => {
    await page.goto("/app/proofs");
    await expect(page.getByRole("heading", { name: "Proof ledger & analytics" })).toBeVisible();
    await expect(page.locator(".pl-stat-value").first()).toHaveText("1,284", { timeout: 5000 });
    await expect(page.locator(".pl-trace-row")).toHaveCount(5, { timeout: 6000 });
    await expect(page.getByText("pending")).toHaveCount(0, { timeout: 6000 });
    await page.getByRole("link", { name: /Open receipt/ }).click();
    await expect(page).toHaveURL(/\/app\/proofs\/1840$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work proof");
  });

  test("the chart shows a tooltip on hover", async ({ page }) => {
    await page.goto("/app/proofs");
    const chart = page.locator(".pl-chart svg");
    const box = await chart.boundingBox();
    if (!box) throw new Error("chart not rendered");
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator(".pl-tip")).toContainText(/Runs \d+/);
    await expect(page.locator(".pl-tip")).toContainText(/Proofs settled \d+/);
  });

  test("the runs chart redraws at phone width with readable labels", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/app/proofs");
    const label = await page.locator(".pl-axis").first().boundingBox();
    expect(label?.height).toBeGreaterThan(9);
  });

  test("the block number keeps ticking", async ({ page }) => {
    await page.goto("/app/proofs");
    const block = page.locator(".pl-block");
    const first = await block.innerText();
    await expect(block).not.toHaveText(first, { timeout: 4000 });
  });
});

test.describe("run replay", () => {
  test("the demo run plays from start to finish", async ({ page }) => {
    await page.goto("/app/runs/RUN-2048");
    await expect(page.getByText("Running…").first()).toBeVisible();
    await expect(page.getByText("0 of 6 proofs settled")).toBeVisible();
    await expect(page.getByRole("button", { name: /Proof Hashed and settled/ })).toHaveCount(0);
    // Still mid-run a moment later: the replay takes seconds, not one frame.
    await page.waitForTimeout(1500);
    await expect(page.locator(".page-head").getByText("Running…")).toBeVisible();
    expect(await page.locator(".rw-log-list li").count()).toBeLessThan(5);

    await expect(page.getByText("6 of 6 proofs settled")).toBeVisible({ timeout: 12000 });
    await expect(page.locator(".page-head").getByText("Completed")).toBeVisible();
    await expect(page.getByText("2m 14s")).toBeVisible();
    await expect(page.locator(".rw-log-list li")).toHaveCount(5);
    await expect(page.getByText("16 events, streamed")).toBeVisible();
  });

  test("the side panel fills in once its task finishes", async ({ page }) => {
    await page.goto("/app/runs/RUN-2048");
    const panel = page.getByRole("complementary", { name: /Research agent/ });
    await expect(panel.getByText("Working on it…")).toBeVisible();
    await expect(panel.getByText("Tools used")).toHaveCount(0);
    await expect(panel.getByText(/getSession\(\) returns null/)).toBeVisible({ timeout: 8000 });
    await expect(panel.getByText("Tools used")).toBeVisible();
  });

  test("reduced motion shows the finished run at once", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await ctx.addInitScript(() => {
      localStorage.setItem(
        "mergit-session",
        JSON.stringify({ address: "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b", method: "browser", since: 0 }),
      );
    });
    const page = await ctx.newPage();
    await page.goto("/app/runs/RUN-2048");
    await expect(page.getByText("6 of 6 proofs settled")).toBeVisible();
    await expect(page.locator(".rw-log-list li")).toHaveCount(5);
    await ctx.close();
  });
});
