import assert from "node:assert/strict";
import test from "node:test";

import {
  d0ScopeViolations,
  fixtureFallbackTokens,
  fixtureFallbackViolations,
  forbiddenReferences,
  forbiddenImportViolations,
  globToRegExp,
  matchesAny,
  protectedPathViolations,
  runGuard,
  validateAll,
} from "../../desktop/d0/guard.mjs";

test("D0 manifests are complete and internally consistent", () => {
  const manifests = validateAll();
  assert.equal(manifests.registry.capabilities.length, 17);
  assert.equal(manifests.contracts.families.length, 10);
  assert.ok(manifests.fixtures.scenarios.length >= 40);
});

test("protected path globs classify Builder V2, migrations, routes and operations", () => {
  const { protectedPaths } = validateAll();
  const files = [
    "shell/server/lib/builderV2/orchestrator.mjs",
    "test/code-agent/package14r-quality-repair.test.mjs",
    "supabase/migrations/20990101000000_bad.sql",
    "shell/server/index.mjs",
    "ops/Caddyfile.unified",
    "build-worker/index.mjs",
    "runtime-worker/index.mjs",
  ];
  const violations = protectedPathViolations(files, protectedPaths);
  assert.equal(new Set(violations.map((item) => item.file)).size, files.length);
  assert.equal(matchesAny("desktop/d0/example.json", protectedPaths.d0AllowedPaths), true);
  assert.equal(matchesAny("editor/vscode/extension.js", protectedPaths.d0AllowedPaths), false);
  assert.match("ops/Caddyfile.unified", globToRegExp("ops/**"));
});

test("D0 scope fails closed outside contracts, evidence and harness paths", () => {
  const { protectedPaths } = validateAll();
  assert.deepEqual(d0ScopeViolations([
    "desktop/d0/capability-registry.json",
    "test/desktop/d0-contracts.test.mjs",
    "package.json",
  ], protectedPaths), []);
  assert.deepEqual(d0ScopeViolations(["editor/vscode/extension.js"], protectedPaths), ["editor/vscode/extension.js"]);
});

test("retired Buildr101 imports are detected in desktop source", () => {
  const { denylist } = validateAll();
  assert.deepEqual(forbiddenReferences(
    'import { handleGenerate } from "../../shell/server/routes/generate.mjs";',
    denylist,
  ), ["shell/server/routes/generate.mjs"]);
  assert.deepEqual(forbiddenReferences('import "../../runtime-worker/index.mjs";', denylist), ["runtime-worker"]);
  assert.deepEqual(forbiddenImportViolations(["desktop/d0/capability-registry.json"], denylist), []);
  const deniedPaths = new Set([
    ...denylist.retiredRouteModules.map((entry) => entry.path),
    ...denylist.retiredLibraries,
    ...denylist.retiredRuntimes.map((entry) => entry.path),
  ]);
  assert.ok(deniedPaths.has("shell/server/routes/generate.mjs"));
  assert.ok(deniedPaths.has("runtime-worker/**"));
});

test("fixture source scanners reject network and production fallback primitives", () => {
  assert.deepEqual(fixtureFallbackViolations(["desktop/d0/fixtures/provider-scenarios.json"]), []);
  assert.deepEqual(fixtureFallbackTokens('return fetch("https://app.thrallo.com/api/v1/projects")').length, 3);
  assert.deepEqual(fixtureFallbackTokens('return deterministicFixture;'), []);
  const { contracts, fixtures } = validateAll();
  assert.equal(contracts.globalPolicy.productionMutationFallback, "forbidden");
  assert.equal(fixtures.network.liveApiFallback, false);
  assert.equal(fixtures.network.productionMutationFallback, false);
});

test("the current D0 branch diff passes the protected-boundary guard", () => {
  const result = runGuard({ phase: "D0" });
  assert.ok(result.changedFiles.includes("desktop/d0/capability-registry.json"));
  assert.ok(result.changedFiles.includes("test/desktop/d0-contracts.test.mjs"));
});
