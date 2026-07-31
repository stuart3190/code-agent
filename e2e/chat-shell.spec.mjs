// Phase 21: the conversation shell's converse → build → preview flow at desktop and
// mobile viewports, driven by a stubbed conversation API replaying the real Phase-19
// event stream. Requires the web bundle to be built with Supabase auth config (the local
// shell/web/.env); in CI that env is absent and these tests skip — the reducer contract
// is covered by test/code-agent/chat-shell.test.mjs either way.

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
  access_token: "e2e-fake-token",
  refresh_token: "e2e-fake-refresh",
  token_type: "bearer",
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    aud: "authenticated", role: "authenticated",
    email: "e2e@thrallo.com",
    user_metadata: { full_name: "Enid Tester" },
    app_metadata: { provider: "email" },
    created_at: "2026-01-01T00:00:00Z",
  },
};

const EVENTS = [
  [1, "message", { role: "user", text: "Build me a pomodoro timer called FocusFlow" }],
  [2, "agent_spawned", { agent: "Lead Agent", status: "Understanding request…" }],
  [3, "agent_spawned", { agent: "Planner", status: "Planning architecture…" }],
  [4, "plan.created", { title: "Build FocusFlow", steps: ["A clean, minimal timer", "Verify and preview"] }],
  [5, "agent_done", { ok: true, agent: "Planner" }],
  [6, "agent_spawned", { agent: "Builder", status: "Writing the code…" }],
  [7, "agent_done", { ok: true, agent: "Builder" }],
  [8, "message", { role: "lead", text: "I've got the first version ready — take a look." }],
  [9, "agent_done", { agent: "Lead Agent" }],
  [10, "preview_ready", { url: "https://demo.preview.thrallo.com/", projectId: "p1" }],
];
const sse = (events) => events.map(([sequence, type, payload]) =>
  `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ sequence, type, payload })}\n\n`).join("");

async function stubApi(page) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);

  let created = false;
  await page.route("**/api/v1/conversations", (route) => {
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill({ json: { conversation: { id: "c1", title: "FocusFlow", state: "thinking" } } });
    }
    return route.fulfill({ json: { conversations: created ? [{ id: "c1", title: "FocusFlow" }] : [] } });
  });
  await page.route("**/api/v1/conversations/deleted", (route) =>
    route.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/c1/events**", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") || 0);
    const pending = EVENTS.filter(([sequence]) => sequence > after);
    return route.fulfill({ contentType: "text/event-stream", body: sse(pending) });
  });
  await page.route("https://demo.preview.thrallo.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub</title><body>preview</body>" }));
  // Order matters: Playwright matches the LAST-registered route first, so the generic
  // catch-all goes before the specific /auth/v1/user stub.
  await page.route(`https://${REF}.supabase.co/**`, (route) => route.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("converse → team → preview on the conversation shell", async ({ page, isMobile }) => {
  const errors = [];
  // Sandboxed preview iframes under Chromium storage partitioning throw a benign
  // localStorage access error that never reaches product code — ignore only that.
  page.on("pageerror", (error) => {
    if (!/localStorage/.test(error.message)) errors.push(error.message);
  });
  await stubApi(page);
  await page.goto("/");

  // Begin: the product at rest.
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await expect(page.getByText(/Welcome back|Let's build something/)).toBeVisible();

  await page.getByPlaceholder(/Describe anything/).fill("Build me a pomodoro timer called FocusFlow");
  await page.keyboard.press("Enter");

  // Thread + choreography from the replayed stream.
  await expect(page.getByText("Build me a pomodoro timer called FocusFlow")).toBeVisible();
  await expect(page.getByText("I've got the first version ready — take a look.")).toBeVisible();
  await expect(page.getByText("Plan · Build FocusFlow")).toBeVisible();
  await expect(page.getByText("Preview ready")).toBeVisible();

  if (isMobile) {
    // The rail is hidden; the team strip and the full-screen sheet carry the product.
    await expect(page.locator(".ct-strip")).toBeVisible();
    await page.locator(".ct-preview-thumb").click();
    await expect(page.locator(".ct-mobile-sheet.show")).toBeVisible();
    await expect(page.locator(".ct-mobile-sheet .ct-btn", { hasText: "Publish" })).toBeVisible();
  } else {
    await expect(page.getByText("Your team")).toBeVisible();
    await expect(page.locator(".ct-rail .ct-agent").first()).toBeVisible();
    await expect(page.locator(".ct-rail.preview")).toBeVisible();
    await expect(page.locator(".ct-rail .ct-btn", { hasText: "Publish" })).toBeVisible();
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("settings sheet and command palette stay within the permanent four", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/v1/usage", (route) =>
    route.fulfill({ json: { plan: { id: "free", name: "Free" }, budgets: { managedTokens: { limit: 1_000_000, remaining: 750_000 } } } }));
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();

  await page.locator(".ct-avatar").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("e2e@thrallo.com")).toBeVisible();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder(/Type a command/)).toBeVisible();
  await expect(page.getByText("New conversation")).toBeVisible();
});

test("background navigation: leave a running build, start another, return — stream continues", async ({ page, isMobile }) => {
  await stubApi(page);
  // The "server": c9's durable event log keeps growing while the user is elsewhere.
  const buildEvents = [
    [1, "message", { role: "user", text: "Build me a big CRM called Atlas" }],
    [2, "agent_spawned", { agent: "Lead Agent", status: "Understanding request…" }],
    [3, "plan.created", { title: "Build Atlas", steps: ["Schema", "UI", "Verify"] }],
    [4, "agent_spawned", { agent: "Builder", status: "Writing the schema…" }],
  ];
  const afters = [];
  let created = false;
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) => {
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill({ json: { conversation: { id: "c2", title: "Second Project", state: "thinking" } } });
    }
    return route.fulfill({ json: { conversations: [
      { id: "c9", title: "Atlas", activity: { agent: "Builder", status: "Writing the schema…" } },
      ...(created ? [{ id: "c2", title: "Second Project" }] : []),
    ] } });
  });
  await page.route("**/api/v1/conversations/c9/events**", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") || 0);
    afters.push(after);
    return route.fulfill({ contentType: "text/event-stream", body: sse(buildEvents.filter(([s]) => s > after)) });
  });
  await page.route("**/api/v1/conversations/c2/events**", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") || 0);
    return route.fulfill({ contentType: "text/event-stream", body: sse(
      [[1, "message", { role: "user", text: "Start the second project" }]].filter(([s]) => s > after)) });
  });
  await page.goto("/");

  // 1. Open the long-running build. The back affordance is plainly visible mid-build.
  await page.getByRole("button", { name: /Open Atlas/ }).click();
  await expect(page.getByText("Build me a big CRM called Atlas")).toBeVisible();
  await expect(page.getByText("Plan · Build Atlas")).toBeVisible();
  const back = page.getByRole("button", { name: /Back to your projects/ });
  await expect(back).toBeVisible();

  // 2. Press ← Projects. 3. Home shows the project's LIVE status while the build keeps
  // going server-side (its event log grows while we're away).
  await back.click();
  await expect(page.getByText("Builder · Writing the schema…")).toBeVisible();
  buildEvents.push(
    [5, "message", { role: "lead", text: "Schema is in — wiring the UI now." }],
    [6, "agent_status", { agent: "Builder", status: "Wiring the UI…" }],
    [7, "preview_ready", { url: "https://demo.preview.thrallo.com/", projectId: "p9" }],
  );

  // 4. Start another project immediately — the first build never pauses.
  await page.getByPlaceholder(/Describe anything/).fill("Start the second project");
  await page.getByPlaceholder(/Describe anything/).press("Enter");
  await expect(page.getByText("Start the second project").first()).toBeVisible();
  await expect(back).toBeVisible();

  // 5. Return to the original project via ← Projects → its card.
  await back.click();
  await page.getByRole("button", { name: /Open Atlas/ }).click();

  // 6. Everything restored — history, plan, team state, preview — PLUS the work that
  // happened while we were away, proving the stream and build continued.
  await expect(page.getByText("Build me a big CRM called Atlas")).toBeVisible();
  await expect(page.getByText("Plan · Build Atlas")).toBeVisible();
  await expect(page.getByText("Schema is in — wiring the UI now.")).toBeVisible();
  if (isMobile) {
    await expect(page.getByText("Builder — Wiring the UI…")).toBeVisible(); // team strip
  } else {
    await expect(page.locator('.ct-agent[title="Builder — Wiring the UI…"]')).toBeVisible(); // compact rail
  }
  await expect(page.locator(".ct-preview-thumb").first()).toBeVisible();
  await expect(back).toBeVisible();
  // The live loop resumes with `after` (not only cold replays from 0).
  await expect.poll(() => afters.some((a) => a >= 7), { timeout: 8000 }).toBe(true);

  // Tablet width: the affordance stays visible and tappable.
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(40);
});

test("Downloads screen renders real release buttons from the manifest", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/v1/downloads", (route) => route.fulfill({ json: {
    product: "Thrallo Desktop", version: "1.131.0", platform: "Windows 10/11 x64",
    releasedAt: "2026-07-31T12:00:00.000Z", notes: "First public Windows build.",
    files: {
      setup: { name: "Thrallo-Setup-x64.exe", label: "Windows installer", sizeBytes: 120000000, sha256: "a".repeat(64), url: "/downloads/Thrallo-Setup-x64.exe" },
      portable: { name: "Thrallo-Portable-x64.zip", label: "Portable ZIP", sizeBytes: 260000000, sha256: "b".repeat(64), url: "/downloads/Thrallo-Portable-x64.zip" },
    },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "E", exact: true }).click();
  await page.getByRole("button", { name: "Open" }).last().click(); // Downloads row
  await expect(page.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", "/downloads/Thrallo-Setup-x64.exe");
  await expect(page.getByRole("link", { name: /Portable ZIP/ })).toHaveAttribute("href", "/downloads/Thrallo-Portable-x64.zip");
  await expect(page.getByText(/Version 1\.131\.0 · 114 MB · released/)).toBeVisible();
  await expect(page.getByText("First public Windows build.")).toBeVisible();
  await expect(page.getByText("Windows x64")).toBeVisible();
  await expect(page.getByText(/SHA-256/)).toBeVisible();
  // No leftover manual packaging instructions or "coming soon" placeholders.
  await expect(page.getByText(/npx vsce|coming soon/i)).toHaveCount(0);
});

test("polish: drafts survive failed sends, Escape closes dialogs, palette keyboard nav", async ({ page }) => {
  await stubApi(page);
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 500, json: { error: "The team is unreachable right now." } });
    }
    return route.fulfill({ json: { conversations: [{ id: "c1", title: "FocusFlow", state: "idle", hasPreview: true }] } });
  });
  await page.goto("/");
  await expect(page.getByText("FocusFlow")).toBeVisible();

  // A failed send reports the error and puts the draft back — never loses typed text.
  const box = page.getByPlaceholder(/Describe anything/);
  await box.fill("build me a store");
  await box.press("Enter");
  await expect(page.getByText("The team is unreachable right now.")).toBeVisible();
  await expect(box).toHaveValue("build me a store");

  // Escape dismisses the delete confirmation without deleting anything.
  await page.locator(".ct-pdelete").first().click();
  await expect(page.getByText("Delete this project?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Delete this project?")).not.toBeVisible();
  await expect(page.getByText("FocusFlow")).toBeVisible();

  // Palette is fully keyboard-driven: arrows move the selection, Enter opens it.
  await page.keyboard.press("Control+k");
  const palInput = page.getByPlaceholder(/Type a command/);
  await expect(palInput).toBeVisible();
  await palInput.press("ArrowDown");
  await expect(page.locator(".ct-pal-row.sel")).toHaveText(/Settings/);
  await palInput.press("ArrowDown");
  await expect(page.locator(".ct-pal-row.sel")).toHaveText(/Repositories/);
  await palInput.press("Enter");
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
});

test("soft delete → Recently Deleted → restore → Delete Now workflow", async ({ page }) => {
  await stubApi(page);
  let softDeleted = false, restored = false, purged = false;
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) =>
    route.fulfill({ json: { conversations: softDeleted ? [] : [{ id: "c1", title: "FocusFlow", state: "idle", hasPreview: true }] } }));
  await page.route(/\/api\/v1\/conversations\/c1(\?.*)?$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    if (route.request().url().includes("permanent=1")) { purged = true; return route.fulfill({ json: { deleted: true, projects: 1 } }); }
    softDeleted = true;
    return route.fulfill({ json: { deleted: true, deletedAt: new Date().toISOString() } });
  });
  await page.route("**/api/v1/conversations/c1/restore", (route) => {
    restored = true; softDeleted = false;
    return route.fulfill({ json: { restored: true, id: "c1", title: "FocusFlow" } });
  });
  await page.goto("/");
  await expect(page.getByText("FocusFlow")).toBeVisible();

  // Cancel does nothing.
  await page.locator(".ct-pdelete").first().click();
  await expect(page.getByText("Delete this project?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("FocusFlow")).toBeVisible();
  expect(softDeleted).toBe(false);

  // Confirm soft-deletes: card disappears immediately, project appears in Recently Deleted.
  await page.locator(".ct-pdelete").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Project moved to Recently Deleted.")).toBeVisible();
  await expect(page.locator(".ct-project:not(.ct-recent)")).toHaveCount(0);
  expect(softDeleted).toBe(true);
  expect(purged).toBe(false);

  await page.getByRole("button", { name: /Recently Deleted \(1\)/ }).click();
  await expect(page.getByText(/7 days left/)).toBeVisible();

  // Restore brings it straight back to Home.
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Project restored.")).toBeVisible();
  await expect(page.locator(".ct-project:not(.ct-recent)")).toHaveCount(1);
  expect(restored).toBe(true);

  // Delete again, then Delete Now bypasses the waiting period after its own confirmation.
  await page.locator(".ct-pdelete").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: /Recently Deleted \(1\)/ }).click();
  await page.getByRole("button", { name: "Delete now" }).click();
  await expect(page.getByText("Delete this project forever?")).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText("Project permanently deleted.")).toBeVisible();
  await expect(page.locator(".ct-recent")).toHaveCount(0);
  expect(purged).toBe(true);
});
