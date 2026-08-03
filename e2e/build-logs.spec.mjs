// Build logs: the build source, deep links, and navigation.
//
// The defect behind this file was invisible from the UI. diag_steps was queried by `owner` and
// `project_id` — columns that table does not have — and the resulting error was swallowed by a
// `.catch(() => [])`, so the Build source rendered as a project that had never been built. These
// assert on what a person actually sees, and on the URL, which is what makes a build linkable.

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

const LIVE = {
  status: "published", live: true,
  projectId: "p1", productId: "prod-1", name: "FocusFlow",
  url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  updateAvailable: false, domains: [],
};

const RUNS = [
  { id: "run-newest", status: "passed", kind: "app_build", startedAt: "2026-08-03T10:00:00Z", finishedAt: "2026-08-03T10:02:00Z", durationMs: 120_000 },
  { id: "run-failed", status: "failed", kind: "app_build", startedAt: "2026-08-02T10:00:00Z", finishedAt: "2026-08-02T10:01:00Z", durationMs: 60_000 },
  { id: "run-cancelled", status: "cancelled", kind: "app_build", startedAt: "2026-08-01T10:00:00Z", finishedAt: null, durationMs: null },
];

const entriesFor = (ref) => {
  if (ref === "run-failed") {
    return [{ id: "b:2", at: "2026-08-02T10:00:30Z", seq: 2, level: "error", source: "build", message: "Builder — compile", detail: "ENOSPC: no space left on device", refType: "build", refId: "run-failed", durationMs: 900 }];
  }
  if (ref === "run-newest") {
    return [
      { id: "b:1", at: "2026-08-03T10:00:10Z", seq: 1, level: "info", source: "build", message: "Builder — plan", detail: null, refType: "build", refId: "run-newest", durationMs: 400 },
    ];
  }
  // Any other reference — cancelled, purged, or simply wrong — resolves to nothing, exactly as the
  // server does. Returning the full stream here would have hidden which empty state was shown.
  if (ref) return [];
  return [
    { id: "l:1", at: "2026-08-03T10:05:00Z", level: "info", source: "publish", message: "Publish complete", detail: null, refType: null, refId: null, durationMs: null },
    { id: "b:1", at: "2026-08-03T10:00:10Z", seq: 1, level: "info", source: "build", message: "Builder — plan", detail: null, refType: "build", refId: "run-newest", durationMs: 400 },
  ];
};

async function stub(page, { runs = RUNS, failLogs = false } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);

  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [
    { id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1", publishStatus: "published", site: LIVE },
  ] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [LIVE] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));

  await page.route("**/api/v1/projects/*/logs/runs", (r) => r.fulfill({ json: { runs } }));
  await page.route("**/api/v1/projects/*/logs/stream**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  // Scoped to the API path: a looser glob also intercepts the PAGE navigation to
  // /projects/p1/logs?ref=…, so the browser receives JSON instead of the app.
  await page.route("**/api/v1/projects/*/logs?**", (r) => {
    if (failLogs) return r.fulfill({ status: 500, json: { error: "Logs are unavailable right now. Please try again." } });
    const ref = new URL(r.request().url()).searchParams.get("ref") || null;
    return r.fulfill({ json: { entries: entriesFor(ref), nextCursor: null, retentionDays: null, plan: "pro", ref } });
  });

  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("build steps appear in the log stream", async ({ page }) => {
  await stub(page);
  await page.goto("/projects/p1/logs");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toBeVisible();
  // The whole point: a build step, with its real label, from a table that had to be reached
  // through its run.
  await expect(dash).toContainText("Builder — plan");
});

test("a deep link opens that exact build, and refresh keeps it", async ({ page }) => {
  await stub(page);
  await page.goto("/projects/p1/logs?ref=run-failed");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toContainText("Builder — compile");
  await expect(dash).toContainText("Showing one build");

  await page.reload();
  await expect(page.locator(".ct-projdash")).toContainText("Builder — compile",
    { timeout: 10_000 });
  expect(new URL(page.url()).searchParams.get("ref")).toBe("run-failed");
});

test("selecting a build puts it in the URL, and Back returns to the previous one", async ({ page }) => {
  await stub(page);
  await page.goto("/projects/p1/logs");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toBeVisible();

  await dash.getByRole("button", { name: /^Failed · / }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("ref")).toBe("run-failed");
  await expect(dash).toContainText("Builder — compile");

  await page.goBack();
  // Back must change what is on screen, not just the address bar.
  await expect.poll(() => new URL(page.url()).searchParams.get("ref")).toBe(null);
  await expect(dash).toContainText("Publish complete");
});

test("a cancelled build with no steps explains itself instead of looking broken", async ({ page }) => {
  await stub(page);
  await page.goto("/projects/p1/logs?ref=run-cancelled");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toContainText("This build recorded no steps");
});

test("a project that has never been built says so, rather than showing nothing", async ({ page }) => {
  await stub(page, { runs: [] });
  await page.goto("/projects/p1/logs?ref=nothing-here");
  await expect(page.locator(".ct-projdash")).toContainText("Nothing has happened here yet");
});

test("a log read failure is shown as an error, never as an empty log", async ({ page }) => {
  // The distinction this whole PR turns on: "nothing has happened" and "we could not find out"
  // must never look the same.
  await stub(page, { failLogs: true });
  await page.goto("/projects/p1/logs");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toContainText("Logs are unavailable right now");
  await expect(dash).not.toContainText("Nothing has happened here yet");
});

test("switching tabs is navigable, so Back leaves the dashboard tab by tab", async ({ page }) => {
  await stub(page);
  await page.goto("/projects/p1/overview");
  const dash = page.locator(".ct-projdash");
  await expect(dash).toBeVisible();

  await dash.getByRole("tab", { name: "Logs" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/projects/p1/logs");

  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/projects/p1/overview");
  await expect(dash.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});

test("a link to a build that retention has purged says so, not 'no steps'", async ({ page }) => {
  // An old bookmark after the retention window is expected, not a fault. Telling the two apart is
  // the difference between "your plan keeps 90 days" and a page that looks broken.
  await stub(page);
  await page.goto("/projects/p1/logs?ref=long-gone");
  await expect(page.locator(".ct-projdash")).toContainText("That build is no longer available");
});
