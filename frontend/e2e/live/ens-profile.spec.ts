import { expect, test, type Page } from "@playwright/test";
import { LIVE_ENV } from "../../playwright.config";
import { CORS, installWallet, json, mockBackend } from "./fake";

/**
 * The public agent profile (/agents/<label>), the page an agent's ENS `agent-endpoint[web]` record names. It opens
 * signed out and after a reload. Chain answers come from src/chain/ens/stubClients.ts (VITE_ENS_READER=stub) and go
 * through the real two-way check, one agent per outcome; the rule under test is that a tick only ever follows a
 * verified reading.
 */

/** The platform's public agent list: agent N is named after its fixture's label. */
const ROSTER = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x, i) => ({
  agent_id: String(i + 1),
  name: `coder-${x}`,
  model: "claude-sonnet-5",
}));

async function serveRoster(page: Page) {
  await page.route(`${LIVE_ENV.VITE_API_URL}/v0/agents`, (route) =>
    route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS(route) }) : json(route, ROSTER),
  );
}

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("mergit-intro-seen", "1");
  });
  await installWallet(context);
  await mockBackend(page, { me: null });
  await serveRoster(page);
});

const badge = (page: Page) => page.locator("main [data-ens-state]").first();

test("opens without signing in, shows the name, records, writers and mirror, and survives a reload", async ({
  page,
}) => {
  await page.goto("/agents/coder-a");
  for (const pass of ["first load", "after reload"]) {
    await expect(page.getByRole("heading", { level: 1 }), pass).toHaveText("coder-a.mergit.eth");
    await expect(badge(page), pass).toHaveAttribute("data-ens-state", "verified");
    await expect(badge(page), pass).toHaveText("Two-way verified");
    await expect(page.getByRole("dialog"), pass).toHaveCount(0); // no Connect window: the page is public
    const records = page.locator("table.ap-records");
    await expect(records, pass).toContainText("agent-endpoint[web]");
    await expect(records.locator("tr", { hasText: "mergit.reputation" }), pass).toContainText("0x4444…4444");
    await expect(page.getByTestId("track-record"), pass).toContainText("bugfix");
    await expect(page.getByTestId("mirror-note"), pass).toContainText("as of block 23,456,789");
    await expect(page.getByTestId("mirror-note"), pass).toContainText("not a score");
    if (pass === "first load") await page.reload();
  }
  await expect(page).toHaveURL(/\/agents\/coder-a$/);
});

const NOT_VERIFIED: Array<[label: string, state: string, text: string, reason: RegExp]> = [
  ["coder-b", "owner-changed", "Owner changed, not verified", /was sold since ENS was last updated/],
  ["coder-c", "unconfirmed", "Linked, owner not confirmed", /sale cannot be ruled out/],
  ["coder-d", "not-verified", "Not verified", /names a different ENS name/],
  ["coder-e", "not-verified", "Not verified", /does not attest to this agent/],
  ["coder-f", "not-verified", "Not verified", /registration file could not be fetched/],
  ["coder-h", "not-verified", "Not verified", /could not be read, so the link cannot be confirmed/],
];

for (const [label, state, text, reason] of NOT_VERIFIED) {
  test(`${label}: shows "${text}" with its reason and no tick`, async ({ page }) => {
    await page.goto(`/agents/${label}`);
    await expect(badge(page)).toHaveAttribute("data-ens-state", state);
    await expect(badge(page)).toHaveText(text);
    await expect(page.getByTestId("ens-reason")).toContainText(reason);
    await expect(page.locator('[data-ens-state="verified"]')).toHaveCount(0);
  });
}

test("a malformed reputation record shows no counts instead of breaking the page", async ({ page }) => {
  await page.goto("/agents/coder-g");
  await expect(badge(page)).toHaveAttribute("data-ens-state", "verified");
  await expect(page.getByText("not in the documented shape")).toBeVisible();
  await expect(page.getByTestId("track-record")).toHaveCount(0);
});

test("a name no agent has says there is no such agent", async ({ page }) => {
  await page.goto("/agents/nobody-here");
  await expect(page.getByTestId("no-such-agent")).toHaveText("No agent is named nobody-here.mergit.eth.");
  await expect(page.locator("[data-ens-state]")).toHaveCount(0);
});

test("a signed-out profile visit asks for no plan data and gets no 401", async ({ page }) => {
  const calls = await mockBackend(page, { me: null });
  await serveRoster(page);
  const refused: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 401) refused.push(new URL(r.url()).pathname);
  });
  await page.goto("/agents/coder-a");
  await expect(badge(page)).toHaveAttribute("data-ens-state", "verified");
  expect(calls.some((c) => c.path.startsWith("/v0/plans"))).toBe(false);
  expect(refused).toEqual([]);
});
