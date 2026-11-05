import { createDecipheriv } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { LIVE_ENV } from "../../playwright.config";
import { seedSession } from "../fixtures";
import { CORS, installWallet, json, ME, mockBackend } from "./fake";
import { draftPlan, mockPlanApi } from "./plans";

/**
 * A credits-funded approval from an account with no World ID claim yet (a trial started before IDKit was
 * switched on): the API answers `428 world_proof_required`, and the page offers the World ID check right
 * there, opening the real `@worldcoin/idkit` widget with the server's `rp_id` and `environment`. The API is
 * faked on the live API host, as in run.spec.ts, and World's bridge on its own host: nothing leaves the
 * machine. The bridge fake keeps what the widget sent, and the test decrypts it with the key in the
 * widget's own connect link -- so it checks what World App would really be asked for (World ID 4.0 only,
 * the Selfie Check credential, the server's environment), not just which props the widget was handed.
 *
 * Set WORLD_SHOTS_DIR to also save a screenshot of each state.
 */

const API = LIVE_ENV.VITE_API_URL;
const SHOTS = process.env.WORLD_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.beforeEach(async ({ context }) => {
  await seedSession(context, ME);
  await installWallet(context);
});

async function worldIdkitOn(page: Page, preset: "selfie_check" | "proof_of_human" = "selfie_check") {
  const signed: unknown[] = [];
  await page.route(`${API}/v0/world/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const path = new URL(request.url()).pathname;
    if (path === "/v0/world/config") {
      return json(route, {
        idkit: {
          enabled: true,
          app_id: "app_staging_0123456789abcdef",
          rp_id: "rp_0123456789abcdef",
          action: "mergit-free-trial",
          preset,
          environment: "staging",
        },
        agent_pass: { enabled: false },
      });
    }
    if (path === "/v0/world/rp-context") {
      const body = request.postDataJSON() as { action: string };
      signed.push(body);
      // A real signature (IDKit refuses a malformed one before it opens), by a throwaway key.
      const rp = signRequest({ signingKeyHex: `0x${"ab".repeat(32)}`, action: body.action });
      return json(route, { sig: rp.sig, nonce: rp.nonce, created_at: rp.createdAt, expires_at: rp.expiresAt });
    }
    return json(route, { detail: "not found" }, 404);
  });
  return signed;
}

/** World's bridge, faked: `POST /request` keeps the encrypted request; polls say nobody has connected yet. */
async function fakeBridge(page: Page) {
  const sent: Array<{ iv: string; payload: string }> = [];
  await page.route("https://bridge.worldcoin.org/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS(route) });
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/request") {
      sent.push(request.postDataJSON() as { iv: string; payload: string });
      return json(route, { request_id: "11111111-2222-4333-8444-555555555555" });
    }
    return json(route, { status: "initialized" });
  });
  return sent;
}

/** What the widget asked World App for: its AES-256-GCM payload, opened with the key in the connect link. */
function opened(sent: { iv: string; payload: string }, connectUrl: string): Record<string, unknown> {
  const key = Buffer.from(new URL(connectUrl).searchParams.get("k") ?? "", "base64");
  const data = Buffer.from(sent.payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sent.iv, "base64"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}

async function approveWithCredits(page: Page) {
  await page.goto(`/app/runs/${draftPlan().plan_uuid}`);
  await page.getByLabel("Task 1: runs it").selectOption("1");
  await page.getByLabel("Task 2: runs it").selectOption("2");
  await page.getByRole("radio", { name: "Free credits" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
}

async function refuseApproveWithWorldProofRequired(page: Page) {
  const approves: unknown[] = [];
  await page.route(`${API}/v0/plans/*/approve`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: { ...CORS(route), "access-control-allow-headers": "content-type, idempotency-key, x-world-approval" },
      });
    }
    approves.push(route.request().postDataJSON());
    return json(route, { detail: "world_proof_required" }, 428);
  });
  return approves;
}

test("a credits approval with no World ID claim yet offers the check instead of saying the credits were used", async ({
  page,
}) => {
  await mockBackend(page, { credits: { granted: "5000000", spent: "0", remaining: "5000000", plans_today: 0 } });
  await mockPlanApi(page, { plans: [draftPlan()] });
  const signed = await worldIdkitOn(page);
  const bridge = await fakeBridge(page);
  const approves = await refuseApproveWithWorldProofRequired(page);

  await approveWithCredits(page);

  await expect(
    page.getByText("Free credits need a one-time World ID check on this account first. Nothing was approved."),
  ).toBeVisible();
  await expect(page.getByText("world_proof_required")).toHaveCount(0);
  await expect(page.getByText("already used")).toHaveCount(0);
  const verify = page.getByRole("button", { name: "Verify with World ID" });
  await expect(verify).toBeEnabled();
  expect(approves).toHaveLength(1);
  await shot(page, "10-credits-need-world-id");

  // The real IDKit widget opens: it refuses to without a well-formed `rp_id` and a valid signature, and it
  // is asked to sign for the trial's own action only.
  await verify.click();
  await expect.poll(() => signed).toEqual([{ action: "mergit-free-trial" }]);
  const link = page.locator('a[href^="https://"][href*="t=wld"]').first();
  await expect(link).toBeAttached();
  await expect.poll(() => bridge.length).toBe(1);
  const [request] = bridge;
  if (!request) throw new Error("the widget never reached the bridge");
  const asked = opened(request, (await link.getAttribute("href")) ?? "");
  expect(asked).toMatchObject({
    app_id: "app_staging_0123456789abcdef",
    action: "mergit-free-trial",
    environment: "staging",
    allow_legacy_proofs: false,
  });
  const proofRequest = asked.proof_request as { rp_id: string; proof_requests: Array<{ identifier: string }> };
  expect(proofRequest.rp_id).toBe("rp_0123456789abcdef");
  expect(proofRequest.proof_requests.map((r) => r.identifier)).toEqual(["selfie"]);
  await expect(page.getByRole("alert").filter({ hasText: "could not complete" })).toHaveCount(0);
  await page.waitForTimeout(500); // the QR code draws after the modal opens
  await shot(page, "11-idkit-widget-open");
});

test("an Orb (proof_of_human) deployment asks World App for a 4.0 proof only, with no legacy fallback", async ({
  page,
}) => {
  // IDKit's own `proofOfHuman()` preset turns `allow_legacy_proofs` back on whatever it is told; the server
  // refuses every 3.0 proof, so the widget must not invite one.
  await mockBackend(page, { credits: { granted: "5000000", spent: "0", remaining: "5000000", plans_today: 0 } });
  await mockPlanApi(page, { plans: [draftPlan()] });
  await worldIdkitOn(page, "proof_of_human");
  const bridge = await fakeBridge(page);
  await refuseApproveWithWorldProofRequired(page);

  await approveWithCredits(page);
  await page.getByRole("button", { name: "Verify with World ID" }).click();
  const link = page.locator('a[href^="https://"][href*="t=wld"]').first();
  await expect(link).toBeAttached();
  await expect.poll(() => bridge.length).toBe(1);
  const [request] = bridge;
  if (!request) throw new Error("the widget never reached the bridge");
  const asked = opened(request, (await link.getAttribute("href")) ?? "");
  expect(asked).toMatchObject({ environment: "staging", allow_legacy_proofs: false });
  const proofRequest = asked.proof_request as { proof_requests: Array<{ identifier: string }> };
  expect(proofRequest.proof_requests.map((r) => r.identifier)).toEqual(["proof_of_human"]);
});
