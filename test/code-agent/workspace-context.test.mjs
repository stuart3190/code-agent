// Phase 24 principle: workspace context is bounded, structured, and transparent.

import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeWorkspaceContext } from "../../shell/server/lib/leadAgentService.mjs";

test("sanitizeWorkspaceContext bounds every field and drops junk", () => {
  const clean = sanitizeWorkspaceContext({
    file: "src/App.jsx",
    language: "javascriptreact",
    selection: "x".repeat(10_000),
    diagnostics: Array.from({ length: 12 }, (_, i) => `error L${i}: ${"y".repeat(500)}`),
    previewUrl: "https://focusflow.preview.thrallo.com/",
    __proto__pollution: "ignored",
    extra: { nested: true },
  });
  assert.equal(clean.file, "src/App.jsx");
  assert.equal(clean.selection.length, 4_000);
  assert.equal(clean.diagnostics.length, 5);
  assert.ok(clean.diagnostics.every((d) => d.length <= 300));
  assert.equal(clean.previewUrl, "https://focusflow.preview.thrallo.com/");
  assert.ok(!("extra" in clean));
});

test("sanitizeWorkspaceContext returns null for empty or invalid input", () => {
  assert.equal(sanitizeWorkspaceContext(null), null);
  assert.equal(sanitizeWorkspaceContext("string"), null);
  assert.equal(sanitizeWorkspaceContext({}), null);
  assert.equal(sanitizeWorkspaceContext({ extra: 1 }), null);
});
