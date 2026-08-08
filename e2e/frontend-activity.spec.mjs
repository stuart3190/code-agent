import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

const REF = supabaseRef();
const SESSION = {
  access_token: "e2e-fake-token", refresh_token: "e2e-fake-refresh", token_type: "bearer",
  expires_in: 86_400, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    email: "frontend-activity@thrallo.com", user_metadata: { full_name: "Ada Tester" },
    app_metadata: { provider: "email" }, created_at: "2026-01-01T00:00:00Z",
  },
};

const PROJECTS = [
  {
    id: "c-idle", title: "Quiet workspace", state: "idle", publishStatus: "draft",
    activity: { agent: "Builder", status: "Writing the code…" },
  },
  {
    id: "c-ready", title: "Completed project", state: "idle", publishStatus: "draft",
    verified: true, hasPreview: true,
    activity: { agent: "Publisher", status: "Preparing your preview…", projectId: "p-ready" },
  },
  {
    id: "c-active", title: "Active project with a realistically long name", state: "idle", publishStatus: "draft",
    activity: { agent: "Tester", status: "verification failure repair attempt 2", projectId: "p-active" },
  },
  {
    id: "c-cancelled", title: "Cancelled project", state: "idle", publishStatus: "draft", cancelled: true,
    activity: { agent: "Builder", status: "Running quality checks…", projectId: "p-cancelled" },
  },
];

async function stubDashboard(page) {
  await page.addInitScript(([key, session]) => localStorage.setItem(key, JSON.stringify(session)), [
    `sb-${REF}-auth-token`, SESSION,
  ]);
  let active = true;
  let writes = 0;

  await page.route("**/api/v1/conversations**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/deleted")) return route.fulfill({ json: { items: [], recoveryDays: 7 } });
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({
      json: {
        conversations: PROJECTS,
        counts: { all: PROJECTS.length, drafts: PROJECTS.length, published: 0, updates: 0, favourites: 0 },
        page: { total: PROJECTS.length, limit: 20, nextOffset: null },
        sorts: [{ id: "activity", label: "Last activity" }, { id: "name", label: "Name" }],
      },
    });
  });
  await page.route("**/api/projects/*/active-build", (route) => {
    const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2));
    if (projectId === "p-active") {
      return route.fulfill({ json: { job: active
        ? { jobId: "j-active", projectId, status: "running", phase: "quality-checking" }
        : { jobId: "j-active", projectId, status: "complete", phase: "complete" } } });
    }
    return route.fulfill({ json: { job: { jobId: `j-${projectId}`, projectId, status: "complete", phase: "complete" } } });
  });
  await page.route(`https://${REF}.supabase.co/**`, (route) => route.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({ json: SESSION.user }));

  return { finish: () => { active = false; }, writes: () => writes };
}

test.skip(!REF, "requires shell/web/.env auth config");

test("dashboard reconstructs idle, ready, running, and terminal history without creating work", async ({ page }) => {
  const apiWrites = [];
  page.on("request", (request) => {
    if (/\/api\//.test(request.url()) && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      apiWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const state = await stubDashboard(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: /Open Quiet workspace/ })).toContainText("Idle");
  await expect(page.getByRole("button", { name: /Open Completed project/ })).toContainText("Ready");
  await expect(page.getByRole("button", { name: /Open Active project/ })).toContainText("Checking everything…");
  await expect(page.getByRole("button", { name: /Open Cancelled project/ })).toContainText("Cancelled");
  await expect(page.getByText(/repair attempt|verification failure|regenerating module/i)).toHaveCount(0);
  expect(state.writes()).toBe(0);
  expect(apiWrites).toEqual([]);

  state.finish();
  await expect(page.getByRole("button", { name: /Open Active project/ })).toContainText("Ready", { timeout: 8_000 });
  expect(state.writes()).toBe(0);
  expect(apiWrites).toEqual([]);
});

test("mobile dashboard controls and project cards stay inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubDashboard(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Open Active project/ })).toBeVisible();

  const overflow = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll(".ct-workspace, .ct-ws-tabs, .ct-ws-controls, .ct-project")]
      .map((element) => ({ className: element.className, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -0.5 || rect.right > viewport + 0.5 || rect.width > viewport + 0.5)
      .map(({ className, rect }) => ({ className, left: rect.left, right: rect.right, width: rect.width, viewport }));
    return { page: document.documentElement.scrollWidth - viewport, bad };
  });
  expect(overflow).toEqual({ page: 0, bad: [] });

  await page.screenshot({ path: "test-results/frontend-activity-mobile.png", fullPage: true });
});
