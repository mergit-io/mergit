import { expect, test, type Page } from "@playwright/test";
import { toFunctionSelector } from "viem";
import { LIVE_ENV } from "../../playwright.config";
import { seedSession } from "../fixtures";
import { installWallet, ME, mockBackend } from "./fake";
import { approvedPlan, attempt, draftPlan, mockPlanApi, PHI, PLAN_ID, taskId, type ApiCall } from "./plans";

/** Live run screens (plan task O8): draft, review, approve, fund, and watch a run, against a faked API. */

test.beforeEach(async ({ context }) => {
  await seedSession(context, ME);
  await installWallet(context);
});

const sent = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __fakeWallet: { state: { sent: Array<{ to: string; data: string }>; signed: string[] } };
        }
      ).__fakeWallet.state,
  );

const only = (calls: ApiCall[], method: string, suffix: string) =>
  calls.filter((c) => c.method === method && c.path.endsWith(suffix));

test("a new run drafts a plan and opens it for review", async ({ page }) => {
  await mockBackend(page);
  const calls = await mockPlanApi(page);
  await page.goto("/app/runs/new");

  await page.getByLabel("Goal").fill("The refund test in payments/ passes again");
  await page.getByLabel("Repository").fill("https://github.com/acme/widgets");
  await page.getByLabel("Budget (USDC)").fill("2.5");
  await page.getByRole("button", { name: "Draft the plan" }).click();

  await expect(page).toHaveURL(new RegExp(`/app/runs/${draftPlan().plan_uuid}$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The refund test in payments/ passes again");
  await expect(page.getByRole("group", { name: "Task 2" })).toBeVisible();
  expect(only(calls, "POST", "/v0/plans")[0]?.body).toEqual({
    goal: "The refund test in payments/ passes again",
    repo_url: "https://github.com/acme/widgets",
    ref: "main",
    budget_usdc_units: "2500000",
    category: "test-repair",
  });
});

test("a new run explains what is missing before calling the planner", async ({ page }) => {
  await mockBackend(page);
  const calls = await mockPlanApi(page);
  await page.goto("/app/runs/new");
  await page.getByLabel("Budget (USDC)").fill("0");
  await page.getByRole("button", { name: "Draft the plan" }).click();

  const problems = page.getByRole("alert");
  await expect(problems).toContainText("Describe the goal.");
  await expect(problems).toContainText("The budget must be a positive USDC amount.");
  expect(only(calls, "POST", "/v0/plans")).toEqual([]);
});

test("the requester edits a check, picks an agent per task and approves", async ({ page }) => {
  await mockBackend(page);
  const calls = await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);

  const first = page.getByRole("group", { name: "Task 1" });
  const edited = { ...PHI, command: ["pytest", "tests/test_refund.py::test_rounding", "-q"] };
  await first.getByLabel("Check (Φ)").fill(JSON.stringify(edited, null, 2));
  await first.getByLabel("Task 1: runs it").selectOption("2");
  await first.getByLabel("Task 1: retry 1").selectOption("1");
  await page.getByRole("group", { name: "Task 2" }).getByLabel("Task 2: runs it").selectOption("1");
  await expect(page.getByTestId("plan-total")).toContainText("1.50");

  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByRole("heading", { name: "Fund 1.50 USDC" })).toBeVisible();

  // The edit is saved first, so what was approved is what was on screen.
  const patch = only(calls, "PATCH", draftPlan().plan_uuid);
  expect((patch[0]?.body as { tasks: Array<{ phi: unknown }> }).tasks[0]?.phi).toEqual(edited);
  expect(only(calls, "POST", "/approve")[0]?.body).toEqual({
    agents: { "0": ["2", "1"], "1": ["1"] },
    funding: "wallet",
  });
  expect(calls.indexOf(patch[0] as ApiCall)).toBeLessThan(calls.indexOf(only(calls, "POST", "/approve")[0] as ApiCall));
});

test("approving without an agent for every task says which task needs one", async ({ page }) => {
  await mockBackend(page);
  const calls = await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  await page.getByLabel("Task 1: runs it").selectOption("1");
  await page.getByRole("button", { name: "Approve plan" }).click();

  await expect(page.getByRole("alert")).toHaveText("Task 2: pick an agent to run it.");
  expect(only(calls, "POST", "/approve")).toEqual([]);
});

test("approving with free credits shows what is left and never asks the wallet", async ({ page }) => {
  await mockBackend(page, { credits: { granted: "5000000", spent: "2000000", remaining: "3000000", plans_today: 1 } });
  const calls = await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);

  await page.getByLabel("Task 1: runs it").selectOption("1");
  await page.getByLabel("Task 2: runs it").selectOption("2");
  await page.getByRole("radio", { name: "Free credits" }).click();
  await expect(page.getByText("Free credits left: 3.00 USDC")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();

  await expect(page.getByText("Waiting for the gateway to fund 1.50 USDC from your free credits.")).toBeVisible();
  expect((only(calls, "POST", "/approve")[0]?.body as { funding: string }).funding).toBe("credits");
  const wallet = await sent(page);
  expect(wallet.sent).toEqual([]);
  expect(wallet.signed).toEqual([]);
});

test("refused credits say why and offer the wallet instead", async ({ page }) => {
  await mockBackend(page);
  const denied = approvedPlan({
    funding: "credits",
    money_events: [
      { type: "credits.denied", at: "2026-10-29T10:06:00Z", payload: { plan_id: PLAN_ID, reason: "over_value_cap" } },
    ],
  });
  await mockPlanApi(page, { plans: [denied] });
  await page.goto(`/app/runs/${denied.plan_uuid}`);

  await expect(page.getByRole("alert")).toContainText("This plan costs more than free credits can cover.");
  await expect(page.getByRole("button", { name: "Fund 1.50 USDC" })).toBeVisible();
});

test("approving with the wallet funds Escrow and waits for the confirmation", async ({ page }) => {
  await mockBackend(page, { usdcUnits: 10_000_000n });
  await mockPlanApi(page, { plans: [approvedPlan()] });
  await page.goto(`/app/runs/${approvedPlan().plan_uuid}`);

  await page.getByRole("button", { name: "Fund 1.50 USDC" }).click();
  await expect(page.getByText("Funded on Base Sepolia.")).toBeVisible();

  // Allowance is zero on the fake node: approve the spend, then fund the plan.
  const { sent: txs } = await sent(page);
  expect(txs.map((t) => t.to.toLowerCase())).toEqual([
    LIVE_ENV.VITE_USDC.toLowerCase(),
    LIVE_ENV.VITE_ESCROW.toLowerCase(),
  ]);
  expect(txs[1]?.data.startsWith(toFunctionSelector("fundPlan(bytes32,uint256)"))).toBe(true);
  expect(txs[1]?.data).toContain(PLAN_ID.slice(2));
});

test("the run view streams steps live and shows the verdict and the receipt", async ({ page }) => {
  await mockBackend(page);
  const root = `0x${"ee".repeat(32)}` as const;
  const running = approvedPlan({
    state: "running",
    attempts: [
      attempt(0, 1, { status: "done", phi_holds: true, receipt_root: root, agent_id: "1" }),
      attempt(1, 1, { agent_id: "1" }),
    ],
  });
  await mockPlanApi(page, {
    plans: [running],
    events: [
      {
        event: "step.recorded",
        data: { task_id: taskId(1, 1), seq: 1, type: "model_call", cost: { usd_micros: 1200 } },
      },
      { event: "step.recorded", data: { task_id: taskId(1, 1), seq: 2, type: "command", cost: { usd_micros: 0 } } },
      { event: "task.state", data: attempt(1, 1, { status: "done", phi_holds: true, receipt_root: root }) },
      {
        event: "verdict",
        data: { type: "verdict.recorded", at: "t", payload: { task_id: taskId(0, 1), verdict: "pass" } },
      },
    ],
  });
  await page.goto(`/app/runs/${running.plan_uuid}`);

  const log = page.getByRole("region", { name: "Live log" });
  await expect(log.getByText("model_call")).toBeVisible();
  await expect(log.getByText("$0.0012")).toBeVisible();
  await expect(log.getByText("command")).toBeVisible();
  await expect(page.getByRole("region", { name: "Tasks" })).toContainText("2 of 2 passed their check");

  const panel = page.getByRole("complementary", { name: "Task 1 details" });
  await expect(panel.getByText("Audit passed")).toBeVisible();
  await expect(panel.getByRole("link", { name: "Receipt" })).toHaveAttribute("href", `/app/proofs/${taskId(0, 1)}`);

  // Task 2's attempt sealed while the page was open: its steps were seen live, and its receipt links too.
  await page.getByRole("button", { name: /Fix the refund rounding/ }).click();
  const second = page.getByRole("complementary", { name: "Task 2 details" });
  await expect(second).toContainText("2 steps seen live");
  await expect(second.getByRole("link", { name: "Receipt" })).toHaveAttribute("href", `/app/proofs/${taskId(1, 1)}`);
});

test("a failed check is retried by the next agent the requester picked", async ({ page }) => {
  await mockBackend(page);
  const retried = approvedPlan({
    state: "running",
    attempts: [attempt(0, 1, { status: "done", phi_holds: false, agent_id: "1" })],
  });
  await mockPlanApi(page, {
    plans: [retried],
    events: [{ event: "task.state", data: attempt(0, 2, { agent_id: "2" }) }],
  });
  await page.goto(`/app/runs/${retried.plan_uuid}`);

  const panel = page.getByRole("complementary", { name: "Task 1 details" });
  const attempts = panel.getByRole("listitem");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.nth(0)).toContainText("Attempt 1 · coder-a");
  await expect(attempts.nth(0)).toContainText("Check failed");
  await expect(attempts.nth(1)).toContainText("Attempt 2 · coder-b");
  await expect(attempts.nth(1)).toContainText("In progress");
  await expect(page.getByRole("button", { name: /Reproduce the failing refund/ })).toContainText("attempt 2 of 2");
});

test("an inconclusive task with no agent left asks the requester, who can close the plan", async ({ page }) => {
  await mockBackend(page);
  const stuck = approvedPlan(
    {
      state: "running",
      attempts: [attempt(0, 1, { status: "error", phi_holds: null, agent_id: "1", notes: "Φ timed out" })],
    },
    ["1"],
  );
  const calls = await mockPlanApi(page, { plans: [stuck] });
  await page.goto(`/app/runs/${stuck.plan_uuid}`);

  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Needs you: task 1 failed its check with every agent you picked.");
  await expect(page.getByRole("complementary", { name: "Task 1 details" })).toContainText("Inconclusive");

  await banner.getByRole("button", { name: "Close plan" }).click();
  await banner.getByRole("button", { name: "Yes, close it" }).click();
  await expect(page.getByText("This plan is closed.")).toBeVisible();
  expect(only(calls, "POST", "/abandon")).toHaveLength(1);
});

test("the runs tab lists the requester's plans and opens one", async ({ page }) => {
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  await page.goto("/app/runs");

  const row = page.getByRole("link", { name: /The refund test in payments\/ passes again/ });
  await expect(row).toContainText("Draft");
  await row.click();
  await expect(page.getByRole("group", { name: "Task 1" })).toBeVisible();
});

test.describe("opening the pull request", () => {
  const done = () =>
    approvedPlan({
      state: "done",
      attempts: [
        attempt(0, 1, { status: "done", phi_holds: true, receipt_root: `0x${"ee".repeat(32)}` }),
        attempt(1, 1, { status: "done", phi_holds: true, receipt_root: `0x${"ee".repeat(32)}` }),
      ],
    });

  test("a finished plan shows its change, and approving opens the pull request", async ({ page }) => {
    await mockBackend(page);
    const plan = done();
    const calls = await mockPlanApi(page, { plans: [plan], pr: { after: ["running", "done"] } });
    await page.goto(`/app/runs/${plan.plan_uuid}`);

    const step = page.getByRole("region", { name: "Open a pull request" });
    await expect(step).toContainText("No pull request has been opened yet");
    await expect(step).toContainText("+1");
    await step.getByText("Read the change").click();
    await expect(step.getByLabel("The combined change")).toContainText("max(0, min(requested_cents, remaining))");

    await step.getByRole("button", { name: "Open the pull request" }).click();
    expect(only(calls, "POST", "/open-pr")).toHaveLength(1);
    await expect(step).toContainText("Pull request #7 is open.", { timeout: 15_000 });
    const link = step.getByRole("link", { name: /View pull request #7/ });
    await expect(link).toHaveAttribute("href", "https://github.com/mergit-io/demo-repo/pull/7");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });

  test("a failed attempt says why and offers to try again", async ({ page }) => {
    await mockBackend(page);
    const plan = done();
    await mockPlanApi(page, { plans: [plan], pr: { after: ["error"] } });
    await page.goto(`/app/runs/${plan.plan_uuid}`);
    const step = page.getByRole("region", { name: "Open a pull request" });
    await step.getByRole("button", { name: "Open the pull request" }).click();
    await expect(step).toContainText("patch does not apply", { timeout: 15_000 });
    await expect(step.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("a plan that is still running offers no pull request", async ({ page }) => {
    await mockBackend(page);
    const plan = approvedPlan({ state: "running", attempts: [attempt(0, 1)] });
    await mockPlanApi(page, { plans: [plan] });
    await page.goto(`/app/runs/${plan.plan_uuid}`);
    await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Open a pull request" })).toHaveCount(0);
  });
});
