// Provider settings regression guard: EVERY registered provider adapter must appear in
// Settings → AI connection, connected or not, on desktop and mobile.
//
// Runs against the local build by default; set E2E_BASE_URL=https://app.thrallo.com to
// run it against production (auth and the connections API are stubbed either way, so it
// exercises the real deployed bundle without touching a real account).

import { expect, test } from "@playwright/test";
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

async function openAiSettings(page, { connections = [] } = {}) {
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
  } }));
  await page.route("**/api/v1/ai/evaluations", (r) => r.fulfill({ json: { health: [], evaluations: [] } }));

  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();
  await page.getByRole("button", { name: "E", exact: true }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
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
