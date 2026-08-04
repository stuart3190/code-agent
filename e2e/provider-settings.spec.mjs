// Provider settings regression guard: EVERY registered provider adapter must appear in
// Settings → AI connection, connected or not, on desktop and mobile.
//
// Runs against the local build by default; set E2E_BASE_URL=https://app.thrallo.com to
// run it against production (auth and the connections API are stubbed either way, so it
// exercises the real deployed bundle without touching a real account).

import { expect, test } from "@playwright/test";
import { openSettingsFromMenu } from "./accountMenu.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    return new URL(env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)[1]).hostname.split(".")[0];
  } catch { return null; }
}
const REF = supabaseRef();
test.skip(!REF, "requires shell/web/.env auth config");

const SESSION = {
  access_token: "e2e-token", refresh_token: "e2e-refresh", token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "e2e@thrallo.com", user_metadata: {}, app_metadata: {} },
};

// The providers the application registers. Kept in step with the adapters by
// test/code-agent/xai-provider.test.mjs (schema) and provider-registry.test.mjs (code).
const EXPECTED_PROVIDERS = [
  { id: "openai", label: "OpenAI API" },
  { id: "anthropic", label: "Anthropic API" },
  { id: "gemini", label: "Gemini API" },
  { id: "xai", label: "xAI Grok API" },
];

async function openAiSettings(page, { connections = [], byokSafety = { global: {}, providers: {}, timezone: null } } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: { plan: { id: "free" }, budgets: {}, totals: {}, records: [] } }));
  await page.route("**/api/v1/ai/connections", (r) => r.fulfill({ json: {
    configured: true, activeProvider: "managed", connections,
    models: [], routing: { routingMode: "balanced", allowFallback: true },
    byokSafety, byokProviders: connections.filter((c) => c.authMode === "api_key").map((c) => c.provider),
  } }));
  await page.route("**/api/v1/ai/evaluations", (r) => r.fulfill({ json: { health: [], evaluations: [] } }));

  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  // The avatar is the account-menu trigger now; Settings is an item on that menu.
  await openSettingsFromMenu(page);
  await page.getByRole("button", { name: "Manage" }).first().click();
  await expect(page.getByRole("heading", { name: "AI connection" })).toBeVisible();
}

test("every registered provider appears in Settings, connected or not", async ({ page }) => {
  await openAiSettings(page);
  for (const provider of EXPECTED_PROVIDERS) {
    const row = page.locator(".mg-row", { hasText: provider.label });
    await expect(row, `${provider.id} row is present`).toBeVisible();
  }
  // Unconfigured providers offer a key field and a Connect button.
  const xaiRow = page.locator(".mg-row", { hasText: "xAI Grok API" });
  await expect(xaiRow.getByPlaceholder("xai-…")).toBeVisible();
  await expect(xaiRow.getByRole("button", { name: "Connect" })).toBeVisible();
});

test("a connected provider shows Active and Disconnect, not the key field", async ({ page }) => {
  await openAiSettings(page, {
    connections: [{ provider: "xai", authMode: "api_key", hint: "xai-…abcd", status: "connected", metadata: {} }],
  });
  const xaiRow = page.locator(".mg-row", { hasText: "xAI Grok API" });
  await expect(xaiRow).toBeVisible();
  await expect(xaiRow.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(xaiRow.getByPlaceholder("xai-…")).toHaveCount(0);
  // The masked hint is shown; a raw key never is.
  await expect(xaiRow.getByText("xai-…abcd")).toBeVisible();
});

test("a provider whose last attempt errored is still listed and reconnectable", async ({ page }) => {
  // A failed validation must never remove the row — the user has to be able to retry.
  await openAiSettings(page, {
    connections: [{ provider: "xai", authMode: "api_key", hint: "xai-…bad", status: "error", metadata: {} }],
  });
  const xaiRow = page.locator(".mg-row", { hasText: "xAI Grok API" });
  await expect(xaiRow).toBeVisible();
  await expect(xaiRow.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

test("'Configure provider' in the model selector lands on the AI connection screen", async ({ page }) => {
  // The reported regression: tapping "Configure xAI / Grok" opened the Settings ROOT,
  // which never mentions xAI — indistinguishable from the provider having disappeared.
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: { plan: { id: "free" }, budgets: {}, totals: {}, records: [] } }));
  await page.route("**/api/v1/ai/connections", (r) => r.fulfill({ json: {
    configured: true, activeProvider: "managed", connections: [], models: [],
    routing: { routingMode: "balanced", allowFallback: true },
  } }));
  await page.route("**/api/v1/ai/evaluations", (r) => r.fulfill({ json: { health: [], evaluations: [] } }));
  await page.route("**/api/v1/models", (r) => r.fulfill({ json: {
    options: [{ value: "auto", provider: "auto", available: true }],
    providers: [
      { id: "auto", name: "Auto", available: true, models: [] },
      { id: "xai", name: "xAI / Grok", available: false, configure: true, models: [], modes: [] },
    ],
    modes: [], unconfigured: ["xai"], allowFallback: true,
    autoStrategy: { provider: "openai", model: "gpt-5.6-terra", mode: "balanced", reason: "x", stats: null },
  } }));

  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.locator(".ct-model-pill").click();
  await page.getByRole("button", { name: /Configure xAI/ }).click();
  // Lands directly on AI connection with the xAI row in view — no hunting required.
  await expect(page.getByRole("heading", { name: "AI connection" })).toBeVisible();
  const xaiRow = page.locator(".mg-row", { hasText: "xAI Grok API" });
  await expect(xaiRow).toBeVisible();
  await expect(xaiRow.getByPlaceholder("xai-…")).toBeVisible();
});

// ── Optional BYOK spending safeguards ───────────────────────────────────────────────────
// The controls exist server-side and default to disabled; these prove the UI exposes them
// honestly, saves, edits and removes them, and never surfaces key material.

const CONNECTED_XAI = [{ provider: "xai", authMode: "api_key", hint: "xai-…abcd", status: "connected", metadata: {} }];

test("safeguards are offered per connected BYOK provider and default to Off", async ({ page }) => {
  await openAiSettings(page, { connections: CONNECTED_XAI });
  const toggle = page.getByTestId("safeguards-toggle-xai");
  await expect(toggle).toBeVisible();
  // Nothing enabled -> no "N on" badge.
  await expect(page.getByTestId("safeguards-count-xai")).toHaveCount(0);
  await toggle.click();

  // The explainer must say plainly that Thrallo does not cap BYOK usage.
  await expect(page.getByTestId("safeguards-explainer-xai")).toContainText(/does not cap usage on your own/i);
  await expect(page.getByTestId("safeguards-currency-xai")).toContainText(/Thrallo credits/);

  for (const key of ["maxCostPerBuild", "maxDailySpend", "warnThreshold", "approvalThreshold", "maxRepairJobs"]) {
    const input = page.getByTestId(`safeguard-xai-${key}`);
    await expect(input, `${key} control is present`).toBeVisible();
    await expect(input, `${key} defaults to disabled`).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "Off");
  }
  // Nothing to save or remove until the user sets something.
  await expect(page.getByTestId("safeguards-save-xai")).toBeDisabled();
  await expect(page.getByTestId("safeguards-clear-xai")).toHaveCount(0);
});

test("safeguards save, and the saved value comes back scoped to that provider", async ({ page }) => {
  let saved = null;
  await page.route("**/api/v1/ai/byok-safety", async (route) => {
    saved = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: {
      configured: true, activeProvider: "managed", connections: CONNECTED_XAI, models: [],
      routing: { routingMode: "balanced", allowFallback: true },
      byokSafety: { global: {}, providers: { xai: { maxDailySpend: 25, maxRepairJobs: 1 } }, timezone: null },
      byokProviders: ["xai"],
    } });
  });
  await openAiSettings(page, { connections: CONNECTED_XAI });
  await page.getByTestId("safeguards-toggle-xai").click();
  await page.getByTestId("safeguard-xai-maxDailySpend").fill("25");
  await page.getByTestId("safeguard-xai-maxRepairJobs").fill("1");
  await page.getByTestId("safeguards-save-xai").click();

  await expect.poll(() => saved?.providers?.xai?.maxDailySpend).toBe(25);
  expect(saved.providers.xai.maxRepairJobs).toBe(1);
  expect(saved.providers.xai.maxCostPerBuild).toBeNull();
  // The request carries numbers and nulls only — no key material of any kind.
  expect(JSON.stringify(saved)).not.toMatch(/xai-|sk-|secret|key/i);

  await expect(page.getByTestId("safeguards-count-xai")).toHaveText("2 on");
  await expect(page.getByTestId("safeguard-xai-maxDailySpend")).toHaveValue("25");
});

test("invalid safeguard values are refused before saving, and limits can be removed", async ({ page }) => {
  let cleared = null;
  await page.route("**/api/v1/ai/byok-safety", async (route) => {
    cleared = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: {
      configured: true, activeProvider: "managed", connections: CONNECTED_XAI, models: [],
      routing: { routingMode: "balanced", allowFallback: true },
      byokSafety: { global: {}, providers: {}, timezone: null }, byokProviders: ["xai"],
    } });
  });
  await openAiSettings(page, {
    connections: CONNECTED_XAI,
    byokSafety: { global: {}, providers: { xai: { maxDailySpend: 25 } }, timezone: null },
  });
  await page.getByTestId("safeguards-toggle-xai").click();

  // A negative value is rejected inline and blocks the save.
  await page.getByTestId("safeguard-xai-maxCostPerBuild").fill("-5");
  await expect(page.getByTestId("safeguards-error-xai")).toBeVisible();
  await expect(page.getByTestId("safeguards-save-xai")).toBeDisabled();

  // Removing every limit is always available once something is set.
  await page.getByTestId("safeguards-clear-xai").click();
  await expect.poll(() => cleared?.providers?.xai?.maxDailySpend).toBeNull();
  await expect(page.getByTestId("safeguards-count-xai")).toHaveCount(0);
});

test("no key material appears anywhere in the settings responses", async ({ page }) => {
  const bodies = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/v1/ai/")) return;
    bodies.push(await response.text().catch(() => ""));
  });
  await openAiSettings(page, {
    connections: CONNECTED_XAI,
    byokSafety: { global: { maxCostPerBuild: 5 }, providers: {}, timezone: null },
  });
  await page.getByTestId("safeguards-toggle-xai").click();
  await expect(page.getByTestId("safeguard-xai-maxCostPerBuild")).toHaveValue("5");
  for (const body of bodies) {
    // The masked hint (xai-…abcd) is expected; a usable key never is.
    expect(body).not.toMatch(/xai-[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|secret_encrypted/);
  }
});
