import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "../fixtures";
import { installWallet, ME, mockBackend } from "./fake";
import { draftPlan, mockPlanApi } from "./plans";

/**
 * New run with the GitHub pickers. GitHub's public API is faked here: the page lists a signed-in GitHub user's public
 * repositories and a repository's branches, straight from api.github.com.
 */

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `octo/${name}`,
  owner: { login: "octo" },
  default_branch: "main",
  description: `The ${name} service`,
  language: "Python",
  pushed_at: "2026-10-30T10:00:00Z",
  ...extra,
});

async function fakeGitHub(page: Page) {
  const asked: string[] = [];
  await page.route("https://api.github.com/**", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/users/octo/repos")
      return json([repo("widgets", { default_branch: "trunk" }), repo("billing")]);
    if (url.pathname === "/repos/octo/widgets/branches") return json([{ name: "trunk" }, { name: "fix/refund" }]);
    if (url.pathname === "/repos/octo/billing/branches") return json([{ name: "main" }]);
    if (url.pathname === "/repos/someone/else")
      return json(repo("else", { full_name: "someone/else", owner: { login: "someone" }, default_branch: "develop" }));
    if (url.pathname === "/repos/someone/else/branches") return json([{ name: "develop" }]);
    return json({ message: "Not Found" }, 404);
  });
  return asked;
}

test.beforeEach(async ({ context }) => {
  await seedSession(context, ME);
  await installWallet(context);
});

test("a GitHub user picks a repository and a branch from GitHub, and the plan is drafted on them", async ({ page }) => {
  await mockBackend(page, {
    providers: { wallet: true, github: true, google: false, email: false },
    me: {
      address: ME.toLowerCase(),
      user_id: "u1",
      identities: [{ provider: "github", label: "octo" }],
      wallets: [ME.toLowerCase()],
    },
  });
  const calls = await mockPlanApi(page, { created: draftPlan() });
  await fakeGitHub(page);
  await page.goto("/app/runs/new");

  await expect(page.getByText("@octo")).toBeVisible();
  const repoField = page.getByRole("combobox", { name: "Repository" });
  await repoField.click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText("octo/widgets");

  await repoField.fill("widg");
  await expect(options).toHaveCount(1);
  await repoField.press("ArrowDown");
  await repoField.press("Enter");
  await expect(repoField).toHaveValue("octo/widgets");
  // The repository's default branch is taken, and its other branches are offered.
  const branch = page.getByRole("combobox", { name: "Branch" });
  await expect(branch).toHaveValue("trunk");
  await branch.fill("");
  await branch.click();
  await expect(page.getByRole("option", { name: "fix/refund" })).toBeVisible();
  await page.getByRole("option", { name: "fix/refund" }).click();
  await expect(branch).toHaveValue("fix/refund");

  await page.getByRole("radio", { name: "Security" }).check();
  await page.getByLabel("Goal").fill("Uploads outside the uploads folder are refused");
  await page.getByLabel("Budget (USDC)").fill("3");
  await page.getByRole("button", { name: "Draft the plan" }).click();

  await expect(page).toHaveURL(new RegExp(`/app/runs/${draftPlan().plan_uuid}$`));
  expect(calls.find((c) => c.method === "POST" && c.path === "/v0/plans")?.body).toEqual({
    goal: "Uploads outside the uploads folder are refused",
    repo_url: "https://github.com/octo/widgets",
    ref: "fix/refund",
    budget_usdc_units: "3000000",
    category: "security",
  });
});

test("without GitHub, a typed owner/name is looked up and used, and its default branch is taken", async ({ page }) => {
  await mockBackend(page, { providers: { wallet: true, github: true, google: false, email: false } });
  await mockPlanApi(page);
  await fakeGitHub(page);
  await page.goto("/app/runs/new");

  await expect(page.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute("href", /\/v0\/auth\/github\/start/);
  const repoField = page.getByRole("combobox", { name: "Repository" });
  await repoField.fill("https://github.com/someone/else");
  await page.getByRole("option", { name: /someone\/else/ }).click();
  await expect(repoField).toHaveValue("someone/else");
  await expect(page.getByRole("combobox", { name: "Branch" })).toHaveValue("develop");
});

test("a starting point fills the goal and picks its kind of work", async ({ page }) => {
  await mockBackend(page);
  await mockPlanApi(page);
  await fakeGitHub(page);
  await page.goto("/app/runs/new");
  await page.getByRole("button", { name: /Fix a bug, with a regression test/ }).click();
  await expect(page.getByLabel("Goal")).toHaveValue(/regression test covers it/);
  await expect(page.getByRole("radio", { name: "Fix a bug" })).toBeChecked();
});
