// The publish success experience, as a person sees it.
//
// The panel sits above every conversation forever, so it has two states: expanded for the moment
// after a publish, then settled. These assert both, plus the two defects that made the celebration
// meaningless — it belonged to no project, and it never ended.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch { return null; }
}
const REF = supabaseRef();

const SESSION = {
  access_token: "e2e-fake-token", refresh_token: "e2e-fake-refresh", token_type: "bearer",
  expires_in: 86_400, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" },
    app_metadata: { provider: "email" }, created_at: "2026-01-01T00:00:00Z",
  },
};

const PROJECT = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const DEPLOY_ID = "22222222-2222-4222-8222-222222222222";

const deployment = (over = {}) => ({
  id: DEPLOY_ID, number: 7, status: "live", environment: "production", triggeredByKind: "user",
  buildRunId: RUN, buildDurationMs: 1800, deployDurationMs: 300,
  deployedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  createdAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  url: "https://focusflow.app.thrallo.com", failureReason: null, rolledBackFrom: null,
  sourceAvailable: true, ...over,
});

const site = ({ deploy = deployment(), lastAttempt = null } = {}) => ({
  projectId: PROJECT, currentProjectId: PROJECT, productId: "prod-1", name: "FocusFlow",
  slug: "focusflow", url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
  live: true, updateAvailable: false, status: "published", customDomain: null, domains: [],
  deployment: deploy, lastAttempt: lastAttempt || deploy,
});

async function stub(page, { state = site(), deployments = [deployment()] } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);

  const conversation = {
    id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1",
    publishStatus: "published", site: state,
  };
  const listRoute = (r) => r.fulfill({ json: {
    conversations: [conversation], counts: { all: 1, published: 1, drafts: 0, updates: 0 },
    page: { offset: 0, limit: 20, total: 1, nextOffset: null, tab: "all", search: null },
  } });
  await page.route("**/api/v1/conversations", listRoute);
  await page.route("**/api/v1/conversations?**", listRoute);
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route(/\/api\/v1\/conversations\/c\d+$/, (r) => r.fulfill({ json: { conversation, turns: [] } }));
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [state] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route("**/api/v1/projects/*/deployments", (r) => r.fulfill({ json: { deployments } }));
  await page.route("**/api/v1/projects/*/health", (r) => r.fulfill({ json: { status: null, uptime: null, checks: 0, windowDays: 30, responseTime: null, daily: [], incidents: [], recent: [] } }));
  await page.route("**/api/v1/projects/*/domains", (r) => r.fulfill({ json: { domains: [], allowance: { plan: "pro", limit: null, used: 0, unlimited: true } } }));
  await page.route("**/api/v1/projects/*/logs**", (r) => r.fulfill({ json: { entries: [], nextCursor: null, retentionDays: null, plan: "pro" } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const panel = (page) => page.locator(".ct-published");
const openConversation = async (page) => {
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).locator(".ct-pname").click();
  await expect(panel(page)).toBeVisible();
};

// ── The resting panel ───────────────────────────────────────────────────────────────────

test("the resting panel names the version and stays small", async ({ page }) => {
  await stub(page);
  await openConversation(page);

  await expect(panel(page)).toContainText("LIVE");
  await expect(panel(page)).toContainText("#7");
  await expect(panel(page)).toContainText("Last published");

  // Everything else is one click away rather than nine permanent buttons.
  await expect(panel(page).getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: /More/ }).click();
  await expect(panel(page).getByRole("button", { name: "Unpublish" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "View Analytics" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Project Settings" })).toBeVisible();
});

test("Open Site opens a new tab and never hands over the opener", async ({ page }) => {
  await stub(page);
  await openConversation(page);
  const open = panel(page).getByRole("link", { name: "Open Site" });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noopener/);
});

test("the version opens Deployments focused on that deployment", async ({ page }) => {
  await stub(page);
  await openConversation(page);
  await panel(page).getByRole("button", { name: "#7" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/deployments`);
  await expect.poll(() => new URL(page.url()).searchParams.get("ref")).toBe(DEPLOY_ID);
  // And the card is marked so the reader does not have to hunt for it.
  await expect(page.locator(`#deployment-${DEPLOY_ID}`)).toHaveClass(/is-focused/);
});

test("View Logs from the panel opens that build, not the whole stream", async ({ page }) => {
  await stub(page);
  await openConversation(page);
  await panel(page).getByRole("button", { name: /More/ }).click();
  await panel(page).getByRole("button", { name: "View Logs" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/logs`);
  await expect.poll(() => new URL(page.url()).searchParams.get("ref")).toBe(RUN);
});

test("with no build run recorded, View Logs is absent rather than misleading", async ({ page }) => {
  await stub(page, { state: site({ deploy: deployment({ buildRunId: null }) }) });
  await openConversation(page);
  await panel(page).getByRole("button", { name: /More/ }).click();
  await expect(panel(page).getByRole("button", { name: "View Logs" })).toHaveCount(0);
});

// ── Failure and progress ────────────────────────────────────────────────────────────────

test("a failed publish names what is still serving", async ({ page }) => {
  await stub(page, {
    state: site({
      lastAttempt: deployment({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", number: 8, status: "failed",
        failureReason: "ENOSPC: no space left on device", deployedAt: null,
      }),
    }),
  });
  await openConversation(page);

  // The useful sentence is which version people are getting, because the answer is "the old one".
  await expect(panel(page)).toContainText("Deployment #8 failed");
  await expect(panel(page)).toContainText("#7 is still serving");
  await expect(panel(page)).toContainText("ENOSPC");
  await expect(panel(page)).toContainText("LIVE", { timeout: 5_000 });
});

test("a publish in flight is announced without disturbing what is live", async ({ page }) => {
  await stub(page, {
    state: site({
      lastAttempt: deployment({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", number: 8, status: "building", deployedAt: null,
      }),
    }),
  });
  await openConversation(page);
  await expect(panel(page)).toContainText("Deployment #8 is going out");
  await expect(panel(page)).toContainText("#7", "the live version is still named");
});

// ── The celebration ─────────────────────────────────────────────────────────────────────

// Drives the REAL path: the server announces a publish over the conversation event stream, and
// ChatShell's own handler reacts. No test hook in production code — a hook would prove that the
// hook works, not that publishing does.
const publishedFrame = (projectId, number = 7) => `data: ${JSON.stringify({
  sequence: 1, type: "published",
  payload: { url: "https://focusflow.app.thrallo.com", slug: "focusflow", projectId, deploymentNumber: number },
})}\n\n`;

// The settle itself is not asserted here: the window is build-time configuration, and adding a
// runtime override purely so a test could shorten it would be a seam in production code. That the
// timer exists and the duration is configurable is covered in publish-experience.test.mjs.
test("the celebration appears on publish and names the version", async ({ page }) => {
  await stub(page);
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({
    contentType: "text/event-stream", body: publishedFrame(PROJECT),
  }));

  await openConversation(page);
  await expect(panel(page)).toContainText("Your app is live");
  await expect(panel(page)).toContainText("deployment #7");
  // Sub-second durations read as milliseconds: "deployed in 300ms" is clearer than "0.3s".
  await expect(panel(page)).toContainText("Built in 1.8s");
  await expect(panel(page)).toContainText("deployed in 300ms");
  // The moment's actions, which are not permanent chrome.
  await expect(panel(page).getByRole("button", { name: "Share" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "View Analytics" })).toBeVisible();

  // And the conversational record names the version rather than repeating the panel.
  await expect(page.locator(".ct-thread-wrap")).toContainText("Deployment #7 is live");
});

test("the celebration does not leak to another project", async ({ page }) => {
  // Publishing project A used to make project B celebrate: `celebrate={!!justPublished}` held a
  // projectId and compared only its truthiness.
  await stub(page);
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({
    contentType: "text/event-stream", body: publishedFrame("99999999-9999-4999-8999-999999999999"),
  }));
  await openConversation(page);
  await expect(panel(page)).toContainText("LIVE");
  await expect(panel(page)).not.toContainText("Your app is live");
});
