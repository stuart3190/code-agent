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
  assert.match(buildEndSummary({ buildOk: false, previewUrl: null }), /build check failed/);
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
