// The things that differ between rendering engines.
//
// Every other project in this matrix is Chromium at four viewport sizes, which proves four
// geometries of one engine. This runs on Gecko (Firefox) and WebKit as well, and asserts only what
// an engine can actually break: layout and overflow, focus behaviour, the CSS features the product
// depends on, and the streaming APIs it reads events with. Application logic is engine-independent
// and is covered once, at the four Chromium viewports.
//
// WebKit here is the ENGINE Safari uses, not Safari itself, and not iOS. That distinction, and
// what it leaves uncovered, is written down in PLATFORMS.md rather than glossed as "Safari passes".

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

const CONVERSATIONS = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i}`, title: `Project ${i}`, state: "idle", productId: `prod-${i}`,
  publishStatus: i === 0 ? "published" : "draft", favourite: false, archivedAt: null,
  last_activity_at: new Date(Date.now() - i * 60_000).toISOString(),
  site: i === 0 ? {
    projectId: "p0", currentProjectId: "p0", productId: "prod-0", name: "Project 0", slug: "proj-0",
    url: "https://proj-0.app.thrallo.com", environment: "production",
    publishedAt: "2026-08-01T00:00:00.000Z", firstPublishedAt: "2026-07-01T00:00:00.000Z",
    unpublishedAt: null, live: true, updateAvailable: false, status: "published", domains: [],
  } : null,
}));

async function stub(page) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);

  await page.route("**/api/v1/conversations**", (r) => r.fulfill({ json: {
    conversations: CONVERSATIONS,
    counts: { all: CONVERSATIONS.length, published: 1, favourites: 0 },
    page: { offset: 0, limit: 20, total: CONVERSATIONS.length, nextOffset: null, tab: "all", sort: "activity" },
    sorts: [{ id: "activity", label: "Last activity" }, { id: "name", label: "Name" }],
  } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [CONVERSATIONS[0].site] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "free", planName: "Free", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: false,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("the dashboard renders and never scrolls sideways", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => { if (!/localStorage/.test(error.message)) errors.push(error.message); });
  await stub(page);
  await page.goto("/");

  await expect(page.getByText("What are we building today?")).toBeVisible();
  await expect(page.locator(".ct-project").first()).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // A script error on one engine and not another is exactly what this project exists to catch.
  expect(errors).toEqual([]);
});

test("the CSS the layout depends on is supported", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // Each of these carries real layout weight somewhere in the product, and each has a history of
  // arriving late in one engine. Asserting support beats discovering it from a broken screenshot.
  const support = await page.evaluate(() => ({
    colorMix: CSS.supports("color", "color-mix(in srgb, red 50%, transparent)"),
    hasSelector: CSS.supports("selector(:focus-within)"),
    gridMinmax: CSS.supports("grid-template-columns", "repeat(auto-fit, minmax(120px, 1fr))"),
    sticky: CSS.supports("position", "sticky"),
    hoverQuery: window.matchMedia("(hover: none)").media !== "not all",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").media !== "not all",
  }));
  for (const [feature, ok] of Object.entries(support)) {
    expect(ok, `${feature} is unsupported on this engine`).toBe(true);
  }
});

test("the theme applies before first paint, on every engine", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("thrallo-theme", "dark"));
  await stub(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keyboard focus reaches the composer and the cards", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  const composer = page.getByPlaceholder(/Describe anything/);
  await composer.focus();
  await expect(composer).toBeFocused();

  // Cards are focusable in DOM order on every engine — WebKit in particular does not put
  // non-form controls in the tab order unless they carry an explicit tabindex, which these do.
  const card = page.locator(".ct-project").first();
  await card.focus();
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("tabindex", "0");
});

test("the event stream API the shell reads events with exists", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // The conversation stream is read with fetch + ReadableStream rather than EventSource, because
  // it needs an Authorization header. Both matter: logs use EventSource, conversations use the
  // reader. An engine missing either would break a core surface silently.
  const api = await page.evaluate(() => ({
    readableStream: typeof ReadableStream === "function",
    textDecoder: typeof TextDecoder === "function",
    eventSource: typeof EventSource === "function",
    abortController: typeof AbortController === "function",
    clipboard: !!navigator.clipboard,
  }));
  expect(api.readableStream).toBe(true);
  expect(api.textDecoder).toBe(true);
  expect(api.eventSource).toBe(true);
  expect(api.abortController).toBe(true);
  // Clipboard is permissioned rather than absent on some engines; the product already falls back,
  // so this is recorded, not required.
  expect(typeof api.clipboard).toBe("boolean");
});
