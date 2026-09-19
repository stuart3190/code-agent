import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCheckoutIdempotencyKey } from "../../shell/web/src/billing/checkoutIdempotency.js";

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");

test("checkout idempotency keys are UUIDs and unique per customer action", () => {
  const first = createCheckoutIdempotencyKey();
  const second = createCheckoutIdempotencyKey();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first, second);
});

test("the web API consumes the frozen approval and top-up routes", async () => {
  const api = await read("shell/web/src/lib/codeAgentApi.js");
  assert.match(api, /\/api\/v1\/billing\/topup/);
  assert.match(api, /\/api\/v1\/build-budget-approvals\/\$\{encodeURIComponent\(approvalId\)\}\/approve/);
  assert.match(api, /\/api\/v1\/build-budget-approvals\/\$\{encodeURIComponent\(approvalId\)\}\/decline/);
  assert.match(api, /idempotencyKey/);
});

test("dashboard activity consumes summaries directly and reconnects an interrupted build stream", async () => {
  const shell = await read("shell/web/src/chat/ChatShell.jsx");
  assert.doesNotMatch(shell, /reconstructProjectActivities/);
  assert.match(shell, /conversation\.activeBuild/);
  assert.match(shell, /await projectBuildStatus\(projectId\)/);
  assert.match(shell, /while \(!controller\.signal\.aborted\)/);
});

test("credit UI distinguishes included, purchased, held and available balances", async () => {
  const billing = await read("shell/web/src/settings/BillingTab.jsx");
  const usage = await read("shell/web/src/settings/UsageTab.jsx");
  for (const source of [billing, usage]) {
    assert.match(source, /includedRemaining/);
    assert.match(source, /purchasedRemaining/);
    assert.match(source, /reserved/);
    assert.match(source, /totalAvailable/);
  }
  assert.match(billing, /purchaseAvailable/);
  assert.match(billing, /Additional-credit purchasing is not available yet/);
});

test("disconnected Codex is unavailable and never promises managed fallback", async () => {
  const selector = await read("shell/web/src/chat/ModelSelector.jsx");
  assert.doesNotMatch(selector, /currentValue\s*!==\s*["']codex["']/);
  assert.match(selector, /selectedForbidsFallback/);
  assert.match(selector, /selectedProvider === ["']codex["']/);
});

test("existing preview, export and publish lifecycle controls remain wired", async () => {
  const shell = await read("shell/web/src/chat/ChatShell.jsx");
  const settings = await read("shell/web/src/publish/ProjectSettingsBody.jsx");
  const panel = await read("shell/web/src/publish/PublishedPanel.jsx");
  const deployments = await read("shell/web/src/publish/DeploymentsView.jsx");
  assert.match(shell, /function PreviewPane/);
  assert.match(settings, /exportProjectZip/);
  assert.match(panel, /Publish Update/);
  assert.match(panel, /Unpublish/);
  assert.match(deployments, /rollbackDeployment/);
});
