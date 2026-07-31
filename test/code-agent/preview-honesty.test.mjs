// A build must never claim a live preview it doesn't have (Stuart, 2026-07-31), and
// show_preview must be a registered capability so a missing preview is one sentence away.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import { buildEndSummary } from "../../shell/server/lib/appBuild/appBuildService.mjs";
import { registerCoreCapabilities } from "../../shell/server/lib/capabilities/coreCapabilities.mjs";
import { listCapabilities, resetCapabilityRegistryForTests } from "../../shell/server/lib/capabilityRegistry.mjs";

test("the end-of-build summary never claims a preview that does not exist", () => {
  assert.match(buildEndSummary({ buildOk: true, previewUrl: "https://x.preview.thrallo.com/" }), /preview is live/);
  assert.match(buildEndSummary({ buildOk: true, previewUrl: null }), /warming up/);
  assert.doesNotMatch(buildEndSummary({ buildOk: true, previewUrl: null }), /preview is live/);
  // buildOk:false no longer reaches the user directly — planEndAction routes it to repair.
  assert.doesNotMatch(buildEndSummary(undefined), /preview is live/);
});

test("show_preview is a registered capability", () => {
  const saved = { url: process.env.PROVISIOND_URL, token: process.env.PROVISIOND_TOKEN };
  process.env.PROVISIOND_URL = "http://127.0.0.1:1";
  process.env.PROVISIOND_TOKEN = "t";
  try {
    resetCapabilityRegistryForTests();
    registerCoreCapabilities();
    const capability = listCapabilities().find((c) => c.id === "show_preview");
    assert.ok(capability, "show_preview must be registered");
    assert.equal(capability.specialist, "Publisher");
  } finally {
    resetCapabilityRegistryForTests();
    process.env.PROVISIOND_URL = saved.url ?? ""; if (!saved.url) delete process.env.PROVISIOND_URL;
    process.env.PROVISIOND_TOKEN = saved.token ?? ""; if (!saved.token) delete process.env.PROVISIOND_TOKEN;
  }
});

// Runtime honesty gate pieces (per-app backend, 2026-07-31).
import { backendRuntimeReady, treeUsesBackendSdk, resetBackendRuntimeCacheForTests } from "../../shell/server/lib/appRuntimeStatus.mjs";

test("treeUsesBackendSdk detects the shipped SDK", () => {
  assert.equal(treeUsesBackendSdk({ "src/lib/backend/index.js": "x" }), true);
  assert.equal(treeUsesBackendSdk({ "src/App.jsx": "x" }), false);
});

test("backendRuntimeReady reports missing app-auth and missing entities", async () => {
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon";
  try {
    resetBackendRuntimeCacheForTests();
    let r = await backendRuntimeReady({ fetchImpl: async () => ({ status: 404 }), force: true });
    assert.equal(r.ready, false);
    assert.match(r.reason, /app-auth/);
    r = await backendRuntimeReady({
      fetchImpl: async (url) => ({ status: url.includes("/rest/") ? 404 : 204 }), force: true,
    });
    assert.equal(r.ready, false);
    assert.match(r.reason, /entities/);
    r = await backendRuntimeReady({ fetchImpl: async () => ({ status: 200 }), force: true });
    assert.equal(r.ready, true);
  } finally {
    resetBackendRuntimeCacheForTests();
    process.env.SUPABASE_URL = saved.u ?? ""; if (!saved.u) delete process.env.SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = saved.k ?? ""; if (!saved.k) delete process.env.SUPABASE_ANON_KEY;
  }
});

// Verification Agent pieces (2026-07-31): repair prompts preserve design; the capability set
// includes repair_app; report shaping is pure.
import { repairPrompt } from "../../shell/server/lib/appBuild/verificationAgent.mjs";

test("repairPrompt names the failures and the preservation rules", () => {
  const p = repairPrompt(["Signup: no fields", "Network: 500 on /entities"]);
  assert.match(p, /REPAIR MODE/);
  assert.match(p, /Signup: no fields/);
  assert.match(p, /preserve the existing design, layout, colours, branding/);
  assert.match(p, /minimum code change/);
});

test("repair_app and show_preview are registered capabilities", () => {
  const saved = { u: process.env.PROVISIOND_URL, t: process.env.PROVISIOND_TOKEN, k: process.env.OPENAI_API_KEY };
  process.env.PROVISIOND_URL = "http://127.0.0.1:1"; process.env.PROVISIOND_TOKEN = "t"; process.env.OPENAI_API_KEY = "sk-unit";
  try {
    resetCapabilityRegistryForTests();
    registerCoreCapabilities();
    const ids = listCapabilities().map((c) => c.id);
    assert.ok(ids.includes("repair_app"));
    assert.ok(ids.includes("show_preview"));
  } finally {
    resetCapabilityRegistryForTests();
    process.env.PROVISIOND_URL = saved.u ?? ""; if (!saved.u) delete process.env.PROVISIOND_URL;
    process.env.PROVISIOND_TOKEN = saved.t ?? ""; if (!saved.t) delete process.env.PROVISIOND_TOKEN;
    process.env.OPENAI_API_KEY = saved.k ?? ""; if (!saved.k) delete process.env.OPENAI_API_KEY;
  }
});

// Autonomous failure handling (Stuart, 2026-07-31): failures auto-repair without asking;
// completion only after verification; genuine exhaustion is the only pause point.
import { planEndAction, buildEndSummary as summaryFn, MAX_AUTO_ROUNDS } from "../../shell/server/lib/appBuild/appBuildService.mjs";

const BANNED = /say the word|would you like|tell me to (continue|try again)|if you say/i;

test("a failed build automatically enters repair — no permission question", () => {
  const action = planEndAction({ status: "complete", result: { buildOk: false, qualityWarnings: ["auth configuration invalid"] } }, { attempt: 1 });
  assert.equal(action.kind, "repair");
  assert.match(action.brief, /auth configuration invalid/);
  assert.match(action.brief, /smallest safe fix/);
  assert.match(action.announcement, /repairing it now and will re-run verification/i);
  assert.doesNotMatch(action.announcement, BANNED);
  assert.ok(!action.announcement.includes("?"), "routine repair must not ask");
});

test("a crashed job automatically retries", () => {
  const action = planEndAction({ status: "failed", error: "sandbox died" }, { attempt: 1 });
  assert.equal(action.kind, "retry");
  assert.doesNotMatch(action.announcement, BANNED);
});

test("repair is followed by re-verification: success routes to the verify gate, never straight to complete", () => {
  const action = planEndAction({ status: "complete", result: { buildOk: true, previewUrl: "https://x/" } }, { attempt: 2 });
  assert.equal(action.kind, "verify", "completion is only reachable through the Verification Agent");
});

test("genuine exhaustion pauses and requests input — the only pause point", () => {
  const action = planEndAction({ status: "complete", result: { buildOk: false, qualityWarnings: ["persistent failure"] } }, { attempt: MAX_AUTO_ROUNDS });
  assert.equal(action.kind, "blocked");
  assert.match(action.message, /need a decision from you/);
});

test("no user-facing builder copy contains banned permission-asking phrases", () => {
  assert.doesNotMatch(summaryFn({ buildOk: true, previewUrl: null }), BANNED);
  assert.doesNotMatch(summaryFn({ buildOk: true, previewUrl: "https://x/" }), BANNED);
  const repair = planEndAction({ status: "complete", result: { buildOk: false, qualityWarnings: ["x"] } }, { attempt: 1 });
  assert.doesNotMatch(repair.brief, BANNED);
});
