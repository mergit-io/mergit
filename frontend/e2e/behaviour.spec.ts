import { expect, test } from "./fixtures";

test.describe("overview", () => {
  test("approving an ask updates the header count and the nav badge", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByText("Two actions are waiting on you.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Notifications, 2 waiting" })).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText("One action is waiting on you.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Notifications, 1 waiting" })).toBeVisible();
  });

  test("an unanswered ask expires and stops asking", async ({ page }) => {
    await page.clock.install();
    await page.goto("/app");
    await expect(page.getByText("expires 7s")).toBeVisible();
    await page.clock.runFor(10_000);
    await expect(page.getByText("expired")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByText("No actions are waiting on you.")).toBeVisible();
  });

  test("each run row opens its own run", async ({ page }) => {
    await page.goto("/app");
    await page.getByRole("link", { name: /Code review for PR #134/ }).click();
    await expect(page).toHaveURL(/\/app\/runs\/RUN-2045$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Code review for PR #134");
    await expect(page.getByText("No trace in the demo data")).toBeVisible();
  });
});

test.describe("detail routes", () => {
  test("an unknown run or proof id is a 404, not another record", async ({ page }) => {
    await page.goto("/app/runs/RUN-9999");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing settled here");
    await page.goto("/app/proofs/1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing settled here");
  });

  test("the timeline view selects a task like the graph does", async ({ page }) => {
    await page.goto("/app/runs/RUN-2048");
    await page.getByRole("radio", { name: "Timeline" }).click();
    await page.getByRole("button", { name: /Tester/ }).click();
    await expect(page.getByRole("heading", { name: "QA agent" })).toBeVisible();
  });
});

test.describe("leaderboard and agents", () => {
  test("the time range changes the ranking", async ({ page }) => {
    await page.goto("/app/leaderboard");
    const top = page.locator(".lb-podium article").first();
    await expect(top).toContainText("Code agent");
    await page.getByRole("radio", { name: "7d" }).click();
    await expect(top).toContainText("Research agent");
    await page.getByRole("radio", { name: "All time" }).click();
    await expect(top).toContainText("Code agent");
    await expect(top).toContainText("812");
  });
});

test.describe("forms", () => {
  test("sign in needs an email before it continues", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/signin$/);
    await page.getByRole("textbox", { name: "Work email" }).fill("alex@acme.dev");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
  });

  test("the new run composer refuses an empty prompt", async ({ page }) => {
    await page.goto("/app/runs/new");
    await page.getByRole("textbox", { name: "Describe the outcome" }).fill("   ");
    await expect(page.getByRole("button", { name: "Start run" })).toBeDisabled();
  });
});
