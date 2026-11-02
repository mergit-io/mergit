import { expect, test } from "@playwright/test";
import { installWallet, ME, mockBackend, type Backend } from "./fake";
import { draftPlan, mockPlanApi } from "./plans";

/**
 * Accounts on live data: GitHub, Google and an emailed code create an account; a wallet is connected afterwards.
 * The browser starts with no remembered session unless a test says otherwise: the session is the server's cookie.
 */

const TRIAL = "0x9999999999999999999999999999999999999999";
const github = {
  address: TRIAL,
  user_id: "u1",
  name: "Octo Cat",
  email: "octo@example.com",
  avatar_url: null,
  identities: [{ provider: "github", label: "octo" }],
  wallets: [],
  trial_address: TRIAL,
  trial: null,
};
const onTrial = { ...github, trial: { started_at: "2026-10-30T10:00:00+00:00" } };
const everything = { wallet: true, github: true, google: true, email: true };

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
  await installWallet(context);
});

const open = async (page: Parameters<typeof mockBackend>[0], b: Backend) => {
  const calls = await mockBackend(page, b);
  return calls;
};

test("the sign in page offers the methods the server has set up, and no others", async ({ page }) => {
  await open(page, { me: null, providers: { wallet: true, github: true, google: false, email: true } });
  await page.goto("/signin");
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
    "href",
    "http://api.test/v0/auth/github/start?intent=login",
  );
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a code" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("demo account");
});

test("Sign in and Create account are separate: the wording and what is sent to the server change", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByRole("radio", { name: "Create account" }).click();
  await expect(page).toHaveURL(/mode=register/);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up with GitHub" })).toHaveAttribute(
    "href",
    "http://api.test/v0/auth/github/start?intent=register",
  );
  await expect(page.getByRole("button", { name: "Sign up with wallet" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("signing in with a wallet nobody registered says so and moves to Create account", async ({ page }) => {
  await open(page, { me: null, providers: everything, walletRegistered: false });
  await page.goto("/signin");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await page.getByRole("button", { name: /MetaMask/ }).click();
  await expect(page.getByRole("alert")).toContainText("Create an account");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  // The wallet list stays open on the Create account tab: choosing MetaMask again now registers it.
  await page.getByRole("button", { name: /MetaMask/ }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("a provider that finds no account sends the person to Create account, with the reason", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.goto("/signin?error=no_account");
  await expect(page.getByRole("alert")).toContainText("Create an account");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

test("only the wallet is offered while the server has not set anything else up", async ({ page }) => {
  await open(page, { me: null });
  await page.goto("/signin");
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Sign (in|up) with/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Email me a code" })).toHaveCount(0);
});

test("a failed provider sign-in says what happened, in words, not the code from the address bar", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.goto("/signin?error=email_unverified");
  await expect(page.getByRole("alert")).toContainText("no verified email");
  await page.goto("/signin?error=%3Cb%3Eboom%3C%2Fb%3E");
  await expect(page.getByRole("alert")).toContainText("could not sign you in");
  await expect(page.getByRole("alert")).not.toContainText("boom");
});

test("signed out, the dashboard asks for a sign in with every method the server has", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.goto("/app");
  const dialog = page.getByRole("dialog", { name: "Connect to Mergit" });
  await expect(dialog.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
});

test("coming back from GitHub, the session cookie signs the browser in as that person", async ({ page }) => {
  await open(page, { me: github, providers: everything });
  await page.goto("/app");
  await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText("Free trial");
  await expect(page.getByRole("button", { name: "Account, signed in as Octo Cat" })).toContainText("OC");
  const body = page.locator("body");
  await expect(body).not.toContainText("Alex");
  await expect(body).not.toContainText("acme/billing");
  await expect(body).not.toContainText("0x6E2d");
  await expect(body).not.toContainText(TRIAL.slice(0, 10)); // the trial address is not a wallet and is never shown as one
});

test("a new account chooses between the free trial and a wallet, and the trial has no wallet to show", async ({
  page,
}) => {
  const b: Backend = {
    me: github,
    providers: everything,
    credits: { granted: "5000000", spent: "0", remaining: "5000000", plans_today: 0 },
  };
  const calls = await open(page, b);
  await page.goto("/app");
  const choice = page.getByRole("dialog", { name: "Choose your plan" });
  await expect(choice).toBeVisible();
  await choice.getByRole("button", { name: "Start free" }).click();
  await expect(choice).toBeHidden();
  expect(calls.some((c) => c.path === "/v0/account/trial")).toBe(true);

  await page.getByRole("button", { name: /^Account, signed in as/ }).click();
  await expect(page.getByRole("menu")).toContainText("octo@example.com");

  await page.goto("/app/wallet");
  await expect(page.getByText("No wallet connected", { exact: true })).toBeVisible();
  // The wallet page offers the wallet list, with MetaMask first, instead of a bare button.
  await expect(
    page.getByRole("group", { name: "Choose a wallet" }).getByRole("button", { name: /MetaMask/ }),
  ).toBeVisible();
  await expect(page.getByTestId("credits-remaining")).toHaveText("5.00");
  await expect(page.getByTestId("usdc-balance")).toHaveCount(0);
});

test("connecting a wallet makes the session act as that wallet", async ({ page }) => {
  const calls = await open(page, { me: github, providers: everything });
  await page.goto("/app");
  const choice = page.getByRole("dialog", { name: "Choose your plan" });
  await choice.getByRole("button", { name: /Connect a wallet/ }).click();
  await choice.getByRole("button", { name: /MetaMask/ }).click();
  await expect(choice).toBeHidden();
  const link = calls.find((c) => c.path === "/v0/auth/wallet/link");
  expect((link?.body as { message: string }).message).toContain("Chain ID: 84532");
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText(
    `${ME.slice(0, 6)}…${ME.slice(-4)}`,
  );
  await expect(page.getByRole("link", { name: "Wallet and identity" })).not.toContainText("Free trial");
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem("mergit-session") ?? "{}") as { address: string },
  );
  expect(stored.address).toBe(ME);
});

test("a wallet that already has an account is offered a merge, and nothing moves until it is confirmed", async ({
  page,
}) => {
  const token = "m".repeat(43);
  const calls = await open(page, {
    me: github,
    providers: everything,
    walletTaken: { token, other: { identities: [], wallets: 1, plans: 2, trial_started: false } },
  });
  await page.goto("/app");
  const choice = page.getByRole("dialog", { name: "Choose your plan" });
  await choice.getByRole("button", { name: /Connect a wallet/ }).click();
  await choice.getByRole("button", { name: /MetaMask/ }).click();

  const prompt = choice.getByRole("group", { name: "Merge accounts" });
  await expect(prompt).toContainText("This wallet already has a Mergit account");
  await expect(prompt).toContainText("It holds 1 wallet and 2 runs.");
  expect(calls.some((c) => c.path === "/v0/auth/merge")).toBe(false);

  // Cancel changes nothing and goes back to the wallet list.
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(choice.getByRole("group", { name: "Choose a wallet" })).toBeVisible();
  expect(calls.some((c) => c.path === "/v0/auth/merge")).toBe(false);

  await choice.getByRole("button", { name: /MetaMask/ }).click();
  await choice.getByRole("button", { name: "Merge into this account" }).click();
  await expect(choice).toBeHidden();
  expect(calls.find((c) => c.path === "/v0/auth/merge")?.body).toEqual({ merge_token: token });
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText(
    `${ME.slice(0, 6)}…${ME.slice(-4)}`,
  );
});

test("a conflict that is not a merge offer is shown as an error, not as a merge", async ({ page }) => {
  await open(page, { me: github, providers: everything, walletTaken: "plain" });
  await page.goto("/app");
  const choice = page.getByRole("dialog", { name: "Choose your plan" });
  await choice.getByRole("button", { name: /Connect a wallet/ }).click();
  await choice.getByRole("button", { name: /MetaMask/ }).click();
  await expect(choice.getByRole("alert")).toContainText("already belongs to another Mergit account");
  await expect(choice.getByRole("group", { name: "Merge accounts" })).toHaveCount(0);
});

test("the choice can wait: look around first", async ({ page }) => {
  await open(page, { me: github, providers: everything });
  await page.goto("/app");
  await page.getByRole("button", { name: "Look around first" }).click();
  await expect(page.getByRole("dialog", { name: "Choose your plan" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("the sign-in page tells a first-time visitor they can start free without a wallet", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.goto("/signin");
  await expect(page.getByText("with no wallet needed")).toBeVisible();
  await expect(page.getByText("committed on Base Sepolia")).toBeVisible();
  // The picture is an illustration: it must not carry sample data into live mode.
  await expect(page.locator(".si-art")).not.toContainText(/PR #\d|0x30af/);
});

test("an emailed code signs in", async ({ page }) => {
  const b: Backend = {
    me: null,
    providers: everything,
    meAfterEmail: {
      ...onTrial,
      identities: [{ provider: "email", label: "ada@example.com" }],
      email: "ada@example.com",
      name: null,
    },
  };
  const calls = await open(page, b);
  await page.goto("/signin");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByText("We sent a six-digit code to")).toContainText("ada@example.com");
  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  expect(calls.find((c) => c.path === "/v0/auth/email/verify")?.body).toEqual({
    email: "ada@example.com",
    code: "123456",
    intent: "login",
  });
  await expect(page.getByRole("button", { name: /^Account, signed in as/ })).toContainText("AD");
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText("Free trial");
});

test("a wrong emailed code shows the reason and stays on the form", async ({ page }) => {
  await open(page, { me: null, providers: everything });
  await page.route("http://api.test/v0/auth/email/verify", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    return route.fulfill({
      status: 401,
      headers: {
        "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
        "access-control-allow-credentials": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({ detail: "that code is not valid" }),
    });
  });
  await page.goto("/signin");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("wrong or has expired");
  await expect(page).toHaveURL(/\/signin$/);
});

test("a trial plan can only be paid from credits: there is no wallet to offer", async ({ page }) => {
  await open(page, { me: onTrial, providers: everything });
  await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  await expect(page.getByRole("radio", { name: "Free credits" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Wallet" })).toHaveCount(0);
});

test("a server that is down does not sign a remembered session out", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem(
      "mergit-session",
      JSON.stringify({ address: "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D", method: "browser", since: 0 }),
    );
  });
  await open(page, {});
  await page.route("http://api.test/v0/auth/me", (route) => route.abort());
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Wallet and identity" })).toContainText("0x1725…585D");
});

test("a session the server no longer knows ends: the dashboard asks to sign in again", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem(
      "mergit-session",
      JSON.stringify({ address: "0x1725a458a3Fc8BB3d7460d262c7F94766FEF585D", method: "browser", since: 0 }),
    );
  });
  await open(page, { me: null, providers: everything });
  await page.goto("/app");
  await expect(page.getByRole("dialog", { name: "Connect to Mergit" })).toBeVisible();
});
