// Visual check for the model-selector popover. SHOTS=1 only.

import { test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(process.env.SHOTS !== "1", "screenshot pass only");

test("selector shots", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop only");
  const REF = new URL(readFileSync("shell/web/.env", "utf8").match(/VITE_SUPABASE_URL=(\S+)/)[1]).hostname.split(".")[0];
  const SESSION = {
    access_token: "t", token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "r", user: { id: "u", email: "e2e@thrallo.com", user_metadata: {} },
  };
  await page.addInitScript(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [{ id: "c1", title: "Atlas", hasPreview: true }] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [] } }));
  const MODES = [
    { id: "fast", name: "Fast", icon: "⚡", badge: "Fastest", detail: "Lowest latency, lowest reasoning effort." },
    { id: "balanced", name: "Balanced", icon: "⚖", badge: "Recommended", detail: "The default experience." },
    { id: "deep", name: "Deep Thinking", icon: "🧠", badge: "Best Quality", detail: "Maximum reasoning quality." },
  ];
  await page.route("**/api/v1/models", (r) => r.fulfill({ json: {
    options: [{ value: "auto", provider: "auto", available: true }, { value: "openai:gpt-5.6-terra", provider: "openai", model: "gpt-5.6-terra", available: true }],
    providers: [
      { id: "auto", name: "Auto", available: true, models: [] },
      { id: "openai", name: "OpenAI", available: true, source: "Thrallo managed", modes: MODES,
        models: [
          { id: "gpt-5.6-sol", name: "gpt-5.6-sol", tier: "Best quality", relCost: "≈1.6×", value: "openai:gpt-5.6-sol", stats: { successRate: 99.1, avgCostCredits: 1.4, avgDurationMs: 34_000, avgRepairRounds: 0.2, samples: 30 } },
          { id: "gpt-5.6-terra", name: "gpt-5.6-terra", tier: "Balanced", relCost: "≈1.0×", value: "openai:gpt-5.6-terra", stats: { collecting: true, samples: 3 } },
        ] },
      { id: "anthropic", name: "Anthropic", available: false, configure: true, models: [], modes: [] },
      { id: "gemini", name: "Gemini", available: false, configure: true, models: [], modes: [] },
      { id: "xai", name: "xAI / Grok", available: false, configure: true, models: [], modes: [] },
    ],
    modes: MODES,
    autoStrategy: { provider: "openai", model: "gpt-5.6-terra", mode: "balanced", reason: "Highest measured success rate for coding.", stats: { successRate: 98.9, avgCostCredits: 1.0, avgDurationMs: 38_000, avgRepairRounds: 0.2, samples: 40 } },
    unconfigured: ["anthropic", "gemini", "xai"], allowFallback: true,
  } }));
  await page.goto("/");
  await page.locator(".ct-model-pill").waitFor();
  await page.screenshot({ path: "test-results/shots/sel1-closed.png" });
  await page.locator(".ct-model-pill").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/shots/sel2-providers.png" });
  await page.getByRole("button", { name: "Why?" }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/shots/sel3-auto.png" });
  await page.getByRole("button", { name: /← Providers/ }).click();
  await page.getByRole("button", { name: /OpenAI/ }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/shots/sel4-models.png" });
  await page.getByRole("option", { name: /gpt-5.6-sol/ }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/shots/sel5-modes.png" });
});
