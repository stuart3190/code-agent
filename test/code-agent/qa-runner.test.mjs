// QA / responsive verification (audit PR 3, Option A).
//
// The QA runner covers what the Verification Agent cannot: it sweeps MULTIPLE viewports and
// MULTIPLE routes, capturing console errors and screenshots. Before this, generated-app
// responsive quality was verified by nothing at all — verificationAgent.mjs contains zero
// viewport handling, which these tests assert directly so the two never silently converge.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("QA complements the Verification Agent rather than duplicating it", async () => {
  const verifier = await read("../../shell/server/lib/appBuild/verificationAgent.mjs");
  const qa = await read("../../shell/server/lib/qaRunner.mjs");

  // The gap QA exists to fill.
  assert.doesNotMatch(verifier, /viewport/i,
    "the Verification Agent has no viewport coverage — if it gains some, revisit whether QA is still needed");
  assert.match(qa, /viewport/i, "the QA runner must sweep viewports");
  assert.match(qa, /screenshot/i, "the QA runner must capture screenshots");

  // And what the Verification Agent does that QA does not: the functional flow.
  assert.match(verifier, /signup/i);
  assert.match(verifier, /Data persists/);
});

test("the QA runner no longer depends on the retired Buildr101 feature matrix", async () => {
  const runs = await read("../../shell/server/lib/qaRuns.mjs");
  // requireFeature read a `feature_flags` table Thrallo never created and an entitlement from
  // the retired credit ledger, so it denied every caller unconditionally. Gating moved to the
  // capability registry's requirements().
  assert.doesNotMatch(runs, /requireFeature/,
    "QA must not be gated by the retired feature-flag matrix");
  assert.doesNotMatch(runs, /features\.mjs/);
});

test("QA artifacts are Thrallo-branded, not buildr", async () => {
  for (const file of ["../../shell/server/lib/qaRunner.mjs", "../../shell/server/routes/qa.mjs"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /buildr-qa/, `${file} still uses the buildr artifact directory`);
  }
});

test("the qa_runs migration uses Thrallo's isolation posture, not the legacy browser-readable one", async () => {
  const sql = await read("../../supabase/migrations/20260801200000_qa_runs_thrallo.sql");
  const ddl = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  assert.match(ddl, /enable row level security/i);
  assert.match(ddl, /create policy qa_runs_browser_deny[\s\S]*?using \(false\)/i,
    "browser roles must be denied outright");
  assert.match(ddl, /revoke all on table public\.qa_runs from public, anon, authenticated/i);
  assert.match(ddl, /grant all privileges on table public\.qa_runs\s+to service_role/i);

  // The legacy migration granted SELECT to authenticated; this one must not.
  assert.doesNotMatch(ddl, /grant select on table public\.qa_runs to authenticated/i);

  // One active sweep per project: a second request must not start a duplicate browser run.
  assert.match(ddl, /unique index[\s\S]*?qa_runs_one_active_per_project/i);
});

test("every QA route is mounted, owner-gated and awaited", async () => {
  const index = await read("../../shell/server/index.mjs");
  for (const handler of ["handleQaStart", "handleQaGet", "handleQaList", "handleQaArtifact"]) {
    const at = index.indexOf(`await ${handler}`);
    assert.ok(at > 0, `${handler} must be mounted and awaited`);
    const block = index.slice(Math.max(0, at - 320), at);
    assert.match(block, /requireOwner\(req, res\)/, `${handler} must be owner-gated`);
  }
  // Matched before the /api catch-all, or they can never fire.
  const catchAll = index.indexOf('if (p.startsWith("/api/")) return sendJson(res, 404');
  assert.ok(index.indexOf('p === "/api/test-runs"') < catchAll);
});

test("the artifact route refuses anything that is not a generated screenshot", async () => {
  const qa = await read("../../shell/server/routes/qa.mjs");
  // Path traversal must not reach the filesystem: the filename is validated against a strict
  // pattern before it is ever joined to the artifact root.
  assert.match(qa, /\^\[a-z0-9-\]\+\\\.jpg\$/, "filenames must match a strict screenshot pattern");
});

test("run_qa is registered, gated on preview infrastructure, and free", async () => {
  const registry = await import("../../shell/server/lib/capabilityRegistry.mjs");
  const core = await import("../../shell/server/lib/capabilities/coreCapabilities.mjs");
  registry.resetCapabilityRegistryForTests?.();
  core.registerCoreCapabilities();
  const capability = registry.listCapabilities().find((c) => c.id === "run_qa");
  assert.ok(capability, "run_qa must be registered");
  assert.equal(capability.specialist, "Tester");
  assert.equal(capability.costProfile, "free");
  assert.match(capability.description, /responsive|screen sizes|widths/i);
  assert.equal(typeof capability.requirements, "function",
    "QA must be gated by capability requirements, not the retired feature matrix");
});
