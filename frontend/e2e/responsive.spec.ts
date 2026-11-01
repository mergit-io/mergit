import { expect, test, type Page } from "@playwright/test";

/**
 * Every screen size the site is meant for: phones (portrait and landscape), tablets, a half-width desktop window and
 * wide desktops. Nothing may need sideways scrolling, nothing may run off the screen, and what people tap must be
 * big enough to tap. These are layout checks on the real DOM; how it looks is for a person to judge.
 */
const SIZES = [
  { name: "small phone", width: 320, height: 568 },
  { name: "phone", width: 360, height: 740 },
  { name: "large phone", width: 412, height: 915 },
  { name: "landscape phone", width: 844, height: 390 },
  { name: "half window", width: 640, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "large tablet", width: 1024, height: 1366 },
  { name: "laptop", width: 1280, height: 720 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "wide desktop", width: 1920, height: 1080 },
] as const;

const seeIntro = (page: Page) =>
  page.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });

/** Boxes (outside art that is meant to bleed) that stick out past either side of the screen. */
const spills = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.body.querySelectorAll("*"))
      .filter((el) => !el.closest("svg, .l-hero-globe, .proof-chain, .story-pin, [aria-hidden='true'], .splash"))
      .filter((el) => {
        const b = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return b.width > 0 && style.position !== "fixed" && (b.right > vw + 1 || b.left < -1);
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")}`);
  });

/** What makes the page wider than the screen, for a failure message that says where to look. */
const wideCulprits = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.body.querySelectorAll("*"))
      .filter((el) => getComputedStyle(el).position !== "fixed" && el.getBoundingClientRect().right > vw + 1)
      .slice(0, 6)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")} right=${String(Math.round(el.getBoundingClientRect().right))} (screen ${String(vw)})`,
      );
  });

const pageScrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

for (const size of SIZES) {
  test.describe(`${size.name} (${String(size.width)}×${String(size.height)})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      await seeIntro(page);
    });

    test("the home page: no sideways scroll, nothing off screen, the headline and both buttons reachable", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await pageScrollsSideways(page)).toBe(false);
      if (size.width < 1024) expect(await spills(page)).toEqual([]);
      const button = page.getByRole("button", { name: /Get started/ }).first();
      await expect(button).toBeVisible();
      // A finger needs a bigger target than a mouse: the rule is for the sizes people hold in their hand.
      if (size.width < 1024) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(36);
    });

    test("sign in: the whole form fits, and the email field and buttons are tappable", async ({ page }) => {
      await page.goto("/signin");
      await expect(
        page.getByRole("heading", { name: /Sign in to Mergit|Welcome back|Create your account/ }),
      ).toBeVisible();
      expect(await pageScrollsSideways(page)).toBe(false);
      expect(await spills(page)).toEqual([]);
    });

    test("the demo dashboard: no sideways scroll on any of its pages", async ({ page }) => {
      // Every page is checked before failing, and each problem names the page and the element, not just "false".
      const problems: string[] = [];
      for (const path of ["/demo", "/demo/runs/new", "/demo/agents", "/demo/proofs", "/demo/wallet"]) {
        await page.goto(path);
        await expect(page.getByRole("note")).toContainText("sample data");
        if (await pageScrollsSideways(page))
          problems.push(`${path} scrolls sideways: ${(await wideCulprits(page)).join("; ")}`);
        const off = await spills(page);
        if (off.length > 0) problems.push(`${path} has boxes off screen: ${off.join(", ")}`);
      }
      expect(problems).toEqual([]);
    });
  });
}

test("the viewport meta allows zooming: nobody is locked out of reading small text", async ({ page }) => {
  await page.goto("/");
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(content).toContain("width=device-width");
  expect(content).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
});

test("on a phone the body text is never smaller than 12px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await seeIntro(page);
  await page.goto("/");
  const tooSmall = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".compact-mode p, .compact-mode li, .compact-mode h3, .compact-mode summary"))
      .filter((el) => el.textContent.trim().length > 0 && el.getBoundingClientRect().width > 0)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
      .map((el) => `${el.tagName.toLowerCase()} ${getComputedStyle(el).fontSize}`),
  );
  expect(tooSmall).toEqual([]);
});

test("a dialog taller than the screen scrolls inside itself instead of running off the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await seeIntro(page);
  await page.goto("/app/agents"); // signed out: the Connect window opens over the dashboard
  const dialog = page.getByRole("dialog", { name: "Connect to Mergit" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(390);
});
