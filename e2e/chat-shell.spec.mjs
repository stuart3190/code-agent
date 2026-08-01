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

test("model selector: Begin choice rides with the first message; in-conversation switch is future-only", async ({ page }) => {
  await stubApi(page);
  const MODES_STUB = [
    { id: "fast", name: "Fast", icon: "⚡", badge: "Fastest", detail: "Lowest latency." },
    { id: "balanced", name: "Balanced", icon: "⚖", badge: "Recommended", detail: "Default.", recommended: true },
    { id: "deep", name: "Deep Thinking", icon: "🧠", badge: "Best Quality", detail: "Max reasoning." },
  ];
  await page.route("**/api/v1/models", (r) => r.fulfill({ json: {
    options: [
      { value: "auto", provider: "auto", model: "Smart routing", source: "Thrallo managed", label: "Recommended", available: true },
      { value: "openai:gpt-5.6-terra", provider: "openai", model: "gpt-5.6-terra", source: "Thrallo managed", label: "Balanced", relCost: "≈1.00×", available: true },
      { value: "anthropic:claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", source: "Your API key", label: "Best quality", relCost: "≈1.00×", available: true },
    ],
    providers: [
      { id: "auto", name: "Auto", recommended: true, available: true, models: [] },
      { id: "openai", name: "OpenAI", available: true, source: "Thrallo managed", modes: MODES_STUB,
        models: [{ id: "gpt-5.6-terra", name: "gpt-5.6-terra", tier: "Balanced", relCost: "≈1.00×", value: "openai:gpt-5.6-terra", stats: { successRate: 99.1, avgCostCredits: 1.1, avgDurationMs: 34_000, avgRepairRounds: 0.2, samples: 30 } }] },
      { id: "anthropic", name: "Anthropic", available: true, source: "Your API key", modes: MODES_STUB,
        models: [{ id: "claude-sonnet-5", name: "claude-sonnet-5", tier: "Best quality", relCost: "≈1.00×", value: "anthropic:claude-sonnet-5", stats: { collecting: true, samples: 2 } }] },
      { id: "gemini", name: "Gemini", available: false, configure: true, models: [], modes: [] },
      { id: "xai", name: "xAI / Grok", available: false, configure: true, models: [], modes: [] },
    ],
    modes: MODES_STUB,
    autoStrategy: { provider: "openai", model: "gpt-5.6-terra", mode: "balanced", reason: "Highest measured success rate for coding.", stats: { successRate: 98.9, avgCostCredits: 1.0, avgDurationMs: 38_000, avgRepairRounds: 0.2, samples: 40 } },
    unconfigured: ["gemini", "xai"], allowFallback: true,
  } }));
  let startBody = null;
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) => {
    if (route.request().method() === "POST") {
      startBody = route.request().postDataJSON();
      return route.fulfill({ json: { conversation: { id: "c1", title: "FocusFlow", state: "thinking", modelPref: startBody.modelPref } } });
    }
    return route.fulfill({ json: { conversations: [] } });
  });
  let modelPost = null;
  await page.route("**/api/v1/conversations/c1/model", (route) => {
    modelPost = route.request().postDataJSON();
    return route.fulfill({ json: { value: modelPost.value } });
  });

  await page.goto("/");
  // Closed state is self-explanatory: "🤖 Model: Auto ▾".
  const pill = page.locator(".ct-model-pill");
  await expect(pill).toHaveText(/Model: Auto/);
  await pill.click();

  // The menu is a body-level portal ABOVE all content, anchored directly below the pill.
  const menu = page.locator(".ct-model-menu");
  await expect(menu).toBeVisible();
  const anchored = await page.evaluate(() => {
    const menuEl = document.querySelector(".ct-model-menu");
    const pillEl = document.querySelector(".ct-model-pill");
    const m = menuEl.getBoundingClientRect();
    const p = pillEl.getBoundingClientRect();
    return {
      inBody: menuEl.parentElement === document.body,
      zIndex: Number(getComputedStyle(menuEl).zIndex),
      below: m.top >= p.bottom || m.bottom <= p.top, // anchored below OR flipped above — never overlapping
      onScreen: m.left >= 0 && m.right <= window.innerWidth,
      topAtHit: (() => { const el = document.elementFromPoint(m.left + m.width / 2, Math.min(m.top + 20, window.innerHeight - 1)); return menuEl.contains(el); })(),
    };
  });
  expect(anchored.inBody).toBe(true);
  expect(anchored.zIndex).toBeGreaterThanOrEqual(60);
  expect(anchored.below).toBe(true);
  expect(anchored.onScreen).toBe(true);
  expect(anchored.topAtHit).toBe(true); // nothing renders over the popover

  // Outside click closes; reopen for the drill-in.
  await page.mouse.click(5, 200);
  await expect(menu).not.toBeVisible();
  await pill.click();

  // Unconfigured providers appear as "Configure X" rows.
  await expect(page.getByText("Configure Gemini")).toBeVisible();
  // Auto explanation via the "Why?" link: current choice + reason + confidence.
  await page.getByRole("button", { name: "Why?" }).click();
  await expect(page.getByText("Auto — current choice")).toBeVisible();
  await expect(page.getByText("Highest measured success rate for coding.")).toBeVisible();
  await expect(page.getByText(/Benchmark confidence: 40 verified builds/)).toBeVisible();
  await page.getByRole("button", { name: /← Providers/ }).click();

  // Keyboard navigation: arrows move focus, Enter drills in.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() => document.activeElement?.textContent || "");
  expect(focused.length).toBeGreaterThan(0);

  // Provider -> Model -> Mode drill-in with live stats and "Collecting" state.
  await page.getByRole("button", { name: /Anthropic/ }).click();
  await expect(page.getByText("Collecting benchmark data…")).toBeVisible();
  await page.getByRole("option", { name: /claude-sonnet-5/ }).click();
  await expect(page.getByText("🧠 Deep Thinking")).toBeVisible();
  await page.getByRole("option", { name: /Deep Thinking/ }).click();
  await expect(pill).toHaveText(/Anthropic · claude-sonnet-5 • Deep Thinking/);

  // The full provider:model#mode choice rides with the first message.
  const box = page.getByPlaceholder(/Describe anything/);
  await box.fill("Build me a store");
  await box.press("Enter");
  await expect.poll(() => startBody?.modelPref).toBe("anthropic:claude-sonnet-5#deep");

  // Inside the conversation: switch to OpenAI · Balanced — POST fires + confirmation toast.
  const dockPill = page.locator(".ct-model-dock .ct-model-pill");
  await expect(dockPill).toBeVisible();
  await dockPill.click();
  await page.getByRole("button", { name: /OpenAI/ }).click();
  await expect(page.getByText(/99\.1%/)).toBeVisible(); // measured stars/stats, not generic labels
  await page.getByRole("option", { name: /gpt-5.6-terra/ }).click();
  await page.getByRole("option", { name: /Balanced/ }).click();
  await expect.poll(() => modelPost?.value).toBe("openai:gpt-5.6-terra");
  await expect(page.getByText("Future requests will use OpenAI · gpt-5.6-terra.")).toBeVisible();
});

test("Usage & plan: clean dashboard, 90% warning, advanced section, admin gate", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: {
    plan: { id: "free", name: "Free" }, budgets: {}, totals: {}, records: [
      { id: "u1", provider: "openai", model: "gpt-5.6-sol", input_tokens: 1000, output_tokens: 200 },
    ],
  } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    period: { end: "2026-08-31T00:00:00Z" },
    subscription: { plan: "free", stripeManaged: false, overrides: {} },
    stripeConfigured: false,
    budgets: {
      runs: { used: 9, limit: 10 },                    // 90% -> amber warning
      managedTokens: { used: 100_000, limit: 1_000_000 },
      computeSeconds: { used: 600, limit: 7200 },
    },
    plans: [{ id: "free", name: "Free", priceGbp: 0, monthly: { runs: 10, managedTokens: 1_000_000, computeSeconds: 7200 } }],
  } }));
  await page.route("**/api/v1/usage/insights", (r) => r.fulfill({ json: {
    month: "2026-08", buildsThisMonth: 3, aiCost: 5.2, aiCostGbp: 0.21, tokens: 160_000, requests: 12,
    byModel: [{ key: "gpt-5.6-sol", cost: 5.2, tokens: 160_000, requests: 12 }],
    byAgent: [{ key: "Builder", cost: 4.0, tokens: 120_000, requests: 6 }],
    byProvider: [{ key: "openai", cost: 5.2, tokens: 160_000, requests: 12 }],
    recentBuilds: [{ id: "b1", kind: "app_build", status: "passed", prompt: "Build me a shop", startedAt: "2026-08-01T10:00:00Z", durationMs: 65_000, repairRounds: 0, cost: 1.4, tokens: 26_000 }],
    recentRequests: [{ provider: "openai", model: "gpt-5.6-sol", agent: "Builder", inputTokens: 10_000, outputTokens: 2_000, cachedTokens: 500, reasoningTokens: 300, durationMs: 9_000, cost: 0.5, buildId: "b1", projectId: "p1", createdAt: "2026-08-01T10:00:05Z" }],
  } }));
  await page.route("**/api/v1/usage/builds/b1", (r) => r.fulfill({ json: {
    buildId: "b1", costByAgent: [{ key: "Builder", cost: 1.1, tokens: 20_000 }], costByModel: [{ key: "gpt-5.6-sol", cost: 1.4, tokens: 26_000 }],
  } }));
  await page.route("**/api/v1/admin/analytics", (r) => r.fulfill({ status: 403, json: { error: "Administrator access required", code: "admin_only" } }));

  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.keyboard.press("Control+k");
  const pal = page.getByPlaceholder(/Type a command/);
  await pal.fill("usage");
  await pal.press("Enter");

  // Clean dashboard: plan, reset date, meters, 90% warning, month stats, activity.
  await expect(page.getByRole("heading", { name: "Usage & plan" })).toBeVisible();
  await expect(page.getByText(/Resets .*2026/)).toBeVisible();
  await expect(page.getByText("90% used — nearly at the limit.")).toBeVisible();
  await expect(page.getByText("You're close to a plan limit")).toBeVisible();
  await expect(page.getByText("Estimated AI cost")).toBeVisible();
  await expect(page.getByText("5.20 cr · ~£0.21")).toBeVisible();
  await expect(page.getByText("Build me a shop")).toBeVisible();
  // Advanced detail hidden by default; expands to the per-request table.
  await expect(page.getByText("AI requests (this month, latest 50)")).not.toBeVisible();
  await page.getByRole("button", { name: /Advanced usage/ }).click();
  await expect(page.getByText("AI requests (this month, latest 50)")).toBeVisible();
  await expect(page.getByText("openai / gpt-5.6-sol").first()).toBeVisible();
  // Per-build breakdown expands with cost by agent/model.
  await page.getByRole("button", { name: /Build me a shop/ }).click();
  await expect(page.getByText("Builder · 1.10 cr")).toBeVisible();

  // Admin analytics is a hard server-side boundary; the view renders it honestly.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await pal.fill("admin analytics");
  await pal.press("Enter");
  await expect(page.getByText("This dashboard is only available to platform administrators.")).toBeVisible();
});

test("Build Diagnostics: browse runs, expand raw logs, evidence-grounded explanation", async ({ page }) => {
  await stubApi(page);
  const RUN = {
    id: "d1d1d1d1-0000-4000-8000-000000000001", kind: "app_build", status: "failed",
    prompt: "Build me a booking system", model: "gpt-5.6-sol", repair_rounds: 1,
    totals: { totalTokens: 42000, cost: 0.31 }, started_at: "2026-07-31T10:00:00Z",
    duration_ms: 312000, agents: ["Planner", "Builder", "Compiler"],
  };
  await page.route("**/api/v1/diagnostics", (r) => r.fulfill({ json: { runs: [RUN] } }));
  await page.route("**/api/v1/diagnostics/prefs", (r) => r.fulfill({ json: { retentionDays: 90 } }));
  await page.route(`**/api/v1/diagnostics/${RUN.id}`, (r) => r.fulfill({ json: { run: { ...RUN, steps: [
    { seq: 1, round: 1, agent: "Builder", kind: "agent", label: "Initial implementation", status: "ok", prompt: "Build it", output: "Implemented booking flow", usage: { total: 40000 }, cost: 0.29 },
    { seq: 2, round: 1, agent: "Compiler", kind: "compiler", label: "npm run build", status: "failed", output: "src/Booking.jsx: Unexpected token (22:7)", truncated: false },
    { seq: 3, round: 2, agent: "Lead Agent", kind: "repair", label: "Repair round 2 dispatched", status: "ok", prompt: "AUTONOMOUS REPAIR — fix the syntax error" },
  ] } } }));
  await page.route(`**/api/v1/diagnostics/${RUN.id}/explain`, (r) => r.fulfill({ json: {
    found: true, explanation: "The compiler output shows:\n```\nsrc/Booking.jsx: Unexpected token (22:7)\n```\nA stray token at line 22 broke the parse.",
  } }));

  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.keyboard.press("Control+k");
  const pal = page.getByPlaceholder(/Type a command/);
  await pal.fill("diagnostics");
  await pal.press("Enter");
  await expect(page.getByRole("heading", { name: "Build diagnostics" })).toBeVisible();
  await expect(page.getByText("Build me a booking system")).toBeVisible();
  await expect(page.getByText("1 repair round", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator(".mg-label", { hasText: "Round 1" })).toBeVisible();
  await expect(page.locator(".mg-label", { hasText: "Round 2" })).toBeVisible();
  // Expand the failing compiler step — the RAW stored output appears.
  await page.locator(".mg-card", { hasText: "npm run build" }).getByRole("button", { name: "Expand" }).click();
  await expect(page.getByText("src/Booking.jsx: Unexpected token (22:7)")).toBeVisible();
  // Download link points at the diagnostics bundle.
  await expect(page.getByRole("link", { name: "Download diagnostics" }))
    .toHaveAttribute("href", `/api/v1/diagnostics/${RUN.id}/download`);
  // Explanation is grounded in the stored log, quoting it verbatim.
  await page.getByRole("button", { name: "Explain this failure" }).click();
  await expect(page.getByText(/A stray token at line 22/)).toBeVisible();
  await expect(page.getByText(/Unexpected token \(22:7\)/).nth(1)).toBeVisible();
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

test("Provider Intelligence dashboard expands providers to per-model profiles", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/v1/admin/intelligence", (r) => r.fulfill({ json: {
    windowDays: 60, generatedAt: new Date().toISOString(), minSamples: 5,
    weights: { costPerVerified: 0.5, duration: 0.25, verification: 0.25 },
    taskTypes: ["planning", "ui", "quick_edit", "full_build"],
    totalRequests: 420,
    providers: [
      { provider: "openai", key: "openai", requests: 300, builds: 40, verificationRate: 96.2, costPerVerifiedBuild: 1.9, samples: 40, confidence: "Medium",
        models: [
          { model: "gpt-5.6-terra", key: "gpt-5.6-terra", builds: 30, samples: 30, verificationRate: 97.1, costPerVerifiedBuild: 1.7, avgBuildMs: 34000, avgRepairRounds: 0.2, avgRetries: 0, cacheEfficiency: 41.2, cancellationRate: 0, recommendationScore: 0.12, confidence: "Medium", collecting: false, strengths: ["fastest completion"], weaknesses: [], taskWins: 2, taskContests: 3, taskWinRate: 66.7, trend: { costChangePercent: -8.4, verificationChange: 1.2, priorSamples: 12 } },
          { model: "gpt-5.6-sol", key: "gpt-5.6-sol", builds: 10, samples: 10, verificationRate: 92, costPerVerifiedBuild: 3.1, avgBuildMs: 51000, avgRepairRounds: 0.6, avgRetries: 0.1, cacheEfficiency: 22, cancellationRate: 2, recommendationScore: 0.71, confidence: "Low", collecting: false, strengths: [], weaknesses: ["highest cost per verified build"], taskWins: 0, taskContests: 3, taskWinRate: 0, trend: null },
        ] },
      { provider: "xai", key: "xai", requests: 120, builds: 3, verificationRate: null, costPerVerifiedBuild: null, samples: 3, confidence: null,
        models: [{ model: "grok-4.5", key: "grok-4.5", builds: 3, samples: 3, verificationRate: null, costPerVerifiedBuild: null, avgBuildMs: null, avgRepairRounds: null, avgRetries: null, cacheEfficiency: null, cancellationRate: null, recommendationScore: null, confidence: null, collecting: true, strengths: [], weaknesses: [], taskWins: 0, taskContests: 0, taskWinRate: null, trend: null }] },
    ],
    models: [], modes: [],
    perTask: { planning: { ranked: [], explanation: "Collecting benchmark data." }, ui: { ranked: [{ model: "gpt-5.6-terra", samples: 12, confidence: "Low" }], explanation: "Selected gpt-5.6-terra because ui builds completed 24% faster with the same verification success (12 verified ui builds, Low confidence)." } },
    overall: { ranked: [{ model: "gpt-5.6-terra", score: 0.12, samples: 30, confidence: "Medium" }], explanation: "Selected gpt-5.6-terra because it achieved equivalent verified results at approximately 45% lower average cost (30 verified recent builds, Medium confidence)." },
    sampleWindow: {},
  } }));
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.keyboard.press("Control+k");
  const pal = page.getByPlaceholder(/Type a command/);
  await pal.fill("provider intelligence");
  await pal.press("Enter");

  await expect(page.getByRole("heading", { name: "Provider intelligence" })).toBeVisible();
  await expect(page.getByText(/45% lower average cost/)).toBeVisible();
  // Providers listed from evidence; expanding reveals per-model profiles.
  await expect(page.getByText("2 models", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /openai/ }).click();
  await expect(page.getByText("gpt-5.6-terra").first()).toBeVisible();
  await expect(page.getByText(/wins 66.7% of task types/)).toBeVisible();
  await expect(page.getByText("fastest completion")).toBeVisible();
  await expect(page.getByText(/trend: cost -8.4%/)).toBeVisible();
  // A model below the floor says so instead of showing a ranking.
  await page.getByRole("button", { name: /xai/ }).click();
  await expect(page.getByText("Collecting benchmark data (3)").first()).toBeVisible();
  // Task families with no evidence stay honest.
  await expect(page.getByText("Collecting benchmark data.").first()).toBeVisible();
});

test("Stop build: contextual control, reaches the mounted cancel route, dispatches nothing further", async ({ page }) => {
  // The user-facing half of the cancellation pipeline. The classification that makes a cancelled
  // build stop cleanly shipped in #119, but its HTTP route had been unmounted since #53 — so this
  // asserts the whole path, not just the planner.
  await stubApi(page);
  const events = [
    [1, "message", { role: "user", text: "Build me a booking system" }],
    [2, "build_started", { jobId: "job-77", projectId: "p-77", message: "The team is assembling to build this." }],
    [3, "agent_spawned", { agent: "Builder", status: "Writing the code…" }],
  ];
  const cancelCalls = [];
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) => route.fulfill({
    json: { conversations: [{ id: "c9", title: "Booking", activity: { agent: "Builder", status: "Writing the code…" } }] },
  }));
  await page.route("**/api/v1/conversations/c9/events**", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") || 0);
    return route.fulfill({ contentType: "text/event-stream", body: sse(events.filter(([s]) => s > after)) });
  });
  await page.route("**/api/builds/*/cancel", (route) => {
    cancelCalls.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Open Booking/ }).click();
  await expect(page.getByText("Build me a booking system")).toBeVisible();

  // Present while the team is working — and addressed to the running job.
  // Both layouts render the control (rail on desktop, roster strip on mobile) and CSS shows
  // exactly one; target the visible instance so the test is layout-agnostic.
  const stop = page.getByTestId("cancel-build").locator("visible=true");
  await expect(stop).toBeVisible();
  await stop.click();

  await expect.poll(() => cancelCalls.length).toBe(1);
  expect(cancelCalls[0]).toContain("/api/builds/job-77/cancel");

  // Retires itself once pressed: no further work to stop, and nothing new is dispatched.
  await expect(stop).toHaveCount(0);
  await expect.poll(() => cancelCalls.length).toBe(1);
});

test("Stop build is absent when no build is running, and a completion race is not an error", async ({ page }) => {
  await stubApi(page);
  const events = [
    [1, "message", { role: "user", text: "Just chatting" }],
    [2, "build_started", { jobId: "job-88", projectId: "p-88" }],
    [3, "agent_spawned", { agent: "Builder", status: "Writing the code…" }],
    [4, "agent_done", { agent: "Builder", ok: true }],
  ];
  await page.unroute("**/api/v1/conversations");
  await page.route("**/api/v1/conversations", (route) => route.fulfill({
    json: { conversations: [{ id: "c9", title: "Chat" }] },
  }));
  await page.route("**/api/v1/conversations/c9/events**", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") || 0);
    return route.fulfill({ contentType: "text/event-stream", body: sse(events.filter(([s]) => s > after)) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Open Chat/ }).click();
  await expect(page.getByText("Just chatting")).toBeVisible();
  // The team finished: nothing to stop, so the control is gone.
  await expect(page.getByTestId("cancel-build")).toHaveCount(0);
});
