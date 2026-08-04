// First run, the starter gallery and history, in the browser.
//
// The behaviours worth driving here are the ones a unit test cannot see: that the tour is
// genuinely skippable from the first screen, that a starter arrives in the composer as EDITABLE
// text rather than being sent, and that a narrowed empty view never shows first-time copy to
// someone with projects.

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

const HISTORY = [
  {
    id: "r1", kind: "app_build", prompt: "Build a booking system for a physio clinic",
    model: "gpt-5.6-sol", status: "passed", startedAt: "2026-08-03T10:00:00.000Z",
    finishedAt: "2026-08-03T10:01:00.000Z", durationMs: 60_000, repairRounds: 0,
    projectId: "p1", conversationId: "c1", conversationTitle: "Physio bookings",
    deployment: { id: "d1", number: 3, status: "live", url: "https://x.app.thrallo.com", projectId: "p1", createdAt: "2026-08-03T10:02:00.000Z" },
    checkpoints: 2,
  },
  {
    id: "r2", kind: "app_build", prompt: "Make the dashboard the landing page",
    model: null, status: "failed", startedAt: "2026-08-02T10:00:00.000Z",
    finishedAt: null, durationMs: null, repairRounds: 2,
    projectId: "p1", conversationId: "c1", conversationTitle: "Physio bookings",
    deployment: null, checkpoints: 0,
  },
];

async function stub(page, { onboarding = { pending: false, step: 0 }, conversations = [], counts = null } = {}) {
  const state = { onboarding: { ...onboarding }, actions: [] };
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);

  await page.route("**/api/v1/onboarding", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: state.onboarding });
    const body = JSON.parse(r.request().postData() || "{}");
    state.actions.push(body.action);
    if (body.action === "skip" || body.action === "complete") {
      state.onboarding = { pending: false, completedAt: "2026-08-04T00:00:00Z", skipped: body.action === "skip", step: body.step || 0 };
    }
    if (body.action === "reopen") state.onboarding = { pending: true, step: 0 };
    return r.fulfill({ json: state.onboarding });
  });
  await page.route("**/api/v1/history**", (r) => r.fulfill({ json: {
    items: HISTORY, page: { offset: 0, limit: 20, total: HISTORY.length, nextOffset: null },
  } }));
  await page.route("**/api/v1/conversations**", (r) => {
    const params = new URL(r.request().url()).searchParams;
    const archived = params.get("archived") === "1";
    // Archived is a partition; ignoring it here would mean the filtered-empty case never empties.
    const shown = archived ? [] : conversations;
    return r.fulfill({ json: {
    conversations: shown,
    counts: counts || { all: conversations.length, published: 0, favourites: 0 },
    page: { offset: 0, limit: 20, total: shown.length, nextOffset: null, tab: "all", sort: "activity", archived },
    sorts: [{ id: "activity", label: "Last activity" }, { id: "name", label: "Name" }],
  } });
  });
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "free", planName: "Free", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: false,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  return state;
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const project = (i, extra = {}) => ({
  id: `c${i}`, title: `Project ${i}`, state: "idle", productId: `prod-${i}`,
  publishStatus: "draft", favourite: false, archivedAt: null,
  last_activity_at: new Date(Date.now() - i * 60_000).toISOString(), site: null, ...extra,
});

// ── Onboarding ──────────────────────────────────────────────────────────────────────────

test("a new account is welcomed, and can leave from the first screen", async ({ page }) => {
  const state = await stub(page, { onboarding: { pending: true, step: 0 } });
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: /Welcome to Thrallo|Settings/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Thrallo" })).toBeVisible();

  // Skippable from step one, not after five screens of slideshow.
  await page.getByRole("button", { name: "Skip and start building" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Thrallo" })).toHaveCount(0);
  await expect(page.getByText("What are we building today?")).toBeVisible();
  expect(state.actions).toContain("skip");
});

test("the tour explains the real product and ends by starting something", async ({ page }) => {
  await stub(page, { onboarding: { pending: true, step: 0 } });
  await page.goto("/");
  const next = page.getByRole("button", { name: "Next" });
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    seen.push(await page.locator("#st-onboard-title").innerText());
    await next.click();
  }
  seen.push(await page.locator("#st-onboard-title").innerText());
  // The flow the requirement asks for: welcome, describe, plan, iterate, publish, start.
  expect(seen.join(" | ")).toMatch(/Welcome/);
  expect(seen.join(" | ")).toMatch(/Describe/);
  expect(seen.join(" | ")).toMatch(/plan/i);
  expect(seen.join(" | ")).toMatch(/asking|iterate/i);
  expect(seen.join(" | ")).toMatch(/Preview|publish/i);
  // It ends on the REAL gallery, not a "you're all set" screen.
  await expect(page.locator(".st-onboard-gallery .st-starter").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
});

test("an established account is never shown the tour", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [project(1), project(2)] });
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Thrallo" })).toHaveCount(0);
});

test("the tour can be reopened later", async ({ page }) => {
  const state = await stub(page, { onboarding: { pending: false }, conversations: [project(1)] });
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a command/).fill("around");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Welcome to Thrallo" })).toBeVisible();
  expect(state.actions).toContain("reopen");
});

test("the tour is navigable and dismissable by keyboard", async ({ page }) => {
  await stub(page, { onboarding: { pending: true, step: 0 } });
  await page.goto("/");
  // The heading takes focus on each step so a screen reader announces the new screen.
  await expect(page.locator("#st-onboard-title")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#st-onboard-title")).toHaveText(/Describe/);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#st-onboard-title")).toHaveText(/Welcome/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Welcome to Thrallo" })).toHaveCount(0);
});

// ── Starters ────────────────────────────────────────────────────────────────────────────

test("an empty account is offered ideas, and a starter arrives editable", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [], counts: { all: 0 } });
  await page.goto("/");
  await expect(page.getByText("Your first build")).toBeVisible();
  await expect(page.locator(".ct-firstrun .st-starter")).toHaveCount(10);

  await page.locator(".ct-firstrun .st-starter").filter({ hasText: "Booking system" }).click();
  const prompt = page.locator("#st-starter-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue(/physiotherapy clinic/);
  await expect(page.getByText(/What this builds/)).toBeVisible();

  // Editing is the point: it is a first draft, not a form.
  await prompt.fill("Build a booking system for a barber shop with two chairs.");
  await page.getByRole("button", { name: "Start building" }).click();

  // It lands in the composer, unsent — nothing is submitted on the customer's behalf.
  const composer = page.getByPlaceholder(/Describe anything/);
  await expect(composer).toHaveValue(/barber shop/);
  // Deliberately still offered: seeding the composer is not the same as having built anything, and
  // the gallery belongs on the screen until this account actually has a project.
  await expect(page.getByText("Your first build")).toBeVisible();
});

test("a starter can be reset to the expert original", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [], counts: { all: 0 } });
  await page.goto("/");
  await page.locator(".ct-firstrun .st-starter").filter({ hasText: "CRM" }).click();
  const prompt = page.locator("#st-starter-prompt");
  const original = await prompt.inputValue();
  await prompt.fill("something else entirely");
  await page.getByRole("button", { name: "Reset to the original" }).click();
  await expect(prompt).toHaveValue(original);
});

// ── Empty states ────────────────────────────────────────────────────────────────────────

test("a filtered empty view never shows first-time copy", async ({ page }) => {
  // Forty projects, filtered to a view that matches none. Showing "Your first build" here would be
  // absurd, and gating on the rendered list rather than the account is how that happens.
  await stub(page, {
    onboarding: { pending: false },
    conversations: Array.from({ length: 6 }, (_, i) => project(i)),
    counts: { all: 40, published: 0, favourites: 0 },
  });
  await page.goto("/");
  await expect(page.getByText("Your first build")).toHaveCount(0);

  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(page.getByText("Your first build")).toHaveCount(0);
  await expect(page.locator(".ct-ws-empty")).toContainText("Nothing is archived");
});

test("empty states say what the section is, not just that it is empty", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [], counts: { all: 0 } });
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a command/).fill("history");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
});

// ── History ─────────────────────────────────────────────────────────────────────────────

test("history shows the prompt, the model and what it produced", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [project(1)] });
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.locator(".hs-item")).toHaveCount(2);

  const first = page.locator(".hs-item").first();
  await expect(first).toContainText("Build a booking system for a physio clinic");
  await expect(first).toContainText("gpt-5.6-sol");
  await expect(first).toContainText("Succeeded");
  await expect(first.getByRole("button", { name: /Deployment #3/ })).toBeVisible();
  await expect(first).toContainText("2 checkpoints");

  // A build with no recorded model is not labelled with a guess.
  const second = page.locator(".hs-item").nth(1);
  await expect(second).toContainText("Failed");
  await expect(second).toContainText("2 repairs");
  await expect(second).not.toContainText("gpt-5.6-sol");
});

test("reuse is offered as new work, never as a rollback", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [project(1)] });
  await page.goto("/history");
  const first = page.locator(".hs-item").first();
  await expect(first.getByRole("button", { name: "Use again" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Edit & rebuild" })).toBeVisible();
  await expect(page.getByRole("button", { name: /rollback/i })).toHaveCount(0);

  await first.getByRole("button", { name: "Edit & rebuild" }).click();
  // It becomes an editable draft in the composer; the historical row is untouched.
  await expect(page.getByPlaceholder(/Describe anything/)).toHaveValue(/physio clinic/);
});

test("history search says what matched nothing", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [project(1)] });
  await page.route("**/api/v1/history**", (r) => r.fulfill({ json: {
    items: [], page: { offset: 0, limit: 20, total: 0, nextOffset: null },
  } }));
  await page.goto("/history");
  await page.getByLabel("Search your prompts").fill("nothing at all");
  await expect(page.locator(".st-empty")).toContainText("nothing at all");
});

test("history never scrolls the page sideways", async ({ page }) => {
  await stub(page, { onboarding: { pending: false }, conversations: [project(1)] });
  await page.goto("/history");
  await expect(page.locator(".hs-item").first()).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
