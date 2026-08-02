// Route registration guard.
//
// PR #53 ("Buildr101 legacy unmount") deleted the BODIES of three route blocks while leaving
// their comments in place. Because every dispatch is one `if` in a long chain and nothing
// imports a handler until it is mounted, removing a body produces no lint error, no type error
// and no test failure — the routes simply started returning 404. `/api/builds/:jobId/cancel`
// stayed dead for days, which meant a user could not cancel a running build at all.
//
// This guard makes that class impossible: every route module is classified as either mounted or
// deliberately unmounted-with-a-reason, and BOTH directions fail. Deleting a live mount fails;
// silently reviving a retired legacy route also fails. Adding a new route module without
// classifying it fails too, so the decision is always written down.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const routesDir = fileURLToPath(new URL("../../shell/server/routes", import.meta.url));
const indexPath = fileURLToPath(new URL("../../shell/server/index.mjs", import.meta.url));

// Modules whose handlers MUST be mounted. These are Thrallo's live product surface.
const MUST_BE_MOUNTED = new Set([
  "aiConnections.mjs",
  "apiTokens.mjs",
  "automations.mjs",
  "builds.mjs",          // restored 2026-08-01 — the incident this guard exists for
  "codeAgent.mjs",
  "conversations.mjs",
  "diagnostics.mjs",
  "export.mjs",           // restored 2026-08-01 (PR 4) — unmounted by the same #53 sweep
  "githubApp.mjs",
  "previewDomainCheck.mjs",
  "publishState.mjs",
  "qa.mjs",              // restored 2026-08-01 (PR 3) — needed a qa_runs table that never existed
  "subscription.mjs",
]);

// Modules deliberately NOT mounted, each with the reason. A bare list would rot; a reason makes
// the next legacy sweep reviewable instead of guesswork.
const DELIBERATELY_UNMOUNTED = new Map(Object.entries({
  "account.mjs": "Buildr101 account deletion; Thrallo account removal lives in the conversation surface",
  "analytics.mjs": "Buildr101 per-app analytics connector; not part of the Thrallo product surface",
  "android.mjs": "Buildr101 Android/TWA packaging; gated until demanded",
  "billing.mjs": "legacy credit-ledger billing, superseded by Thrallo subscriptions (subscription.mjs)",
  "capabilities.mjs": "Buildr101 connector capability runtime; superseded by the Capability Registry",
  "connectWebhook.mjs": "Stripe Connect webhook for generated-app payments; unmounted until payments return",
  "connectors.mjs": "Buildr101 connector hub; superseded by the Capability Registry",
  "domains.mjs": "legacy custom-domain management; Thrallo serves its own ask-gate via previewDomainCheck.mjs",
  "environments.mjs": "Buildr101 environments/releases; not part of the Thrallo product surface",
  "features.mjs": "Buildr101 feature-flag matrix; Thrallo gates on plan + capability requirements",
  "foundation.mjs": "Buildr101 project secrets/releases/environments",
  "generate.mjs": "legacy synchronous generate endpoint; superseded by the app_build capability",
  "github.mjs": "legacy PAT-based GitHub export; deliberately replaced by the GitHub App (githubApp.mjs)",
  "integrations.mjs": "Buildr101 integrations; superseded by the Capability Registry",
  "ownerConsole.mjs": "Buildr101 owner console; superseded by Thrallo admin analytics",
  "preview.mjs": "legacy synchronous preview endpoint; superseded by the show_preview capability, which calls previewProvider() directly",
  "projects.mjs": "handler is legacy; deleteProjectCascade is imported directly by the soft-delete service",
  "publish.mjs": "handler is legacy; materializeAndPublish is invoked by the publish capability",
  "runtimeCheckout.mjs": "Buildr101 generated-app checkout runtime",
  "runtimeConnectors.mjs": "Buildr101 generated-app connector runtime",
  "runtimeWebhook.mjs": "Buildr101 generated-app webhook runtime",
  "saasPayments.mjs": "Buildr101 generated-app payments",
  "settings.mjs": "legacy BYOK storage; superseded by /api/v1/ai/* (aiConnections.mjs)",
  "stripeWebhook.mjs": "legacy platform billing webhook; superseded by the Thrallo billing webhook",
  "templates.mjs": "Buildr101 templates; Principle 7 replaces templates with the outcome router",
  "visualBrand.mjs": "Buildr101 visual brand kits; superseded by the design director",
}));

async function routeModules() {
  const modules = new Map();
  for (const file of (await readdir(routesDir)).filter((f) => f.endsWith(".mjs"))) {
    const src = await readFile(`${routesDir}/${file}`, "utf8");
    const handlers = [...src.matchAll(/^export (?:async )?function (handle[A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    if (handlers.length) modules.set(file, handlers);
  }
  return modules;
}

test("every route module is classified as mounted or deliberately unmounted", async () => {
  const modules = await routeModules();
  const unclassified = [...modules.keys()]
    .filter((file) => !MUST_BE_MOUNTED.has(file) && !DELIBERATELY_UNMOUNTED.has(file));
  assert.deepEqual(unclassified, [],
    `classify these in test/code-agent/route-manifest.test.mjs — mounted, or unmounted with a reason: ${unclassified.join(", ")}`);
});

// A handler that is imported but never CALLED is exactly the state PR #53 left behind, so
// counting references matters: an import alone is one occurrence, a real mount is at least two.
function referenceCount(index, handler) {
  return (index.match(new RegExp(`\\b${handler}\\b`, "g")) || []).length;
}

test("every handler of a live route module is actually mounted, not merely imported", async () => {
  const modules = await routeModules();
  const index = await readFile(indexPath, "utf8");
  const missing = [];
  const importedButUnused = [];
  for (const file of MUST_BE_MOUNTED) {
    for (const handler of modules.get(file) || []) {
      const count = referenceCount(index, handler);
      if (count === 0) missing.push(`${file}:${handler}`);
      else if (count === 1) importedButUnused.push(`${file}:${handler}`);
    }
  }
  assert.deepEqual(missing, [],
    `these handlers are exported but never referenced in index.mjs — a route is dead: ${missing.join(", ")}`);
  assert.deepEqual(importedButUnused, [],
    `these handlers are imported but never dispatched — the route body was deleted: ${importedButUnused.join(", ")}`);
});

test("a deliberately retired route cannot be revived without updating the manifest", async () => {
  const modules = await routeModules();
  const index = await readFile(indexPath, "utf8");
  const revived = [];
  for (const [file] of DELIBERATELY_UNMOUNTED) {
    for (const handler of modules.get(file) || []) {
      // Word-boundary, not substring: `handlePreview` occurs inside `handlePreviewDomainCheck`,
      // which made a plain includes() report preview.mjs as both mounted and revived.
      if (referenceCount(index, handler) > 0) revived.push(`${file}:${handler}`);
    }
  }
  assert.deepEqual(revived, [],
    `these are mounted but still listed as retired — move them to MUST_BE_MOUNTED: ${revived.join(", ")}`);
});

test("every retirement carries a written reason", () => {
  for (const [file, reason] of DELIBERATELY_UNMOUNTED) {
    assert.ok(reason && reason.length > 25, `${file}: retirement needs a real justification`);
  }
});

test("the critical build-job paths are dispatched, not swallowed by the 404 catch-all", async () => {
  const index = await readFile(indexPath, "utf8");
  // The exact paths PR #53 silently removed. Asserted as source patterns because the runtime
  // half is covered by scripts/smoke-production.mjs against the deployed origin.
  for (const pattern of [
    String.raw`\/api\/builds\/([^/]+)\/events`,
    String.raw`\/api\/builds\/([^/]+)\/cancel`,
    String.raw`\/api\/projects\/([^/]+)\/active-build`,
  ]) {
    assert.ok(index.includes(pattern), `route pattern missing from the dispatcher: ${pattern}`);
  }
  // And the block is not an empty stub again. Comments are stripped first: the comment above
  // the block quotes `{ let m; }` when explaining the incident, and would otherwise match.
  const code = index.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\{\s*let m;\s*\}/,
    "the build-jobs dispatch block is empty — its route bodies have been deleted again");
});
