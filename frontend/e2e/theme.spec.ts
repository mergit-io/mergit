import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { seedSession } from "./fixtures";

const LIGHT_CANVAS = "rgb(244, 245, 247)";
const DARK_CANVAS = "rgb(11, 12, 15)";

const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const canvasOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("mergit-theme"));
const toggle = (page: Page) => page.getByRole("button", { name: /Switch to (light|dark) mode/ });

async function settle(page: Page) {
  // A view transition is "active" from the moment it is requested, before its
  // update callback runs, so this cannot pass early the way polling animations can.
  await page.waitForFunction(
    () =>
      !document.documentElement.matches(":active-view-transition") &&
      !document.documentElement.classList.contains("theme-fade"),
  );
}

test.describe("first paint", () => {
  test("opens in light on a first visit even when the OS is dark", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    await seedSession(ctx);
    const page = await ctx.newPage();
    // Record the theme at the moment the boot script finishes, before React mounts.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        (window as unknown as { __firstTheme?: string }).__firstTheme = document.documentElement.dataset.theme;
      });
    });
    await page.goto("/app");
    expect(await page.evaluate(() => (window as unknown as { __firstTheme?: string }).__firstTheme)).toBe("light");
    expect(await canvasOf(page)).toBe(LIGHT_CANVAS);
    await ctx.close();
  });

  test("a saved dark choice is honoured on the next visit", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    await seedSession(ctx);
    await ctx.addInitScript(() => {
      localStorage.setItem("mergit-theme", "dark");
    });
    const page = await ctx.newPage();
    await page.goto("/app");
    expect(await themeOf(page)).toBe("dark");
    expect(await canvasOf(page)).toBe(DARK_CANVAS);
    await ctx.close();
  });
});

test.describe("toggle", () => {
  test.use({ colorScheme: "light" });

  test("switches theme, swaps the icon label and survives a reload", async ({ page }) => {
    await page.goto("/app");
    await expect(toggle(page)).toHaveAccessibleName("Switch to dark mode");
    await toggle(page).click();
    await settle(page);
    expect(await themeOf(page)).toBe("dark");
    expect(await canvasOf(page)).toBe(DARK_CANVAS);
    await expect(toggle(page)).toHaveAccessibleName("Switch to light mode");
    expect(await stored(page)).toBe("dark");

    await page.reload();
    expect(await themeOf(page)).toBe("dark");
    expect(await canvasOf(page)).toBe(DARK_CANVAS);
  });

  test("picking light again clears the override", async ({ page }) => {
    await page.goto("/app");
    await toggle(page).click();
    await settle(page);
    expect(await stored(page)).toBe("dark");
    await toggle(page).click();
    await settle(page);
    expect(await themeOf(page)).toBe("light");
    expect(await stored(page)).toBeNull();
  });

  test("works with reduced motion and does not start a view transition", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light", reducedMotion: "reduce" });
    await seedSession(ctx);
    const page = await ctx.newPage();
    await page.goto("/app");
    await page.evaluate(() => {
      const w = window as unknown as { __vt: number };
      w.__vt = 0;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = ((cb: () => void) => {
        w.__vt++;
        return original(cb);
      }) as typeof document.startViewTransition;
    });
    await toggle(page).click();
    expect(await themeOf(page)).toBe("dark");
    expect(await page.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
    await ctx.close();
  });

  test("the toggle is on the sign-in page too", async ({ page }) => {
    await page.goto("/signin");
    await toggle(page).click();
    await settle(page);
    expect(await themeOf(page)).toBe("dark");
  });
});

test.describe("sync", () => {
  test("a switch in one tab updates every other open tab", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    await seedSession(ctx);
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await a.goto("/app");
    await b.goto("/app/agents");
    await toggle(a).click();
    await expect.poll(() => themeOf(b)).toBe("dark");
    await settle(b);
    expect(await canvasOf(b)).toBe(DARK_CANVAS);
    await expect(toggle(b)).toHaveAccessibleName("Switch to light mode");

    await toggle(b).click();
    await expect.poll(() => themeOf(a)).toBe("light");
    await ctx.close();
  });

  test("ignores the OS setting, now and when it changes", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/app");
    expect(await themeOf(page)).toBe("light");
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(100);
    expect(await themeOf(page)).toBe("light");
  });
});
