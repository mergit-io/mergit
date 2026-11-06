import { expect, test } from "@playwright/test";
import { seedSession } from "../fixtures";
import { installWallet, ME, mockBackend } from "./fake";
import { AGENTS, draftPlan, mockPlanApi, SEASONED } from "./plans";

/**
 * ENS inside the dashboard: the name and badge beside each agent, the live leaderboard from the reputation mirror,
 * and the reuse-before-create hint. Fixtures (src/chain/ens/stubClients.ts): agent 1, coder-a, is verified; agent 2,
 * coder-b, was sold since ENS was last updated (owner changed).
 */

test.beforeEach(async ({ page, context }) => {
  await seedSession(context, ME);
  await installWallet(context);
  await mockBackend(page);
});

test("the agents page shows each agent's ENS name and verdict, linked to its public profile", async ({ page }) => {
  await mockPlanApi(page);
  await page.goto("/app/agents");
  const first = page.getByTestId("ens-1");
  await expect(first.locator("[data-ens-state]")).toHaveText("Two-way verified");
  await expect(page.getByTestId("ens-2").locator("[data-ens-state]")).toHaveText("Owner changed, not verified");
  await first.getByRole("link", { name: "coder-a.mergit.eth" }).click();
  await expect(page).toHaveURL(/\/agents\/coder-a$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("coder-a.mergit.eth");
});

test("the leaderboard lists mirrored counts from the roster, at a stated block, labelled not a score", async ({
  page,
}) => {
  await mockPlanApi(page);
  await page.goto("/app/leaderboard");
  await expect(page.getByTestId("mirror-label")).toContainText("not a score and not value density");
  const rows = page.getByTestId("leaderboard").locator("tbody tr");
  await expect(rows).toHaveCount(AGENTS.length);
  await expect(rows.first()).toContainText("coder-a.mergit.eth");
  await expect(rows.first()).toContainText("23,456,789");
  await page.getByRole("combobox", { name: "Category" }).selectOption("refactor");
  await expect(rows.first()).toContainText("1");
});

test("the agent picker shows the chosen agent's ENS name but keeps the roster order and values", async ({ page }) => {
  await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  const picker = page.getByRole("combobox", { name: "Task 1: runs it" });
  await expect(picker.locator("option")).toHaveText(["Pick an agent", ...AGENTS.map((a) => `${a.name} · ${a.model}`)]);
  await picker.selectOption("1");
  await expect(page.getByTestId("ens-1").locator("[data-ens-state]")).toHaveText("Two-way verified");
});

test("reuse before create: agents proven in the plan's category are listed first, or the page says none is", async ({
  page,
}) => {
  await mockPlanApi(page, { plans: [draftPlan()], reputation: [SEASONED] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  await expect(page.getByTestId("track-record-hint")).toContainText("coder-b (7 validated)");
});

test("with no proven agent in the category, the hint says so and offers no create button", async ({ page }) => {
  await mockPlanApi(page, { plans: [draftPlan()], reputation: [] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  const hint = page.getByTestId("track-record-hint");
  await expect(hint).toContainText("No agent has a validated track record in this category yet");
  await expect(hint.getByRole("button")).toHaveCount(0);
});
