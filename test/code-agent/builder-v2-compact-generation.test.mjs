// WP14 — compact generation and repair ownership.
//
// Two claims, both measurable:
//
//   1. A build with a module lock is briefed with its PUBLIC ABI — what src/lib/app exports —
//      rather than the whole composed surface. Smaller prompts, and the brief names only what
//      generated code may import, so it stops arguing against the rule it is meant to teach.
//   2. A defect whose implicated files are ALL platform-owned is a MODULE FAULT. It is never
//      handed to the model as an application patch, because the model may not write those files
//      and a repair that tries will either fail the write guard or rewrite the application around
//      a module that is working correctly (audit §14).
//
// Old snapshots keep the legacy projection: a tree composed before the facade existed cannot
// import from it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ABI_PROJECTION_VERSION, abiProjectionDelta, abiProjectionParity, projectPublicAbi,
} from "../../shell/server/lib/builderV2/platformModules/abiProjection.mjs";
import { REPAIR_OWNERSHIP, classifyRepairOwnership } from "../../shell/server/lib/builderV2/repairGovernance.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { capabilityCompositionBrief } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";

const CONTRACT = {
  version: 2, summary: "studio project tool", auth: { required: true, roles: ["admin", "member"] },
  entities: [{ name: "project", fields: [
    { name: "id" }, { name: "name", type: "string", required: true }, { name: "budget", type: "number" },
  ] }],
  operations: [
    { id: "create-project", kind: "create", entity: "project" },
    { id: "list-projects", kind: "list", entity: "project" },
    { id: "update-project", kind: "update", entity: "project" },
  ],
  journeys: [{ id: "work", title: "Member creates and updates a project", steps: [
    { id: "w1", operates: ["create-project"], expect: "the project is stored" },
    { id: "w2", operates: ["list-projects"], expect: "the list shows it" },
  ] }],
};

const spec = deriveBuildSpec(CONTRACT);

test("WP14 — the public ABI is projected from the composed bytes, and names only what may be imported", () => {
  const projection = projectPublicAbi({ moduleLock: spec.moduleLock, compositionPlan: spec.compositionPlan });
  assert.equal(projection.version, ABI_PROJECTION_VERSION);
  assert.ok(projection.facades.includes("identity"));
  assert.ok(projection.facades.includes("entities"));
  assert.ok(projection.imports.includes("useSession"));
  assert.ok(projection.imports.includes("repository"));

  // The brief teaches the rule it enforces, and names every path it expects an import from.
  assert.ok(projection.text.includes('From "./lib/app":'));
  assert.ok(projection.text.includes("Import ONLY the names listed above, from the paths shown"));
  assert.equal(projection.text.includes("src/lib/capabilities/composed/identity.js"), false,
    "a capability that HAS a facade is named through the facade, never its private module");

  // Every composed facade is named, and nothing private is offered as an import.
  const parity = abiProjectionParity(projection, spec.compositionPlan);
  assert.deepEqual(parity, { ok: true, missing: [], leaked: [] });

  // What each facade owns comes from the composed module behind it, so the two cannot drift.
  assert.ok(projection.text.includes("owns session"));
  assert.ok(projection.text.includes("owns project"));
});

test("WP14 — the compact projection is measurably smaller than the surface it replaces", () => {
  const projection = projectPublicAbi({ moduleLock: spec.moduleLock, compositionPlan: spec.compositionPlan });
  const legacy = capabilityCompositionBrief(spec.capabilityGraph);
  const delta = abiProjectionDelta(projection, legacy);

  assert.ok(delta.compactCharacters > 0);
  assert.ok(delta.legacyCharacters > delta.compactCharacters,
    `the projection (${delta.compactCharacters}) is smaller than the legacy brief (${delta.legacyCharacters})`);
  // Adding the facade-less capabilities on 2026-09-20 cost about a third of the saving and bought
  // correctness; hiding the modules the facades already cover gave most of it back. Completeness
  // was never in tension with compactness here — naming private plumbing was just waste.
  assert.ok(delta.ratio < 0.8, `a real saving, not a rounding one (ratio ${delta.ratio})`);
  assert.equal(delta.savedCharacters, delta.legacyCharacters - delta.compactCharacters);
  assert.deepEqual(abiProjectionDelta(projection, ""), {
    legacyCharacters: 0, compactCharacters: projection.characters, savedCharacters: 0, ratio: null,
  });
});

test("WP14 — a build with no lock keeps the legacy projection", () => {
  // A retained snapshot composed before the facade existed cannot import from it, so it must not
  // be told to. The projection declines rather than inventing a surface the tree does not have.
  assert.equal(projectPublicAbi({ moduleLock: null, compositionPlan: spec.compositionPlan }), null);
  assert.equal(projectPublicAbi({ moduleLock: { modules: [] }, compositionPlan: spec.compositionPlan }), null);
  assert.equal(projectPublicAbi({}), null);

  const prompt = renderPatchPrompt({
    step: "implement", contract: spec.contract, tiers: spec.tiers, tree: {}, journey: spec.contract.journeys[0],
    capabilityGraph: spec.capabilityGraph, compositionPlan: spec.compositionPlan,
    scaffoldGraph: spec.scaffoldGraph, scaffoldPlan: spec.scaffoldCompositionPlan,
    moduleLock: null,
  });
  assert.ok(typeof prompt === "string" && prompt.length > 0);
  assert.equal(prompt.includes("PUBLIC ABI — the whole platform surface"), false,
    "an unlocked build is briefed exactly as before");
});

test("WP14 — a locked build's generation prompt carries the public ABI instead of the composed surface", () => {
  const locked = renderPatchPrompt({
    step: "implement", contract: spec.contract, tiers: spec.tiers, tree: {}, journey: spec.contract.journeys[0],
    capabilityGraph: spec.capabilityGraph, compositionPlan: spec.compositionPlan,
    scaffoldGraph: spec.scaffoldGraph, scaffoldPlan: spec.scaffoldCompositionPlan,
    moduleLock: spec.moduleLock,
  });
  const legacy = renderPatchPrompt({
    step: "implement", contract: spec.contract, tiers: spec.tiers, tree: {}, journey: spec.contract.journeys[0],
    capabilityGraph: spec.capabilityGraph, compositionPlan: spec.compositionPlan,
    scaffoldGraph: spec.scaffoldGraph, scaffoldPlan: spec.scaffoldCompositionPlan,
    moduleLock: null,
  });

  assert.ok(locked.includes("PUBLIC ABI — the whole platform surface"));
  assert.ok(locked.includes('From "./lib/app":'));
  assert.ok(locked.includes("useSession"), "coverage parity: the facade's exports are still named");
  assert.ok(locked.includes("repository"));
  assert.ok(locked.length < legacy.length,
    `the locked prompt is smaller (${locked.length} vs ${legacy.length})`);
});

test("WP14 — a defect implicating only platform files is a MODULE FAULT, never an application patch", () => {
  const runtime = classifyRepairOwnership({
    code: "undefined_identifier", tier: "scoped",
    modules: ["src/lib/modules/query.js"],
    evidence: { observed: "btoa is not defined" },
  });
  assert.equal(runtime.ownership, REPAIR_OWNERSHIP.MODULE_FAULT);
  assert.match(runtime.reason, /platform-owned/);

  // The composed facade and the composed capability modules are platform too.
  for (const path of [
    "src/lib/app/entities.js",
    "src/lib/capabilities/composed/routes.js",
    "src/lib/backend/supabaseBackend.js",
    "src/lib/scaffolds/composed/primitives.jsx",
  ]) {
    assert.equal(classifyRepairOwnership({ code: "x", tier: "scoped", modules: [path] }).ownership,
      REPAIR_OWNERSHIP.MODULE_FAULT, `${path} is platform-owned`);
    assert.ok(isProtectedPath(path.replace(/^src\//, "src/")), `${path} is also write-guarded`);
  }

  // Several platform files together are still one module fault.
  assert.equal(classifyRepairOwnership({
    code: "x", tier: "scoped", modules: ["src/lib/modules/query.js", "src/lib/app/entities.js"],
  }).ownership, REPAIR_OWNERSHIP.MODULE_FAULT);
});

test("WP14 — a defect that touches generated code keeps the application repair", () => {
  // The rule is "ALL implicated files are platform", not "any". A screen that misuses a module is
  // the screen's defect, and withholding the repair would leave a real fault unfixed.
  assert.equal(classifyRepairOwnership({
    code: "x", tier: "scoped", modules: ["src/lib/modules/query.js", "src/screens/Projects.jsx"],
  }).ownership, REPAIR_OWNERSHIP.GENERATED_APP);
  assert.equal(classifyRepairOwnership({
    code: "x", tier: "scoped", modules: ["src/screens/Projects.jsx"],
  }).ownership, REPAIR_OWNERSHIP.GENERATED_APP);
  // A defect with nothing implicated is not turned into a module fault by default.
  assert.equal(classifyRepairOwnership({ code: "x", tier: "scoped", modules: [] }).ownership,
    REPAIR_OWNERSHIP.GENERATED_APP);

  // The other owners still win where they applied before: a contract that cannot be executed is
  // not a module fault just because the evidence happens to name a module file.
  assert.equal(classifyRepairOwnership({
    code: "verification_evidence_contract_mismatch", defectClass: "contract",
    modules: ["src/lib/modules/query.js"],
  }).ownership, REPAIR_OWNERSHIP.CONTRACT_INVALID);
  assert.equal(classifyRepairOwnership({
    code: "x", owner: "platform", defectClass: "platform", modules: [],
    evidence: { observed: "ERR_MODULE_NOT_FOUND" },
  }).ownership, REPAIR_OWNERSHIP.PACKAGING_RUNTIME);
});

test("WP14 — the module-fault outcome is part of the declared vocabulary", () => {
  assert.equal(REPAIR_OWNERSHIP.MODULE_FAULT, "module_fault");
  const values = Object.values(REPAIR_OWNERSHIP);
  assert.equal(new Set(values).size, values.length, "every ownership value is distinct");
  assert.ok(values.includes("generated_app") && values.includes("undetermined"),
    "the outcomes that existed before are unchanged");
});

test("WP14 — a capability with no facade is still named, with the path it may be imported from", () => {
  // Found by the live qualification on 2026-09-20, not by any deterministic test. The brief
  // listed only src/lib/app facades while claiming to be the whole platform surface, and told the
  // model never to import from lib/capabilities. Contact has no facade and lives only there, so
  // the instruction was unfollowable: the model guessed makeContactForm, which the composed module
  // does not export, tried to patch the protected file to make the guess true, was refused by the
  // write guard, and the build blocked having spent 2.77 credits.
  const contract = {
    version: 2, summary: "landing page with a contact form", auth: { required: false },
    entities: [{ name: "contactMessage", fields: [
      { name: "id" }, { name: "name", type: "string", required: true },
      { name: "email", type: "email", required: true }, { name: "message", type: "text" },
    ] }],
    operations: [{ id: "submit-contact", kind: "create", entity: "contactMessage", responsibilities: [
      { type: "functional", capability: "contact", capabilityMethod: "submitContact",
        behavior: "record the enquiry", reads: ["name", "email", "message"], writes: [] },
    ] }],
    journeys: [{ id: "enquire", title: "Visitor sends an enquiry", steps: [
      { id: "e1", operates: ["submit-contact"], expect: "a confirmation is shown" },
    ] }],
  };
  const built = deriveBuildSpec(contract);
  const projection = projectPublicAbi({ moduleLock: built.moduleLock, compositionPlan: built.compositionPlan });

  // The composed contact module exports a pre-wired instance, NOT the registry's factory name.
  const composed = built.compositionPlan.interfaces.find((row) => row.module.endsWith("/composed/contact.js"));
  assert.ok(composed, "this contract composes a contact module");
  assert.deepEqual(composed.exports, ["contactCapability"]);
  assert.equal(composed.exports.includes("makeContactForm"), false,
    "the factory name is the registry's, never the composed module's export");

  // So the brief must name that export, and the exact path it comes from.
  assert.ok(projection.imports.includes("contactCapability"));
  assert.ok(projection.text.includes("src/lib/capabilities/composed/contact.js"));
  assert.equal(projection.text.includes("makeContactForm"), false,
    "the brief never offers a name nothing exports");

  // And it must not tell the model to avoid a path it has just been told to import from.
  assert.equal(/Never import from lib\/modules, lib\/capabilities/.test(projection.text), false);
  assert.ok(projection.text.includes("Import ONLY the names listed above, from the paths shown"));
  assert.deepEqual(abiProjectionParity(projection, built.compositionPlan), { ok: true, missing: [], leaked: [] });
});

test("WP14 — a composed module that a facade already covers stays private", () => {
  // The other half of the same rule, and the easy way to get it wrong. Naming every facade-less
  // composed module by filename re-exposed composed/crud.js, composed/session.js and
  // composed/roles.js, which are not facade-less at all: the entities, identity and accounts
  // facades absorbed them under different names. The brief would then have offered the private
  // plumbing on one line and called it private on the next. Coverage is a fact the composer
  // records when it assembles a facade, never a guess from a filename.
  const projection = projectPublicAbi({ moduleLock: spec.moduleLock, compositionPlan: spec.compositionPlan });
  const covered = ["crud", "session", "roles", "authorization", "admin"];
  for (const name of covered) {
    assert.equal(projection.text.includes(`composed/${name}.js`), false,
      `${name} is reachable through a facade, so the brief must not name its module`);
  }
  // Absorbed is not the same as absent: the facade still has to carry the capability's exports.
  assert.ok(projection.imports.includes("useSession"), "session, through the identity facade");
  assert.ok(projection.imports.includes("repository"), "crud, through the entities facade");
  assert.ok(projection.imports.includes("can"), "roles, through the accounts facade");

  // interaction-primitives genuinely has no facade, so it is named with its path.
  assert.ok(projection.composedModules.includes("src/lib/capabilities/composed/interaction-primitives.js"));
  assert.deepEqual(abiProjectionParity(projection, spec.compositionPlan), { ok: true, missing: [], leaked: [] });
});
