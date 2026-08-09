import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runGuard } from "../../desktop/d0/guard.mjs";
import { createRunId, resourceName, assertSyntheticPayload, assertSyntheticResourceName, assertLiveSpikeConfiguration, D4_LABELS } from "../../desktop/d4/lib/policy.mjs";
import { summarizeSamples, parseResourceSample } from "../../desktop/d4/lib/measurements.mjs";
import { createResourceRegistry } from "../../desktop/d4/lib/resourceRegistry.mjs";
import { createSyntheticProject, projectDigest } from "../../desktop/d4/lib/syntheticProject.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("synthetic project generation is deterministic and contains no credentials or production identifiers", () => {
  const first = createSyntheticProject("fixed-seed");
  const second = createSyntheticProject("fixed-seed");
  assert.deepEqual(first, second);
  assert.equal(projectDigest(first), projectDigest(second));
  assert.match(first.marker, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(first), /app\.thrallo\.com|Bearer\s|sk-[a-z0-9]/i);
});

test("resource names and labels are isolated and deterministic under injected entropy", () => {
  const runId = createRunId({ now: new Date("2032-01-02T03:04:05.000Z"), randomBytes: () => Buffer.from("01020304", "hex") });
  assert.equal(runId, "20320102t030405z-01020304");
  assert.equal(resourceName(runId, "workspace-a"), "thrallo-d4-20320102t030405z-01020304-workspace-a");
  assert.equal(D4_LABELS["thrallo.production"], "false");
  assert.throws(() => assertSyntheticResourceName("production-workspace"), /synthetic naming prefix/);
  assert.throws(() => resourceName("prod", "workspace"), /forbidden production identifier/);
});

test("live configuration fails closed without confirmation or outside the Daytona control origin", () => {
  assert.throws(() => assertLiveSpikeConfiguration({ confirmed: false, apiUrl: "https://app.daytona.io/api", target: "eu" }), /confirm-synthetic/);
  assert.throws(() => assertLiveSpikeConfiguration({ confirmed: true, apiUrl: "https://app.thrallo.com/api", target: "eu" }), /Daytona control API/);
  assert.deepEqual(assertLiveSpikeConfiguration({ confirmed: true, apiUrl: "https://app.daytona.io/api", target: "eu" }), { apiOrigin: "https://app.daytona.io", target: "eu" });
});

test("synthetic payload policy rejects production routes, identifiers, and credentials", () => {
  for (const value of ["https://app.thrallo.com", "/api/v1/projects", "owner_id=123", "Bearer abcdefghijklmnop", "sk-secretvalue123456"]) {
    assert.throws(() => assertSyntheticPayload(value));
  }
  assert.equal(assertSyntheticPayload("fixture-user@example.invalid"), "fixture-user@example.invalid");
});

test("measurement summaries report raw small samples without false percentile precision", () => {
  assert.deepEqual(summarizeSamples([20, 10, 30]), {
    count: 3, rawMs: [10, 20, 30], minMs: 10, medianMs: 20, maxMs: 30,
    p50Ms: null, p95Ms: null, percentilePrecision: "sample-too-small-raw-values-only",
  });
  const large = summarizeSamples(Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(large.p50Ms, 10.5);
  assert.equal(large.p95Ms, 19.05);
});

test("resource samples parse numeric cgroup observations and reject malformed metrics", () => {
  assert.deepEqual(parseResourceSample('{"memoryCurrentBytes":"1024","memoryLimitBytes":4096,"processCount":12,"load1":0.5}'), { memoryCurrentBytes: 1024, memoryLimitBytes: 4096, processCount: 12, load1: 0.5 });
  assert.throws(() => parseResourceSample('{"memoryCurrentBytes":"nope","memoryLimitBytes":1,"processCount":1,"load1":0}'), /memoryCurrentBytes/);
});

test("cleanup runs in reverse order, records deletion, and makes repeat cleanup idempotent", async () => {
  const calls = [];
  const registry = createResourceRegistry();
  for (const suffix of ["a", "b"]) registry.register({ kind: "sandbox", name: `thrallo-d4-test-${suffix}`, remove: async () => calls.push(suffix) });
  assert.deepEqual(await registry.cleanup(), [
    { kind: "sandbox", name: "thrallo-d4-test-b", outcome: "deleted" },
    { kind: "sandbox", name: "thrallo-d4-test-a", outcome: "deleted" },
  ]);
  assert.deepEqual(calls, ["b", "a"]);
  assert.deepEqual(await registry.cleanup(), []);
});

test("D4 source has no production mutation endpoints and requires explicit confirmation", () => {
  const files = readdirSync(path.join(ROOT, "desktop/d4"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:mjs|json|md)$/.test(entry.name));
  const source = files.map((entry) => readFileSync(path.join(entry.parentPath || entry.path, entry.name), "utf8")).join("\n");
  assert.doesNotMatch(source, /app\.thrallo\.com\/api|\/api\/v\d+\/(?:projects|builds|publish|workspace)/i);
  assert.match(source, /--confirm-synthetic/);
});

test("D4 evidence set is complete, machine-readable, honest about blocked Code OSS, and cleaned", () => {
  const evidenceDir = path.join(ROOT, "desktop/d4/evidence");
  for (const required of [
    "architecture.md", "capability-matrix.json", "benchmark-results.json", "lifecycle.json",
    "persistence.json", "terminal.json", "preview.json", "code-oss.json", "browser-tests.json",
    "concurrency.json", "security.json", "cost-drivers.json", "unresolved-vendor-questions.json",
    "cleanup.json", "recommendation.md",
  ]) assert.ok(readdirSync(evidenceDir).includes(required), required);

  const readJson = (name) => JSON.parse(readFileSync(path.join(evidenceDir, name), "utf8"));
  const capabilities = readJson("capability-matrix.json");
  const codeOss = readJson("code-oss.json");
  const concurrency = readJson("concurrency.json");
  const cleanup = readJson("cleanup.json");
  const benchmarks = readJson("benchmark-results.json");
  assert.ok(capabilities.capabilities.some((item) => item.id === "pty" && item.status === "confirmed-live"));
  assert.ok(capabilities.capabilities.some((item) => item.id === "code_oss_web" && item.status === "blocked-by-thrallo-packaging"));
  assert.equal(codeOss.thralloWorkbenchStarted, false);
  assert.equal(concurrency.representativeFullLoadProven, false);
  assert.equal(cleanup.finalNamespace.empty, true);
  assert.deepEqual(cleanup.finalNamespace.sandboxes, []);
  assert.deepEqual(cleanup.finalNamespace.volumes, []);
  assert.deepEqual(cleanup.finalNamespace.snapshots, []);
  assert.equal(benchmarks.measurements.codeOssStartupMs.blocked, true);
  assert.equal(benchmarks.measurements.workspaceCreateMs.p95, null);
  assert.match(readFileSync(path.join(evidenceDir, "recommendation.md"), "utf8"), /Daytona conditionally suitable for the next prototype stage/);
});

test("D0 protected path and Buildr101 guards remain green", () => {
  assert.doesNotThrow(() => runGuard());
});
