import { expect, test } from "@playwright/test";
import { seedSession } from "../fixtures";
import { installWallet, ME, mockBackend } from "./fake";

/** Redeem codes on the Wallet page: one use each, and the balance next to the box is read again after a success. */

const CODE = "MRG-7K2Q-XD4M-9TPA-C3VH";

test.beforeEach(async ({ context }) => {
  await seedSession(context, ME);
  await installWallet(context);
});

test("a valid code adds its amount and the balance updates", async ({ page }) => {
  const calls = await mockBackend(page, {
    credits: { granted: "5000000", spent: "0", remaining: "5000000", plans_today: 0 },
    redeemCodes: { [CODE]: "20000000" },
  });
  await page.goto("/app/wallet");
  await expect(page.getByTestId("credits-remaining")).toHaveText("5.00");
  await page.getByLabel("Redeem code").fill(`  ${CODE}  `);
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 20.00 USDC to your credits." })).toBeVisible();
  await expect(page.getByTestId("credits-remaining")).toHaveText("25.00");
  await expect(page.getByLabel("Redeem code")).toHaveValue("");
  const sent = calls.filter((c) => c.path === "/v0/account/redeem");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toEqual({ code: CODE });
});

test("the same code cannot be used twice", async ({ page }) => {
  await mockBackend(page, { redeemCodes: { [CODE]: "20000000" } });
  await page.goto("/app/wallet");
  await page.getByLabel("Redeem code").fill(CODE);
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByTestId("credits-remaining")).toHaveText("25.00");
  await page.getByLabel("Redeem code").fill(CODE);
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code has already been used." })).toBeVisible();
  await expect(page.getByTestId("credits-remaining")).toHaveText("25.00");
});

test("each refusal is explained and changes nothing", async ({ page }) => {
  await mockBackend(page, {
    redeemCodes: {
      "MRG-EXPIRED": { status: 410 },
      "MRG-SLOW": { status: 429, retryAfter: "125" },
    },
  });
  await page.goto("/app/wallet");
  const field = page.getByLabel("Redeem code");
  const redeem = page.getByRole("button", { name: "Redeem" });
  await field.fill("MRG-NOPE");
  await redeem.click();
  await expect(page.getByRole("alert")).toContainText("That code is not valid.");
  await field.fill("MRG-EXPIRED");
  await redeem.click();
  await expect(page.getByRole("alert")).toContainText("That code has expired.");
  await field.fill("MRG-SLOW");
  await redeem.click();
  await expect(page.getByRole("alert")).toContainText("Try again in 3 minutes.");
  await expect(page.getByTestId("credits-remaining")).toHaveText("5.00");
});

test("the button waits for a code to be typed", async ({ page }) => {
  await mockBackend(page, {});
  await page.goto("/app/wallet");
  const redeem = page.getByRole("button", { name: "Redeem" });
  await expect(redeem).toBeDisabled();
  await page.getByLabel("Redeem code").fill("x");
  await expect(redeem).toBeEnabled();
  await page.getByLabel("Redeem code").fill("   ");
  await expect(redeem).toBeDisabled();
});

test("the wallet page says the free credits are once, and where to go when they run out", async ({ page }) => {
  await mockBackend(page, { credits: { granted: "5000000", spent: "5000000", remaining: "0", plans_today: 2 } });
  await page.goto("/app/wallet");
  await expect(page.getByTestId("credits-remaining")).toHaveText("0.00");
  await expect(page.getByText("Every account gets 5 test USDC once")).toBeVisible();
  await expect(page.getByText("connect a wallet and pay as you go")).toBeVisible();
});
