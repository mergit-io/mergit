import { expect, test, type Page } from "@playwright/test";

const session = (page: Page) => page.evaluate(() => localStorage.getItem("mergit-session"));

test.describe("landing page", () => {
  test("the intro hands over to the hero, and a click skips it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".intro")).toBeVisible();
    await expect(page.getByText("settled on chain.")).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.locator(".intro")).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("AI agents that do real work.");
    // Once seen, the intro stays out of the way for the rest of the session.
    await page.reload();
    await expect(page.locator(".intro")).toHaveCount(0);
  });

  test("reduced motion skips the intro and shows everything", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator(".intro")).toHaveCount(0);
    await expect(page.locator(".agent-step").last()).toHaveCSS("opacity", "1");
    await ctx.close();
  });

  test("sections animate in and the demos respond", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("mergit-intro-seen", "1");
    });
    await page.goto("/");
    await page.locator("#how-it-works").scrollIntoViewIfNeeded();
    await expect(page.locator(".how-chip").last()).toContainText("Artifact → hash → settled proof", { timeout: 6000 });

    await page.getByRole("heading", { name: "Autonomy with a clear stop sign." }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("switch", { name: "Opening a pull request" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: /Approve action/ }).click();
    await expect(page.locator(".approval-buttons [role=status]")).toHaveText(/Signed by 0x6E2d/);
    await page.getByRole("button", { name: /Deny/ }).click();
    await expect(page.locator(".approval-buttons [role=status]")).toHaveText(/Denied/);

    const faq = page.locator("details").first();
    await expect(faq).toHaveAttribute("open", "");
    await faq.locator("summary").click();
    await expect(faq).not.toHaveAttribute("open", "");
  });

  test("renders in both themes with no errors and no stale terms", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/");
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(colorScheme);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/Monad|soulbound|passport|proof of work/i);
      expect(errors).toEqual([]);
      await ctx.close();
    }
  });

  for (const width of [360, 390]) {
    test(`the hero lays out as one column on a ${String(width)}px phone`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(() => {
        sessionStorage.setItem("mergit-intro-seen", "1");
      });
      await page.goto("/");
      const box = async (selector: string) => {
        const b = await page.locator(selector).first().boundingBox();
        if (!b) throw new Error(`${selector} has no box`);
        return b;
      };
      const title = await box(".l-hero-title");
      const card = await box(".agent-card");
      // The card sits in the same column as the copy, not bled out to the screen edge.
      expect(Math.abs(card.x - title.x), "card and title share a left edge").toBeLessThanOrEqual(1);
      expect(card.x + card.width).toBeLessThanOrEqual(width);

      // The globe stays clear of the copy above the card.
      const notes = await box(".l-hero-notes");
      const globe = await box(".l-hero-globe");
      expect(globe.y, "globe starts below the hero notes").toBeGreaterThanOrEqual(notes.y + notes.height);

      // The two hero buttons stack at one width.
      const [demo, how] = await page
        .locator(".l-hero-actions > *")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
      expect(demo).toBe(how);
    });
  }

  // The page clips sideways overflow, so a too-wide card is cut off rather than scrollable; check every box.
  for (const width of [320, 390, 768]) {
    test(`no landing content runs off a ${String(width)}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(() => {
        sessionStorage.setItem("mergit-intro-seen", "1");
      });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const spills = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll(".landing *"))
          .filter((el) => !el.closest(".l-hero-globe, .proof-chain, svg"))
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && (box.right > vw + 0.5 || box.left < -0.5);
          })
          .map((el) => `${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")}`);
      });
      expect(spills).toEqual([]);
    });
  }
});

test.describe("sign in", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("mergit-intro-seen", "1");
    });
  });

  test("Get started connects a wallet and opens the dashboard", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: /Get started/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/app$/);
    const dialog = page.getByRole("dialog", { name: "Connect to Mergit" });
    await expect(dialog).toBeVisible();
    // The dashboard behind the window is locked.
    await expect(page.locator(".app-gate-content")).toHaveAttribute("inert", "");

    await dialog.getByRole("button", { name: /Browser wallet/ }).click();
    await expect(dialog.getByRole("status")).toHaveText(/Waiting for signature/);
    await expect(dialog.getByRole("status")).toHaveText(/Connected · 0x6E2d…9A0b/);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
    expect(await session(page)).toContain("0x6E2d");
  });

  test("Escape closes the Connect window and returns to the landing page", async ({ page }) => {
    await page.goto("/app/agents");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
    expect(await session(page)).toBeNull();
  });

  test("Sign out ends the session and locks the dashboard again", async ({ page }) => {
    // Seed once (an init script would sign back in on every navigation).
    await page.goto("/signin");
    await page.evaluate(() => {
      localStorage.setItem(
        "mergit-session",
        JSON.stringify({ address: "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b", method: "browser", since: 0 }),
      );
    });
    await page.goto("/app");
    await page.getByRole("button", { name: /Account/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    // The brand splash covers the dashboard first, then hands over to the landing page.
    const splash = page.getByRole("status", { name: "Signing out" });
    await expect(splash).toBeVisible();
    await expect(splash).toContainText("Real work. Verifiable proof.");
    await expect(page).toHaveURL(/\/app$/);
    await expect(page).toHaveURL(/\/$/);
    await expect(splash).toHaveCount(0);
    expect(await session(page)).toBeNull();
    await page.goto("/app");
    await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toBeVisible();
  });

  test("the sign-in page signs in with an account or opens the wallet window", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Continue with wallet" }).click();
    await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toBeVisible();

    await page.goto("/signin");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await session(page)).toContain('"method":"github"');
  });

  test("the landing nav offers the dashboard once signed in", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "mergit-session",
        JSON.stringify({ address: "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b", method: "browser", since: 0 }),
      );
    });
    await page.goto("/");
    const open = page.getByRole("link", { name: /Open dashboard/ });
    // The label must not take the pill's own colour.
    const [color, background] = await open.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor];
    });
    expect(color).not.toBe(background);
    await open.click();
    await expect(page).toHaveURL(/\/app$/);
  });

  test("the Connect window fits a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Get started" }).first().click();
    const box = await page.getByRole("dialog").boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
  });
});
