// WP0 — the frozen baseline and coverage ledger.
//
// Every current registry, scaffold, SDK, runtime-operation and requirement-signal entry must be
// mapped to a target module and a work package, and the versioned formats a historical snapshot
// may carry must be pinned. A later work package that changes any of these must update the ledger
// in the same commit; this suite is what notices when it does not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  BASELINE, BASELINE_FORMAT_VERSIONS, BASELINE_PROMPT_MEASUREMENTS, BASELINE_PROTECTED_PATH_SOURCES,
  BASELINE_RETAINED_FIXTURES, BASELINE_RUNTIME_REFRESH_PATTERN, BASELINE_SNAPSHOT_ROW_FIELDS,
  COVERAGE_LEDGER, CURRENT_FORMAT_VERSIONS, CURRENT_PROTECTED_PATH_SOURCES, CURRENT_RUNTIME_REFRESH_PATTERN,
  MODULE_CATALOGUE, coverageLedgerReport, ledgerEntry, ledgerRows,
  validateCoverageLedger, workPackageScope,
} from "../../shell/server/lib/builderV2/platformModules/coverageLedger.mjs";
import { MANIFEST_SCHEMA_VERSION } from "../../shell/server/lib/builderV2/platformModules/manifest.mjs";
import { MODULE_LOCK_VERSION } from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import { MODULE_RESOLUTION_VERSION } from "../../shell/server/lib/builderV2/platformModules/resolver.mjs";
import { AVAILABILITY_VERSION } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { IDENTITY_PLAN_VERSION } from "../../shell/server/lib/builderV2/platformModules/identityPlan.mjs";
import { ABI_LINT_VERSION } from "../../shell/server/lib/builderV2/platformModules/abiLint.mjs";
import { ACCOUNT_POLICY_VERSION } from "../../shell/server/lib/appAccounts/accountPolicyStore.mjs";
import { ACCOUNT_SERVICE_VERSION } from "../../supabase/functions/app-accounts/accountService.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { SCAFFOLDS, SCAFFOLD_REGISTRY_VERSION } from "../../shell/server/lib/builderV2/scaffoldRegistry.mjs";
import { RUNTIME_CAPABILITY_OPERATIONS } from "../../shell/server/lib/capabilityRuntime.mjs";
import { REQUIREMENT_SIGNALS, BUILD_PROFILE_VERSION } from "../../shell/shared/buildProfile.mjs";
import { CONTRACT_VERSION } from "../../shell/shared/implementationContract.mjs";
import { BUILD_SPEC_VERSION } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { CAPABILITY_GRAPH_VERSION } from "../../shell/server/lib/builderV2/capabilityGraph.mjs";
import { SCAFFOLD_GRAPH_VERSION } from "../../shell/server/lib/builderV2/scaffoldGraph.mjs";
import {
  SCAFFOLD_COMPOSITION_VERSION, SCAFFOLD_PRIMITIVES_PATH, renderScaffoldFoundation,
} from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { CAPABILITY_COMPOSITION_VERSION } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { EXECUTION_PROVENANCE_VERSION } from "../../shell/server/lib/builderV2/executionProvenance.mjs";
import { EXECUTION_SPEC_VERSION } from "../../shell/server/lib/builderV2/executionSpec.mjs";
import { ROUTE_RESOLUTION_VERSION } from "../../shell/server/lib/builderV2/routeResolution.mjs";
import { PROTECTED_PATHS } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { createSnapshotStore, memorySnapshotStorage } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { SYSTEM_PROMPT } from "../../shell/server/lib/appBuild/contractAgent.mjs";
import {
  COMPILE_CORRECTION_SYSTEM_PROMPT, HEADROOM_FRAGMENT_SYSTEM_PROMPT, PATCH_SYSTEM_PROMPT,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const SDK_INDEX = "src/scaffolds/reactVite/lib/backend/index.js";
const SDK_BACKEND = "src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
const VISITOR_SESSION = "src/scaffolds/reactVite/lib/visitorSession.js";

function primitiveExports() {
  const source = renderScaffoldFoundation({ screens: [], routes: [], families: [] })
    .protectedFiles[SCAFFOLD_PRIMITIVES_PATH];
  const names = new Set();
  for (const match of source.matchAll(/^export (?:function|const|class) ([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  return [...names];
}

function sdkIndexExports() {
  const source = read(SDK_INDEX);
  return [...source.matchAll(/^export const ([a-z][\w]*) = backend\.\1;/gm)].map((match) => match[1]);
}

test("WP0 — the baseline pins the audited revision and every retained corpus still exists", () => {
  assert.match(BASELINE.revision, /^[0-9a-f]{40}$/);
  assert.equal(BASELINE.revision, "e83d4ef212b08fc2aa9d9ddc0937cd279ad8d042");
  assert.equal(BASELINE.branch, "astra/execution-authority-20260907");
  for (const fixture of BASELINE_RETAINED_FIXTURES) {
    assert.ok(existsSync(path.join(ROOT, fixture)), `retained fixture missing: ${fixture}`);
  }
});

test("WP0 — the baseline formats stay frozen and every live format equals the recorded current version", () => {
  // The baseline is what historical snapshots carry; it never moves.
  assert.deepEqual(BASELINE_FORMAT_VERSIONS, {
    implementationContract: 2, buildProfile: 1, buildSpec: 3, capabilityGraph: 2, scaffoldRegistry: 1,
    scaffoldGraph: 3, scaffoldComposition: 3, capabilityComposition: 1, executionProvenance: 2,
    executionSpec: 1, routeResolution: 1,
  });
  // The live source must match the ledger's record of the current formats: a re-version without a
  // ledger entry (and therefore without a compatibility note) fails here.
  assert.deepEqual({
    implementationContract: CONTRACT_VERSION,
    buildProfile: BUILD_PROFILE_VERSION,
    buildSpec: BUILD_SPEC_VERSION,
    capabilityGraph: CAPABILITY_GRAPH_VERSION,
    scaffoldRegistry: SCAFFOLD_REGISTRY_VERSION,
    scaffoldGraph: SCAFFOLD_GRAPH_VERSION,
    scaffoldComposition: SCAFFOLD_COMPOSITION_VERSION,
    capabilityComposition: CAPABILITY_COMPOSITION_VERSION,
    executionProvenance: EXECUTION_PROVENANCE_VERSION,
    executionSpec: EXECUTION_SPEC_VERSION,
    routeResolution: ROUTE_RESOLUTION_VERSION,
    moduleManifest: MANIFEST_SCHEMA_VERSION,
    moduleLock: MODULE_LOCK_VERSION,
    moduleResolution: MODULE_RESOLUTION_VERSION,
    deploymentAvailability: AVAILABILITY_VERSION,
    identityPlan: IDENTITY_PLAN_VERSION,
    abiLint: ABI_LINT_VERSION,
    accountPolicy: ACCOUNT_POLICY_VERSION,
    accountService: ACCOUNT_SERVICE_VERSION,
  }, CURRENT_FORMAT_VERSIONS);
});

test("WP0 — the snapshot row shape and the protected write guard are captured exactly", async () => {
  // The baseline guard is frozen; the live guard equals the ledger's record of the current one.
  assert.deepEqual([...BASELINE_PROTECTED_PATH_SOURCES], [
    "^src\\/lib\\/backend\\/", "^src\\/lib\\/visitorSession\\.js$", "^src\\/lib\\/capabilities\\/", "^src\\/lib\\/scaffolds\\/composed\\/",
  ]);
  assert.deepEqual(PROTECTED_PATHS.map((pattern) => pattern.source), [...CURRENT_PROTECTED_PATH_SOURCES]);
  const orchestrator = read("shell/server/lib/builderV2/orchestrator.mjs");
  assert.ok(orchestrator.includes(CURRENT_RUNTIME_REFRESH_PATTERN),
    "refreshPlatformRuntime pattern drifted from the ledger");
  assert.ok(CURRENT_RUNTIME_REFRESH_PATTERN.startsWith(BASELINE_RUNTIME_REFRESH_PATTERN.slice(0, 12)));
  const store = createSnapshotStore(memorySnapshotStorage());
  const snapshot = await store.createSnapshot("owner", "project", { "src/App.jsx": "export default () => null;" }, { buildId: "b1" });
  for (const field of BASELINE_SNAPSHOT_ROW_FIELDS) assert.ok(field in snapshot, `snapshot row lacks ${field}`);
  assert.equal(snapshot.state, "ready");
});

test("WP0 — prompt literal measurements are pinned so later packages report a real delta", () => {
  assert.deepEqual({
    contractSystemPrompt: SYSTEM_PROMPT.length,
    patchSystemPrompt: PATCH_SYSTEM_PROMPT.length,
    compileCorrectionSystemPrompt: COMPILE_CORRECTION_SYSTEM_PROMPT.length,
    headroomFragmentSystemPrompt: HEADROOM_FRAGMENT_SYSTEM_PROMPT.length,
  }, BASELINE_PROMPT_MEASUREMENTS);
});

test("WP0 — the ledger is structurally valid and names only catalogued modules", () => {
  const verdict = validateCoverageLedger();
  assert.deepEqual(verdict, { ok: true, problems: [] });
  assert.equal(Object.keys(MODULE_CATALOGUE).length, 37, "the audit catalogue has 37 modules");
  for (const [id, module] of Object.entries(MODULE_CATALOGUE)) {
    assert.match(id, /^thrallo\.[a-zA-Z0-9]+$/);
    assert.ok(module.workPackage >= 1 && module.workPackage <= 15, `${id} work package`);
  }
  for (const entry of COVERAGE_LEDGER) assert.equal(entry.removed, false, `${entry.kind}:${entry.id} removed at WP0`);
});

test("WP0 — every live registry, scaffold, SDK, runtime and signal entry is mapped; no row is stale", () => {
  const report = coverageLedgerReport({
    capabilities: Object.keys(CAPABILITIES),
    scaffolds: Object.keys(SCAFFOLDS),
    scaffoldPrimitives: primitiveExports(),
    sdkSurfaces: ledgerRows("sdk_surface").map((entry) => entry.id),
    runtimeOperationFamilies: RUNTIME_CAPABILITY_OPERATIONS,
    requirementSignals: REQUIREMENT_SIGNALS,
  });
  assert.deepEqual({ unmapped: report.unmapped, stale: report.stale }, { unmapped: [], stale: [] });
  assert.equal(report.ok, true);
  assert.equal(report.counts.capability, 11, "8 at the baseline + accounts, authorization, admin (WP4)");
  assert.equal(report.counts.scaffold_family, 12);
  assert.equal(report.counts.runtime_operation_family, 7);
  assert.equal(report.counts.requirement_signal, 9);
});

test("WP0 — no capability, scaffold family or runtime family was removed relative to the audit", () => {
  const baselineCapabilities = ["booking", "contact", "crud", "interaction-primitives", "newsletter", "roles", "session", "wizard"];
  for (const id of baselineCapabilities) assert.ok(CAPABILITIES[id], `baseline capability ${id} still registered`);
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), [...baselineCapabilities, "accounts", "admin", "authorization"].sort(),
    "additions are ledgered (WP4: accounts, authorization, admin); nothing removed");
  assert.deepEqual(Object.keys(SCAFFOLDS).sort(), [
    "admin_management", "app_shell", "auth_account", "canvas_editor", "catalogue_detail",
    "content_navigation", "crud_resource", "dashboard", "export_output", "project_workspace",
    "scheduling", "workflow",
  ]);
  assert.deepEqual(Object.keys(RUNTIME_CAPABILITY_OPERATIONS).sort(), [
    "document", "http", "knowledge", "media", "meta", "openai", "replicate",
  ]);
  assert.equal(CAPABILITIES.session.aliases.includes("auth"), true, "auth alias retained");
});

test("WP0 — every SDK surface export has a ledger row and every ledged member exists in the SDK source", () => {
  const backend = read(SDK_BACKEND);
  const visitor = read(VISITOR_SESSION);
  for (const name of sdkIndexExports()) {
    const owner = ledgerRows("sdk_surface").find((entry) => entry.id === name || entry.id.startsWith(`${name}.`));
    assert.ok(owner, `SDK export ${name} has no ledger row`);
  }
  for (const entry of ledgerRows("sdk_surface")) {
    for (const member of entry.members || []) {
      const source = entry.id === "visitorSession" ? `${backend}\n${visitor}` : backend;
      const pattern = new RegExp(`(?:async\\s+)?\\b${member}\\b\\s*[(:=]`);
      assert.ok(pattern.test(source), `${entry.id}.${member} is not present in the SDK source`);
    }
  }
});

test("WP0 — work-package scopes partition the migration and the first milestone is identity through async state", () => {
  const milestone = [0, 1, 2, 3, 4, 5, 6, 7];
  const coveredModules = new Set(milestone.flatMap((wp) => workPackageScope(wp).map((entry) => entry.targetModule)).filter(Boolean));
  for (const id of ["thrallo.identity", "thrallo.accounts", "thrallo.authorization", "thrallo.admin",
    "thrallo.entities", "thrallo.routing", "thrallo.query", "thrallo.forms", "thrallo.async"]) {
    assert.ok(coveredModules.has(id), `${id} must land inside WP0–WP7`);
  }
  assert.equal(ledgerEntry("capability", "session").targetModule, "thrallo.identity");
  assert.equal(ledgerEntry("scaffold_family", "admin_management").targetModule, "thrallo.admin");
  assert.equal(ledgerEntry("requirement_signal", "custom_logic").targetModule, null, "custom logic stays generated");
  const seams = ["payments", "file_uploads", "realtime"].map((id) => ledgerEntry("requirement_signal", id));
  for (const seam of seams) assert.match(seam.disposition, /explicit unavailable result/);
});
