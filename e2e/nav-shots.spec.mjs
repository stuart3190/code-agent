// Visual check of the ← Projects affordance at phone / tablet / desktop. SHOTS=1 only.

import { test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(process.env.SHOTS !== "1", "screenshot pass only");

test("back affordance at three widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser, three viewports");
  const REF = new URL(readFileSync("shell/web/.env", "utf8").match(/VITE_SUPABASE_URL=(\S+)/)[1]).hostname.split(".")[0];
  const SESSION = {
    access_token: "t", token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "r", user: { id: "u", email: "e2e@thrallo.com", user_metadata: {} },
  };
  await page.addInitScript(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [{ id: "c1", title: "Atlas", activity: { agent: "Builder", status: "Building…" } }] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/conversations/c1/events**", (r) => r.fulfill({ contentType: "text/event-stream", body:
    `id: 1\nevent: message\ndata: ${JSON.stringify({ sequence: 1, type: "message", payload: { role: "user", text: "Build Atlas" } })}\n\n` +
    `id: 2\nevent: agent_spawned\ndata: ${JSON.stringify({ sequence: 2, type: "agent_spawned", payload: { agent: "Builder", status: "Building…" } })}\n\n` }));
  await page.goto("/");
  await page.getByRole("button", { name: /Open Atlas/ }).click();
  await page.getByText("Build Atlas").waitFor();
  for (const [name, size] of [["phone", { width: 390, height: 844 }], ["tablet", { width: 834, height: 1112 }], ["desktop", { width: 1440, height: 900 }]]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/nav-${name}.png` });
  }
});
