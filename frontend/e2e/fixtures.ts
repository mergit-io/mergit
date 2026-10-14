import { test as base, type BrowserContext } from "@playwright/test";

/** A signed-in demo session, as the Connect window stores it. */
const SESSION = JSON.stringify({
  address: "0x6E2d4A9c51b07f3e9d28c4a16b0e7f2c3d119A0b",
  method: "browser",
  since: 0,
});

/** Sign the context in and skip the landing intro, before any page script runs. */
export async function seedSession(context: BrowserContext) {
  await context.addInitScript((session) => {
    localStorage.setItem("mergit-session", session);
    sessionStorage.setItem("mergit-intro-seen", "1");
  }, SESSION);
}

/** Tests that run against the dashboard start signed in. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await seedSession(context);
    await use(context);
  },
});

export { expect } from "@playwright/test";
