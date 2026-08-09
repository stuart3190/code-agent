import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const D0_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(D0_DIR, "../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

export function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function globToRegExp(glob) {
  const marker = "\u0000";
  const source = normalizePath(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", marker)
    .replaceAll("*", "[^/]*")
    .replaceAll(marker, ".*");
  return new RegExp(`^${source}$`);
}

export function matchesAny(file, patterns) {
  const normalized = normalizePath(file);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

function lines(value) {
  return String(value || "").split(/\r?\n/).map(normalizePath).filter(Boolean);
}

export function collectChangedFiles(baseCommit) {
  const groups = [
    lines(git(["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseCommit}..HEAD`])),
    lines(git(["diff", "--name-only", "--diff-filter=ACMRTUXB"])),
    lines(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"])),
    lines(git(["ls-files", "--others", "--exclude-standard"])),
  ];
  return [...new Set(groups.flat())].sort();
}

export function protectedPathViolations(files, manifest) {
  const violations = [];
  for (const file of files) {
    for (const group of manifest.protectedGroups) {
      if (matchesAny(file, group.patterns)) violations.push({ file, group: group.id });
    }
  }
  return violations;
}

export function d0ScopeViolations(files, manifest) {
  return files.filter((file) => !matchesAny(file, manifest.d0AllowedPaths));
}

function codeFiles(files) {
  return files.filter((file) => /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file));
}

export function forbiddenImportViolations(files, denylist) {
  const scanRoots = ["desktop/", "editor/vscode/", "shared/desktop/", "shared/thrallo-client/"];
  const violations = [];
  for (const file of codeFiles(files).filter((candidate) => scanRoots.some((root) => candidate.startsWith(root)))) {
    if (file === "desktop/d0/guard.mjs" || !existsSync(path.join(ROOT, file))) continue;
    const source = normalizePath(readFileSync(path.join(ROOT, file), "utf8"));
    for (const denied of forbiddenReferences(source, denylist)) violations.push({ file, denied });
  }
  return violations;
}

export function forbiddenReferences(source, denylist) {
  const forbidden = [
    ...denylist.retiredRouteModules.map((entry) => entry.path),
    ...denylist.retiredLibraries,
    ...denylist.retiredRuntimes.map((entry) => entry.path.replace(/\/\*\*$/, "")),
  ].map(normalizePath);
  const normalized = normalizePath(source);
  return forbidden.filter((denied) => normalized.includes(denied));
}

const FIXTURE_NETWORK_TOKENS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\s*\(/,
  /https?:\/\//i,
  /app\.thrallo\.com/i,
  /\bprocess\.env\b/,
];

export function fixtureFallbackViolations(files) {
  const violations = [];
  const candidates = codeFiles(files).filter((file) => /(?:^|\/)(?:fixtures?|mocks?)(?:\/|\.|-)/i.test(file));
  for (const file of candidates) {
    if (!existsSync(path.join(ROOT, file))) continue;
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const token of fixtureFallbackTokens(source)) violations.push({ file, token });
  }
  return violations;
}

export function fixtureFallbackTokens(source) {
  return FIXTURE_NETWORK_TOKENS.filter((token) => token.test(source)).map(String);
}

function validateCapabilityRegistry(registry) {
  const expected = [
    "account_auth", "projects", "conversation", "plan_approval", "agents", "models_usage",
    "builds", "files_editor", "terminal_git", "preview_testing", "snapshots_history",
    "deployments_publishing_domains", "secrets_integrations", "local_workspace",
    "cloud_workspace", "native_packaging", "tablet_mobile_companion",
  ];
  assert.deepEqual(registry.capabilities.map((item) => item.id), expected);
  assert.equal(new Set(registry.capabilities.map((item) => item.id)).size, expected.length);
  for (const capability of registry.capabilities) {
    assert.equal(capability.retirementCritical, true, `${capability.id} must be retirement-critical`);
    assert.deepEqual(Object.keys(capability.classifications), registry.classificationKeys,
      `${capability.id} must explicitly classify every parity dimension`);
    for (const [key, classification] of Object.entries(capability.classifications)) {
      assert.ok(registry.classificationValues.includes(classification.value), `${capability.id}.${key} has an invalid value`);
      assert.ok(Array.isArray(classification.evidence), `${capability.id}.${key} evidence must be an array`);
    }
  }
}

function validateProtectedManifest(manifest) {
  assert.match(manifest.baseline.forkCommit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.policy.productionMutation, "forbidden");
  assert.equal(manifest.policy.deployment, "forbidden");
  assert.equal(manifest.policy.migration, "forbidden");
  const groups = new Set(manifest.protectedGroups.map((group) => group.id));
  for (const required of [
    "builder-v2-implementation", "package-14r-15-qualification", "database-migrations",
    "production-routing-dispatch", "production-deployment-configuration", "production-workers",
    "legacy-buildr101-implementations",
  ]) assert.ok(groups.has(required), `missing protected group: ${required}`);
  assert.ok(manifest.protectedGroups.every((group) => group.reason && group.patterns.length));
}

function validateDenylist(denylist) {
  assert.equal(denylist.retiredRouteModules.length, 23);
  assert.ok(denylist.retiredRuntimes.some((entry) => entry.identity === "buildr-runtime-worker"));
  const routeManifest = readFileSync(path.join(ROOT, "test/code-agent/route-manifest.test.mjs"), "utf8");
  for (const route of denylist.retiredRouteModules) {
    const basename = path.posix.basename(route.path);
    assert.match(routeManifest, new RegExp(`['\"]${basename.replaceAll(".", "\\.")}['\"]`),
      `${basename} must remain explicitly classified by the existing route manifest`);
  }
}

function validateProviderContracts(contracts, fixtures) {
  assert.equal(contracts.globalPolicy.productionMutationFallback, "forbidden");
  assert.equal(contracts.globalPolicy.fixtureNetwork, "disabled");
  const fixtureAdapter = contracts.adapterKinds.find((adapter) => adapter.id === "fixture");
  assert.equal(fixtureAdapter.mayReadLiveApi, false);
  assert.equal(fixtureAdapter.mayMutateLiveApi, false);
  const stable = contracts.adapterKinds.find((adapter) => adapter.id === "stable-read-only");
  assert.equal(stable.mayMutateLiveApi, false);
  const builder = contracts.adapterKinds.find((adapter) => adapter.id === "builder-v2");
  assert.match(builder.availability, /^blocked-/);
  assert.equal(fixtures.network.mode, "disabled");
  assert.equal(fixtures.network.liveApiFallback, false);
  assert.equal(fixtures.network.productionMutationFallback, false);
  assert.doesNotMatch(JSON.stringify(fixtures), /https?:\/\/|app\.thrallo\.com/i);

  const families = new Map(contracts.families.map((family) => [family.id, family]));
  const scenarios = new Map(fixtures.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.equal(families.size, contracts.families.length, "provider family ids must be unique");
  assert.equal(scenarios.size, fixtures.scenarios.length, "fixture scenario ids must be unique");
  for (const family of contracts.families) {
    assert.ok(family.operations.length, `${family.id} needs operations`);
    for (const operation of family.operations) {
      assert.ok(["read", "stream", "mutation"].includes(operation.kind));
      if (operation.kind === "mutation") assert.equal(operation.builderV2Blocked, true,
        `${family.id}.${operation.id} cannot silently gain a live mutation path`);
    }
    for (const scenarioId of family.fixtureScenarios) {
      assert.equal(scenarios.get(scenarioId)?.family, family.id, `${scenarioId} must exist and belong to ${family.id}`);
    }
  }
  for (const scenario of fixtures.scenarios) assert.ok(families.has(scenario.family), `${scenario.id} has an unknown family`);
}

function validateEvidence(evidence) {
  const categories = new Set(evidence.categories);
  for (const required of ["code-oss-native", "thrallo-extension", "embedded-web", "packaging-configuration", "runtime-smoke"]) {
    assert.ok(categories.has(required), `missing desktop evidence category: ${required}`);
  }
  for (const item of evidence.items) {
    assert.ok(categories.has(item.category), `${item.id} has unknown category`);
    assert.equal(typeof item.runtimeVerified, "boolean", `${item.id} must state runtime verification explicitly`);
    assert.ok(item.evidence.length, `${item.id} requires evidence`);
  }
  assert.ok(evidence.items.some((item) => item.id === "conversation-webview" && item.category === "embedded-web" && item.runtimeVerified));
  assert.ok(evidence.items.some((item) => item.id === "cross-platform-targets" && item.state === "configured-only"));
}

function validateBoundary(boundary) {
  assert.equal(boundary.qualificationState.package14R, "pending");
  assert.equal(boundary.qualificationState.package15, "blocked");
  const blockedPackages = new Set(boundary.blockedIntegrations.flatMap((item) => item.packages));
  for (const required of ["D7", "D9", "D11", "D13", "D16", "D17"]) {
    assert.ok(blockedPackages.has(required), `${required} must remain Builder-V2-blocked`);
  }
}

function validateReleaseProvenance(provenance) {
  const upstream = readJson("desktop/upstream.json");
  const extension = readJson("editor/vscode/package.json");
  const product = readJson("desktop/product.overrides.json");
  const buildSource = readFileSync(path.join(ROOT, "desktop/build.mjs"), "utf8");
  assert.equal(provenance.repositorySource.codeOssTag, upstream.tag);
  assert.equal(provenance.repositorySource.codeOssCommit, upstream.commit);
  assert.equal(provenance.repositorySource.nodeVersion, upstream.node);
  assert.equal(provenance.repositorySource.desktopProductVersion, extension.version);
  assert.equal(provenance.publishedManifest.version, extension.version);
  assert.equal(product.updateUrl, "");
  assert.equal(provenance.signing.windowsAuthenticode, "unsigned");
  assert.equal(provenance.publishedManifest.artifactSourceCommit, null);
  for (const artifact of provenance.publishedManifest.artifacts) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.sizeBytes > 0);
  }
  for (const target of provenance.packageTargets) assert.match(buildSource, new RegExp(`['\"]${target.target}['\"]`));
  assert.equal(provenance.smokeEvidence.recordedResult, "6/6");
  assert.equal(provenance.smokeEvidence.rerunDuringD0, false);
}

export function validateAll() {
  const manifests = {
    registry: readJson("desktop/d0/capability-registry.json"),
    protectedPaths: readJson("desktop/d0/protected-paths.json"),
    denylist: readJson("desktop/d0/buildr101-denylist.json"),
    contracts: readJson("desktop/d0/provider-contracts.json"),
    fixtures: readJson("desktop/d0/fixtures/provider-scenarios.json"),
    evidence: readJson("desktop/d0/desktop-evidence.json"),
    boundary: readJson("desktop/d0/builder-v2-boundary.json"),
    provenance: readJson("desktop/d0/release-provenance.json"),
  };
  validateCapabilityRegistry(manifests.registry);
  validateProtectedManifest(manifests.protectedPaths);
  validateDenylist(manifests.denylist);
  validateProviderContracts(manifests.contracts, manifests.fixtures);
  validateEvidence(manifests.evidence);
  validateBoundary(manifests.boundary);
  validateReleaseProvenance(manifests.provenance);
  return manifests;
}

export function runGuard({ phase = null } = {}) {
  const manifests = validateAll();
  const changedFiles = collectChangedFiles(manifests.protectedPaths.baseline.forkCommit);
  const protectedViolations = protectedPathViolations(changedFiles, manifests.protectedPaths);
  const importViolations = forbiddenImportViolations(changedFiles, manifests.denylist);
  const fallbackViolations = fixtureFallbackViolations(changedFiles);
  const scopeViolations = phase === "D0" ? d0ScopeViolations(changedFiles, manifests.protectedPaths) : [];
  assert.deepEqual(protectedViolations, [], `protected desktop boundary touched:\n${JSON.stringify(protectedViolations, null, 2)}`);
  assert.deepEqual(importViolations, [], `retired Buildr101 dependency introduced:\n${JSON.stringify(importViolations, null, 2)}`);
  assert.deepEqual(fallbackViolations, [], `fixture network/production fallback introduced:\n${JSON.stringify(fallbackViolations, null, 2)}`);
  assert.deepEqual(scopeViolations, [], `D0 contains files outside its approved documentation/contract/evidence/test scope:\n${scopeViolations.join("\n")}`);
  return { changedFiles, phase: phase || "desktop-foundation" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phaseIndex = process.argv.indexOf("--phase");
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : null;
  const result = runGuard({ phase });
  console.log(`D0 guard passed (${result.changedFiles.length} desktop-branch files checked; phase=${result.phase}).`);
}
