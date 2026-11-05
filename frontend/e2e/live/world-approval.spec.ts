import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { LIVE_ENV } from "../../playwright.config";
import { seedSession } from "../fixtures";
import { CORS, installWallet, json, ME, mockBackend } from "./fake";
import { approvedPlan, attempt, draftPlan, mockPlanApi } from "./plans";

/**
 * World ID human approval (plan sec 1.7) in a real browser: the dialog that shows what is being approved, the
 * World ID popup, the "Waiting for World ID…" state with its Cancel, the reasons a check was refused, and the
 * popup's own landing page. The API and World are faked on the live API host, as in run.spec.ts.
 *
 * Set WORLD_SHOTS_DIR to also save a screenshot of each state.
 */

const API = LIVE_ENV.VITE_API_URL;
const APPROVAL_ID = "a1111111-1111-4111-8111-111111111111";
const SHOTS = process.env.WORLD_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  // The dialog fades in; a screenshot mid-animation shows it half transparent.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.beforeEach(async ({ context }) => {
  await seedSession(context, ME);
  await installWallet(context);
});

type World = { status: "pending" | "approved" | "denied" | "failed"; reason: string | null };

/**
 * Puts the World gate in front of `action`: without `X-World-Approval` it answers the 428 the API sends,
 * with one it answers `retry` (or falls through to the plan fake, which carries out the action). `popup`
 * is what World does in its window: `"stay"` keeps it on World's own page with nothing answered yet;
 * `"approved"`/`"denied"` decide at once and send it back to the app's `/world/approved`, the way the
 * real callback does. Returns the `X-World-Approval` header of every call the action got.
 */
async function worldGate(
  page: Page,
  context: BrowserContext,
  appOrigin: string,
  opts: {
    action: "approve" | "open-pr";
    summary: Record<string, unknown>;
    popup: "stay" | "approved" | "denied";
    world: World;
    retry?: { status: number; body: unknown };
  },
) {
  const headers: Array<string | null> = [];
  await page.route(`${API}/v0/plans/*/${opts.action}`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: { ...CORS(route), "access-control-allow-headers": "content-type, idempotency-key, x-world-approval" },
      });
    }
    const approval = request.headers()["x-world-approval"] ?? null;
    headers.push(approval);
    if (!approval) {
      return json(
        route,
        {
          detail: {
            code: "human_approval_required",
            approval_id: APPROVAL_ID,
            start_url: `/v0/world/approvals/${APPROVAL_ID}/start`,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            summary: opts.summary,
          },
        },
        428,
      );
    }
    if (opts.retry) return json(route, opts.retry.body, opts.retry.status);
    return route.fallback();
  });

  const world = async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const path = new URL(request.url()).pathname;
    if (path === `/v0/world/approvals/${APPROVAL_ID}/start`) {
      if (opts.popup === "stay") {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<!doctype html><title>World ID</title><main style='font:16px system-ui;padding:24px'><h1>World ID</h1><p>Stand-in for World's own sign-in page.</p></main>",
        });
      }
      opts.world.status = opts.popup;
      opts.world.reason = opts.popup === "denied" ? "access_denied" : null;
      return route.fulfill({
        status: 302,
        headers: { location: `${appOrigin}/world/approved?approval=${APPROVAL_ID}&status=${opts.popup}` },
      });
    }
    if (path === `/v0/world/approvals/${APPROVAL_ID}`) {
      return json(route, { ...opts.world, expires_at: new Date(Date.now() + 300_000).toISOString() });
    }
    return json(route, { detail: "not found" }, 404);
  };
  // The page's own polls go through its page routes (which win over context routes); the popup is a new
  // page, so it only sees the context's.
  await page.route(`${API}/v0/world/**`, world);
  await context.route(`${API}/v0/world/**`, world);
  return headers;
}

const PLAN_SUMMARY = {
  plan_id: draftPlan().plan_id,
  goal: draftPlan().goal,
  repo_url: draftPlan().repo_url,
  ref: "main",
  funding: "wallet",
  total_budget_usdc_units: "1500000",
  tasks: [
    { index: 0, title: "Reproduce the failing refund", agents: ["2"], budget_usdc_units: "500000" },
    { index: 1, title: "Fix the refund rounding", agents: ["1"], budget_usdc_units: "1000000" },
  ],
};

async function openDraftAndApprove(page: Page) {
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  await page.getByRole("group", { name: "Task 1" }).getByLabel("Task 1: runs it").selectOption("2");
  await page.getByRole("group", { name: "Task 2" }).getByLabel("Task 2: runs it").selectOption("1");
  await page.getByRole("button", { name: "Approve plan" }).click();
}

const dialog = (page: Page) => page.getByRole("dialog");

test("approving a plan shows what World ID will approve, then retries with the approval", async ({
  page,
  context,
}, info) => {
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  const world: World = { status: "pending", reason: null };
  const headers = await worldGate(page, context, String(info.project.use.baseURL), {
    action: "approve",
    summary: PLAN_SUMMARY,
    popup: "approved",
    world,
  });

  await openDraftAndApprove(page);
  const box = dialog(page);
  await expect(box.getByRole("heading", { name: "Confirm with World ID" })).toBeVisible();
  await expect(box).toContainText("The refund test in payments/ passes again");
  await expect(box).toContainText("Total budget 1.50 USDC");
  await expect(box).toContainText("Fix the refund rounding");
  await shot(page, "01-plan-approval-dialog");

  const popup = page.waitForEvent("popup");
  await box.getByRole("button", { name: "Continue to World ID" }).click();
  await (await popup).waitForEvent("close"); // the landing page posts the result back and closes itself

  await expect(page.getByRole("heading", { name: "Fund 1.50 USDC" })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(headers).toEqual([null, APPROVAL_ID]);
});

test("while the World ID window is open the page says so, and Cancel gives up without approving", async ({
  page,
  context,
}, info) => {
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  const world: World = { status: "pending", reason: null };
  const headers = await worldGate(page, context, String(info.project.use.baseURL), {
    action: "approve",
    summary: PLAN_SUMMARY,
    popup: "stay",
    world,
  });

  await openDraftAndApprove(page);
  const popupEvent = page.waitForEvent("popup");
  await dialog(page).getByRole("button", { name: "Continue to World ID" }).click();
  const popup = await popupEvent;
  await expect(popup.getByRole("heading", { name: "World ID" })).toBeVisible();

  const box = dialog(page);
  await expect(box.getByRole("heading", { name: "Waiting for World ID…" })).toBeVisible();
  await expect(box.getByRole("button", { name: "Continue to World ID" })).toHaveCount(0);
  await expect(box.getByRole("status")).toContainText("Finish the check in the World ID window");
  await page.bringToFront();
  await shot(page, "02-waiting-for-world-id");

  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText("You cancelled the World ID check. Nothing was done.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve plan" })).toBeEnabled();
  await shot(page, "03-cancelled");
  expect(popup.isClosed()).toBe(true); // Cancel closes the window it opened
  expect(headers).toEqual([null]); // never retried with an approval
});

test("on a phone, scrolled down to the approve button, the waiting dialog and its Cancel are on screen", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  const world: World = { status: "pending", reason: null };
  await worldGate(page, context, String(info.project.use.baseURL), {
    action: "approve",
    summary: PLAN_SUMMARY,
    popup: "stay",
    world,
  });

  await openDraftAndApprove(page);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0); // the button is far down the page
  const popupEvent = page.waitForEvent("popup");
  await dialog(page).getByRole("button", { name: "Continue to World ID" }).click();
  await popupEvent;
  await page.bringToFront();

  const box = dialog(page);
  await expect(box.getByRole("heading", { name: "Waiting for World ID…" })).toBeVisible();
  const cancel = box.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  const rect = await box.boundingBox();
  expect(rect).not.toBeNull();
  if (rect) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(390);
    expect(rect.y + rect.height).toBeLessThanOrEqual(844);
  }
  await shot(page, "02b-waiting-for-world-id-phone");
});

test("a denial at World says why, instead of a generic refusal", async ({ page, context }, info) => {
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  const world: World = { status: "pending", reason: null };
  const headers = await worldGate(page, context, String(info.project.use.baseURL), {
    action: "approve",
    summary: PLAN_SUMMARY,
    popup: "stay",
    world,
  });

  await openDraftAndApprove(page);
  const popupEvent = page.waitForEvent("popup");
  await dialog(page).getByRole("button", { name: "Continue to World ID" }).click();
  await popupEvent;
  await expect(dialog(page).getByRole("heading", { name: "Waiting for World ID…" })).toBeVisible();

  // The callback recorded a denial; the page learns it from its next poll of the approval.
  Object.assign(world, { status: "denied", reason: "different_human" });
  await expect(page.getByText("That World ID is not the one linked to your Mergit account.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog(page)).toHaveCount(0);
  await page.bringToFront();
  await shot(page, "04-denied-with-reason");
  expect(headers).toEqual([null]);
});

test("an approval the action then refuses says what was wrong with it, not who may approve", async ({
  page,
  context,
}, info) => {
  await mockBackend(page);
  await mockPlanApi(page, { plans: [draftPlan()] });
  const world: World = { status: "pending", reason: null };
  await worldGate(page, context, String(info.project.use.baseURL), {
    action: "approve",
    summary: PLAN_SUMMARY,
    popup: "approved",
    world,
    retry: { status: 403, body: { detail: { code: "human_approval_invalid", reason: "action_mismatch" } } },
  });

  await openDraftAndApprove(page);
  const popup = page.waitForEvent("popup");
  await dialog(page).getByRole("button", { name: "Continue to World ID" }).click();
  await (await popup).waitForEvent("close");

  await expect(page.getByText(/changed after you approved it/)).toBeVisible();
  await expect(page.getByText("Only the requester who created this plan can do that.")).toHaveCount(0);
  await shot(page, "05-retry-refused-action-mismatch");
});

test("the World ID popup's landing page renders on its own, signed out or not", async ({ page }) => {
  // Opened directly (no opener to post to), it must still render rather than throw.
  await page.goto(`/world/approved?approval=${APPROVAL_ID}&status=approved`);
  await expect(page.getByText("You can close this window.")).toBeVisible();
  await shot(page, "06-world-approved-landing");
});

test("opening a pull request asks for World ID with the exact change it would open", async ({
  page,
  context,
}, info) => {
  await mockBackend(page);
  const plan = approvedPlan({
    state: "done",
    attempts: [
      attempt(0, 1, { status: "done", phi_holds: true, receipt_root: `0x${"ee".repeat(32)}` }),
      attempt(1, 1, { status: "done", phi_holds: true, receipt_root: `0x${"ee".repeat(32)}` }),
    ],
  });
  await mockPlanApi(page, { plans: [plan], pr: { after: ["running", "done"] } });
  const world: World = { status: "pending", reason: null };
  const diffSha = "9f2c1e0b7a6d5c4b3a29180f7e6d5c4b3a2918077e6d5c4b3a29180f7e6d5c4b";
  const headers = await worldGate(page, context, String(info.project.use.baseURL), {
    action: "open-pr",
    summary: { plan_uuid: plan.plan_uuid, repo_url: plan.repo_url, diff_sha256: diffSha },
    popup: "approved",
    world,
  });

  await page.goto(`/app/runs/${plan.plan_uuid}`);
  const step = page.getByRole("region", { name: "Open a pull request" });
  await step.getByRole("button", { name: "Open the pull request" }).click();

  const box = dialog(page);
  await expect(box.getByRole("heading", { name: "Confirm with World ID" })).toBeVisible();
  await expect(box).toContainText("https://github.com/acme/widgets");
  await expect(box).toContainText(diffSha);
  await shot(page, "07-open-pr-dialog");

  const popup = page.waitForEvent("popup");
  await box.getByRole("button", { name: "Continue to World ID" }).click();
  await (await popup).waitForEvent("close");
  await expect(step).toContainText("Pull request #7 is open.", { timeout: 15_000 });
  expect(headers).toEqual([null, APPROVAL_ID]);
});
