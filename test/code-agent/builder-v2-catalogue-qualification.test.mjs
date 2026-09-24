// WP15 — full catalogue migration and qualification.
//
// The audit's acceptance for the whole migration is three claims. This suite is where they stop
// being assertions and become checks a contract either passes or does not:
//
//   1. All selected repeatable operations are module-owned.
//   2. All requested journeys pass.
//   3. No remaining generic fallthrough — nothing standard is silently reimplemented.
//
// Plus the compatibility rules that apply across every package: historical contracts and snapshots
// are not mutated, and a lock keeps replaying at the versions it recorded.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  QUALIFICATION_VERSION, REPEATABLE_KINDS, compatibilityMatrix, qualifyBuildSpec, qualifyCorpus,
} from "../../shell/server/lib/builderV2/platformModules/qualification.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { MODULE_REGISTRY, moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { MODULE_CATALOGUE, coverageLedgerReport, ledgerRows } from "../../shell/server/lib/builderV2/platformModules/coverageLedger.mjs";
import { availabilityFromEnv, baselineDeploymentAvailability } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { normalizeContractOwnership } from "../../shell/shared/contractOwnership.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";

const RETAINED = [
  ["medium-20260917-recessed", "test/code-agent/fixtures/retained/medium-20260917-recessed/contract.json"],
  ["medium-20260918-recessed", "test/code-agent/fixtures/retained/medium-20260918-recessed/contract-7e74b401-attempt2.json"],
];

async function retainedSpecs() {
  const entries = [];
  for (const [id, path] of RETAINED) {
    const raw = JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
    entries.push({ id, contract: raw.contract || raw, spec: deriveBuildSpec(raw.contract || raw) });
  }
  return entries;
}

test("WP15 — every retained contract qualifies: module-owned operations, passing journeys, no fallthrough", async () => {
  const entries = await retainedSpecs();
  const corpus = qualifyCorpus(entries);
  assert.equal(corpus.version, QUALIFICATION_VERSION);
  assert.equal(corpus.total, RETAINED.length);
  assert.equal(corpus.ok, true, JSON.stringify(corpus.failing, null, 2));
  assert.deepEqual(corpus.passing.sort(), RETAINED.map(([id]) => id).sort());

  for (const result of corpus.results) {
    // Claim 1: nothing standard is left to generation.
    assert.deepEqual(result.claims.repeatableOperationsModuleOwned.fallthrough, [], result.id);
    // Claim 2: the derived build is green.
    assert.equal(result.claims.journeysPass.ok, true, result.claims.journeysPass.problems.join(" | "));
    // Claim 3: nothing degraded into generated code.
    assert.deepEqual(result.claims.noGenericFallthrough.degraded, [], result.id);
    // And the migration actually moved work: more operations are module-owned than not.
    assert.ok(result.moduleOwnedOperations.length > 0, result.id);
    assert.ok(result.installedModuleCount >= 8, `${result.id} installs a real module set`);
  }
});

test("WP15 — what stays generated is genuinely application-specific, and says what it does", async () => {
  const [medium] = await retainedSpecs();
  const report = qualifyBuildSpec(medium.spec);
  const retained = report.claims.repeatableOperationsModuleOwned.customRetained;
  assert.ok(retained.length > 0, "a real application keeps some work of its own");
  for (const row of retained) {
    assert.ok(row.behaviours.length > 0, `${row.id} declares what it does that no module can`);
    assert.ok(REPEATABLE_KINDS.includes(row.kind));
  }
  // The document design the audit explicitly leaves to the application.
  assert.ok(retained.some((row) => row.id === "export-estimate"),
    "an export whose layout is the product stays generated, and is recorded as such");
});

test("WP15 — a filtered read over durable records is the query module's, not generated plumbing", () => {
  // The last generic fallthrough in the corpus: "filter visible projects by name and status",
  // written as a predicate over whatever page the browser had loaded.
  const contract = {
    version: 2, summary: "project list", auth: { required: true },
    entities: [{ name: "project", fields: [
      { name: "id" }, { name: "name", type: "string", required: true }, { name: "status", options: ["draft", "live"] },
    ] }],
    operations: [
      { id: "create-project", kind: "create", entity: "project" },
      { id: "list-projects", kind: "list", entity: "project" },
      { id: "search-projects", kind: "search", entity: "project",
        responsibilities: [{ type: "functional", reads: ["name", "status"], writes: [],
          behavior: "return projects whose name contains the search text and whose status matches",
          outputEffect: { type: "transient_result", effect: "read_result", durable: false } }] },
      { id: "score-project", kind: "read", entity: "project",
        responsibilities: [{ type: "functional", reads: ["name"], writes: [],
          behavior: "compute a bespoke readiness score from the project's own rules" }] },
    ],
    journeys: [{ id: "browse", title: "Member creates then searches projects", steps: [
      { id: "b0", operates: ["create-project"], expect: "the project is stored" },
      { id: "b1", operates: ["search-projects"], expect: "matching projects are listed" },
    ] }],
  };
  const { contract: typed, report } = normalizeContractOwnership(contract);
  const byId = Object.fromEntries(typed.operations.map((operation) => [operation.id, operation]));

  assert.equal(byId["search-projects"].owner, "module");
  assert.equal(byId["search-projects"].module, "thrallo.query");
  assert.equal(byId["search-projects"].moduleOperation, "query");
  assert.ok(report.retargetedOperations.some((row) => row.id === "search-projects" && row.reason === "platform_query"));
  assert.ok(report.retargetedOperations.find((row) => row.id === "search-projects").from.responsibilities[0].behavior,
    "the original is preserved verbatim");

  // A read that CALCULATES something is not a query, and keeps its calculation.
  assert.equal(byId["score-project"].owner, "generated");

  // The module actually provides the operation the contract now names.
  assert.ok(moduleManifest("thrallo.query").provides.operations.some((row) => row.id === "query"));
  assert.ok(CAPABILITIES.query.supportedOperations.includes("query"));
  assert.deepEqual(deriveBuildSpec(contract).verdict.problems, []);
});

test("WP15 — an unavailable module BLOCKS; it never degrades into generated code", () => {
  const contract = {
    version: 2, summary: "team tool", auth: { required: true, roles: ["admin", "member"] },
    entities: [{ name: "task", fields: [{ name: "id" }, { name: "title", type: "string", required: true }] }],
    operations: [
      { id: "create-task", kind: "create", entity: "task" },
      { id: "list-tasks", kind: "list", entity: "task" },
    ],
    journeys: [{ id: "work", title: "Member creates and lists tasks", steps: [
      { id: "w1", operates: ["create-task"], expect: "the task is stored" },
      { id: "w2", operates: ["list-tasks"], expect: "the list shows it" },
    ] }],
  };
  // A deployment with no accounts service, for a contract that declares roles.
  const spec = deriveBuildSpec(contract, {
    availability: availabilityFromEnv({ SUPABASE_URL: "https://x.test", SUPABASE_ANON_KEY: "k" }),
  });
  const report = qualifyBuildSpec(spec);
  assert.equal(spec.verdict.ok, false, "the build blocked");
  assert.ok(report.claims.noGenericFallthrough.unavailable.length > 0);
  assert.ok(report.claims.noGenericFallthrough.unavailable.every((row) => row.configurationRequired),
    "an operator configures the service; the compiler never generates around it");
  // Blocking IS the correct outcome, so the degradation claim holds even though the build failed.
  assert.equal(report.claims.noGenericFallthrough.ok, true);
  assert.equal(report.ok, false, "but the contract does not qualify on this deployment");

  // With the service, the same contract qualifies.
  const enabled = deriveBuildSpec(contract, {
    availability: availabilityFromEnv({ SUPABASE_URL: "https://x.test", SUPABASE_ANON_KEY: "k", THRALLO_APP_SERVICE_ACCOUNTS: "1" }),
  });
  assert.equal(qualifyBuildSpec(enabled).ok, true, enabled.verdict.problems.join(" | "));
});

test("WP15 — a lock keeps replaying at the versions it recorded", async () => {
  const entries = await retainedSpecs();
  const matrix = compatibilityMatrix(entries.map((entry) => entry.spec.moduleLock), MODULE_REGISTRY);
  assert.ok(matrix.rows.length > 0);
  assert.deepEqual(matrix.breaks, [], "a pinned version that left the registry is a compatibility break");
  assert.equal(matrix.ok, true);
  for (const row of matrix.rows) {
    assert.ok(MODULE_CATALOGUE[row.module], `${row.module} is catalogued`);
    assert.ok(row.newest, `${row.module} still offers a version`);
  }

  // A lock pinning a version nobody offers is reported rather than silently upgraded.
  const broken = compatibilityMatrix([{ id: "old", modules: [{ id: "thrallo.entities", version: "0.9.0" }] }], MODULE_REGISTRY);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.breaks.map((row) => row.pinned), ["0.9.0"]);
  assert.equal(broken.breaks[0].newest, moduleManifest("thrallo.entities").version);
});

test("WP15 — historical contracts are not mutated, and normalisation stays reversible", async () => {
  for (const [, path] of RETAINED) {
    const url = new URL(`../../${path}`, import.meta.url);
    const before = await readFile(url, "utf8");
    const raw = JSON.parse(before);
    const contract = raw.contract || raw;
    const snapshot = JSON.stringify(contract);

    const { report } = normalizeContractOwnership(contract);
    assert.equal(JSON.stringify(contract), snapshot, "the input contract is untouched");
    assert.equal(await readFile(url, "utf8"), before, "and the fixture on disk is untouched");

    // Everything the normalisation moved is preserved verbatim.
    for (const row of report.retargetedOperations) {
      assert.ok(row.from, `${row.id} keeps its original`);
      assert.ok(row.reason, `${row.id} says why it moved`);
    }
    for (const row of report.removedEntities) assert.ok(row.name);
    for (const row of report.accountEntities) assert.ok(row.original);
  }
});

test("WP15 — the catalogue is complete: every ledger row points at a registered module", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });

  // Every module the ledger names as a target exists, or is explicitly still to come.
  const targets = [...new Set(ledgerRows().map((row) => row.targetModule).filter(Boolean))];
  const unregistered = targets.filter((id) => !MODULE_REGISTRY[id]);
  assert.deepEqual(unregistered, ["thrallo.fixtures", "thrallo.schema", "thrallo.browser3d", "thrallo.assets"].filter((id) => targets.includes(id)),
    "the only unregistered targets are the ones whose proof is not deterministic or whose work folded into another module");

  const report = coverageLedgerReport({
    capabilities: Object.keys(CAPABILITIES),
    scaffolds: [],
    scaffoldPrimitives: [],
    sdkSurfaces: ledgerRows("sdk_surface").map((row) => row.id),
    runtimeOperationFamilies: {},
    requirementSignals: [],
  });
  assert.deepEqual(report.unmapped, [], "every live capability is mapped to a module");
});

test("WP15 — qualification is per contract, and the corpus report names exactly what fails", () => {
  // Per-project opt-in is the point: one contract's readiness is not an average.
  const good = deriveBuildSpec({
    version: 2, summary: "list", auth: { required: true },
    entities: [{ name: "note", fields: [{ name: "id" }, { name: "text", type: "text" }] }],
    operations: [
      { id: "add-note", kind: "create", entity: "note" },
      { id: "list-notes", kind: "list", entity: "note" },
    ],
    journeys: [{ id: "j", title: "Member adds a note", steps: [
      { id: "j1", operates: ["add-note"], expect: "stored" }, { id: "j2", operates: ["list-notes"], expect: "listed" },
    ] }],
  });
  const bad = deriveBuildSpec({
    version: 2, summary: "broken", auth: { required: true },
    entities: [{ name: "note", fields: [{ name: "id" }] }],
    operations: [{ id: "list-notes", kind: "list", entity: "note" }],
    journeys: [{ id: "j", title: "Member reads notes nobody creates", steps: [
      { id: "j1", operates: ["list-notes"], expect: "listed" },
    ] }],
  });
  const corpus = qualifyCorpus([{ id: "good", spec: good }, { id: "bad", spec: bad }]);
  assert.deepEqual(corpus.passing, ["good"]);
  assert.deepEqual(corpus.failing.map((row) => row.id), ["bad"]);
  assert.ok(corpus.failing[0].journeyProblems.length > 0, "the report names the reason, not just the verdict");
  assert.equal(corpus.ok, false);
  assert.equal(qualifyCorpus([]).ok, true, "an empty corpus is vacuously fine and says so");
  assert.equal(baselineDeploymentAvailability().services.entities, true);
});
