import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { composeCapabilityFoundation } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import {
  composeScaffoldFoundation, scaffoldCompositionPlan, validateScaffoldComposition,
  SCAFFOLD_APP_PATH, SCAFFOLD_MANIFEST_PATH,
} from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { validateScaffoldGraph, scaffoldJourneyOwners } from "../../shell/server/lib/builderV2/scaffoldGraph.mjs";
import { SCAFFOLDS, validateScaffoldRegistry } from "../../shell/server/lib/builderV2/scaffoldRegistry.mjs";
import { runStaticApplicationGate } from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { routeScaffoldDefect, SCAFFOLD_REPAIR_CLASS }
  from "../../shell/server/lib/builderV2/scaffoldRepairRouting.mjs";
import { deriveVerificationManifest, browserPlan }
  from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { targetedGateCorrection } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const profile = (signals = [], subtype = "general_application") => ({
  version: 1, requestedBuildType: "application", resolvedBuildType: "application",
  applicationSubtype: subtype, requirementSignals: signals, inferenceSource: "explicit", confidence: 1,
});
const base = ({ summary, entities = [], operations = [], journeys, routes, buildProfile = null, auth = false }) => ({
  summary, entities, operations, journeys, routes, auth: { required: auth }, buildProfile,
  deferred: [], imageIntents: [], integrations: [],
});

const CONTENT = base({
  summary: "A responsive content catalogue with list and detail navigation",
  entities: [{ name: "article", fields: [{ name: "title", type: "string" }] }],
  operations: [
    { id: "list-articles", entity: "article", kind: "list", journey: "browse-content" },
    { id: "view-article", entity: "article", kind: "get", journey: "read-content" },
  ],
  journeys: [
    { id: "browse-content", title: "Browse content", priority: "primary", steps: [
      { action: "view the catalogue", target: "/", operates: ["list-articles"], expect: "articles are visible" },
      { action: "filter the catalogue", target: "search", primitive: "textbox", expect: "matching articles remain" },
    ] },
    { id: "read-content", title: "Read content detail", priority: "primary", steps: [
      { action: "open an article", target: "/detail", operates: ["view-article"], expect: "article detail is visible" },
    ] },
  ],
  routes: [{ path: "/", name: "Catalogue" }, { path: "/detail", name: "Detail" }],
});

const BUSINESS = base({
  summary: "An authenticated internal dashboard for durable work records and workflow",
  buildProfile: profile(["user_accounts", "admin"], "internal_tool"), auth: true,
  entities: [{ name: "workItem", fields: [{ name: "title", type: "string" }, { name: "status", type: "string" }] }],
  operations: [
    { id: "create-work", entity: "workItem", kind: "create", journey: "manage-work" },
    { id: "update-work", entity: "workItem", kind: "update", journey: "manage-work" },
  ],
  journeys: [{ id: "manage-work", title: "Manage work workflow", priority: "primary", steps: [
    { action: "enter a title", target: "/dashboard", operates: ["title"], primitive: "textbox", expect: "the title is visible" },
    { action: "create the work item", target: "save", operates: ["create-work"], expect: "the work item is saved" },
    { action: "change its status", target: "status", operates: ["status", "update-work"], primitive: "selection", expect: "the new status is visible" },
  ] }, { id: "administer-work", title: "Administer work access", priority: "primary", steps: [
    { action: "open admin management", target: "/admin", expect: "authorized management is visible" },
  ] }], routes: [{ path: "/dashboard", name: "Dashboard" }, { path: "/admin", name: "Admin" }],
});

const TRANSACTION = base({
  summary: "A durable multi-step scheduling transaction with availability, review and confirmation",
  buildProfile: null,
  entities: [{ name: "booking", fields: [{ name: "slotId", type: "string" },
    { name: "partySize", type: "number" }, { name: "guestName", type: "string" },
    { name: "guestEmail", type: "string" }] }],
  operations: [{ id: "create-booking", entity: "booking", kind: "create", journey: "complete-transaction" }],
  journeys: [{ id: "complete-transaction", title: "Complete scheduled transaction", priority: "primary", steps: [
    { action: "select an available slot", target: "slot", operates: ["slotId"], primitive: "selection", expect: "the slot is selected" },
    { action: "continue to guest details", target: "continue", expect: "the details step opens" },
    { action: "enter guest details and party size", target: "details", operates: ["guestName", "guestEmail", "partySize"], primitive: "textbox", expect: "the details are visible" },
    { action: "review the booking", target: "review", expect: "the values are shown" },
    { action: "confirm the booking", target: "confirm", operates: ["create-booking"], expect: "the booking is confirmed" },
  ] }], routes: [{ path: "/", name: "Schedule" }],
});

const INTERACTIVE = base({
  summary: "An interactive project workspace with canvas manipulation, calculation, save/reopen and export",
  buildProfile: profile(["custom_logic", "interactive_workspace", "export"]),
  entities: [{ name: "project", fields: [
    { name: "width", type: "number" }, { name: "height", type: "number" },
    { name: "result", type: "number" }, { name: "position", type: "object" },
  ] }],
  operations: [
    { id: "calculate-result", entity: "project", kind: "calculate", journey: "edit-project",
      responsibilities: [{ type: "functional", behavior: "calculate a result from dimensions",
        reads: ["width", "height"], writes: ["result"] }] },
    { id: "move-object", entity: "project", kind: "transform", journey: "edit-project",
      responsibilities: [{ type: "functional", behavior: "transform an object position",
        reads: ["position"], writes: ["position"] }] },
    { id: "save-project", entity: "project", kind: "create", journey: "edit-project" },
  ],
  journeys: [{ id: "edit-project", title: "Edit and save project workspace", priority: "primary", steps: [
    { action: "enter width and height", target: "/workspace", operates: ["width", "height"], primitive: "textbox", expect: "the dimensions are visible" },
    { action: "calculate the result", target: "calculate", operates: ["calculate-result"], expect: "the result is visible" },
    { action: "move the selected object", target: "canvas", operates: ["move-object"], expect: "the object position changes" },
    { action: "save the project", target: "save", operates: ["save-project"], expect: "the project is saved" },
    { action: "reopen the project", target: "/workspace", expect: "the saved project is restored" },
    { action: "export the result", target: "export", expect: "the output is available" },
  ] }], routes: [{ path: "/projects", name: "Projects" }, { path: "/workspace", name: "Workspace" }],
});

const compose = (spec) => composeScaffoldFoundation(
  composeCapabilityFoundation(fromScaffold(REACT_VITE), spec.capabilityGraph).tree, spec.scaffoldGraph,
);
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

test("the registry is authoritative, machine-readable, generic and limited to implemented families", () => {
  const verdict = validateScaffoldRegistry();
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.deepEqual(Object.keys(SCAFFOLDS).sort(), [
    "admin_management", "app_shell", "auth_account", "canvas_editor", "catalogue_detail",
    "content_navigation", "crud_resource", "dashboard", "export_output", "project_workspace",
    "scheduling", "workflow",
  ]);
  assert.equal(Object.hasOwn(SCAFFOLDS, "booking_template"), false);
  assert.equal(Object.hasOwn(SCAFFOLDS, "crm_template"), false);
  for (const entry of Object.values(SCAFFOLDS)) {
    assert.equal(entry.status, "proven");
    assert.ok(entry.verificationContract && entry.deterministicTests.length);
    assert.ok(entry.extensionPoints.length || entry.scaffoldId === "app_shell");
  }
});

test("four structurally different contracts compose multiple families from semantics", () => {
  const specs = [CONTENT, BUSINESS, TRANSACTION, INTERACTIVE].map(deriveBuildSpec);
  for (const spec of specs) {
    assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
    assert.equal(validateScaffoldGraph(spec.scaffoldGraph, spec.contract, spec.capabilityGraph).ok, true);
    assert.ok(spec.scaffoldGraph.families.some((node) => node.scaffoldId === "app_shell"));
    assert.ok(spec.scaffoldGraph.journeyOwnership.every((row) => row.mountedModule && row.routePath));
  }
  const families = (spec) => new Set(spec.scaffoldGraph.families.map((node) => node.scaffoldId));
  assert.ok(families(specs[0]).has("catalogue_detail"));
  assert.ok(families(specs[0]).has("content_navigation"));
  assert.ok(families(specs[1]).has("dashboard") && families(specs[1]).has("auth_account"));
  assert.ok(families(specs[1]).has("admin_management"));
  assert.ok(families(specs[2]).has("workflow") && families(specs[2]).has("crud_resource"));
  const proven = new Set(specs.flatMap((spec) => spec.scaffoldGraph.families.map((node) => node.scaffoldId)));
  assert.deepEqual([...proven].sort(), Object.keys(SCAFFOLDS).sort(),
    "the four structural contracts exercise every registry family marked proven");
  assert.ok(families(specs[3]).has("project_workspace") && families(specs[3]).has("canvas_editor")
    && families(specs[3]).has("export_output"));
  assert.ok(specs[3].scaffoldGraph.extensions.length >= 1,
    "unsupported calculation stays a bounded extension instead of forcing whole-app generation");
});

test("composition deterministically mounts every screen and protects the live route authority", () => {
  const spec = deriveBuildSpec(CONTENT);
  const first = compose(spec); const second = compose(spec);
  assert.deepEqual(first.tree, second.tree);
  assert.equal(validateScaffoldComposition(first.tree, spec.scaffoldGraph, first.plan,
    { requireExtensions: false }).ok, true);
  for (const owner of spec.scaffoldGraph.journeyOwnership) {
    assert.ok(first.tree[owner.mountedModule]);
    assert.ok(first.tree[SCAFFOLD_APP_PATH].includes(owner.mountedModule.split("/").at(-1).replace(".jsx", "")));
    assert.ok(scaffoldJourneyOwners(spec.scaffoldGraph, owner.journeyId).includes(owner.mountedModule));
  }
  assert.match(first.tree["src/lib/scaffolds/composed/primitives.jsx"], /useWorkflowState/);
  assert.match(first.tree["src/lib/scaffolds/composed/primitives.jsx"], /useResourceState/);
  assert.match(first.tree["src/lib/scaffolds/composed/primitives.jsx"], /useProjectWorkspace/);
  const screen = spec.scaffoldGraph.screens[0];
  const implemented = applyPatches(first.tree, [{ file: screen.module, ops: [{
    op: "replace_symbol", symbol: screen.module.split("/").at(-1).replace(".jsx", ""),
    content: "export default function HomeScreen(){ return <main>Implemented live screen</main>; }",
  }] }], { contract: spec.contract });
  const screenJourneys = spec.scaffoldGraph.routes.find((route) => route.screenId === screen.screenId)?.journeyIds || [];
  assert.equal(validateScaffoldComposition(implemented.tree, spec.scaffoldGraph, first.plan,
    { requireExtensions: false, rejectScreenSlots: true, journeyIds: screenJourneys }).ok, true,
  "preserving the screen-slot provenance comment must not make an implemented body look empty");
  const attempt = applyPatches(first.tree, [{ replaceFile: "src/App.jsx",
    content: "export default function App(){ return null; }" }], { contract: spec.contract });
  assert.equal(attempt.applied.length, 0);
  assert.equal(attempt.rejected[0].code, "write_scope_violation");
});

test("an unmounted journey module and an undeclared repair identifier are rejected before browser", () => {
  const spec = deriveBuildSpec(CONTENT); const { tree } = compose(spec);
  let gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.equal(gate.ok, false);
  assert.ok(gate.blocking.some((finding) => finding.code === "scaffold_composition_invalid"
    && /still unimplemented/.test(finding.message)),
  "creating an alternative component cannot satisfy a journey while its mounted screen remains a placeholder");

  for (const screen of spec.scaffoldGraph.screens) {
    tree[screen.module] = `export default function Screen(){ return <section>${screen.routeName}</section>; }`;
  }
  const dead = "src/components/browse-content/UnreachableScreen.jsx";
  tree[dead] = "export default function UnreachableScreen(){ return <div>Dead</div>; }";
  const modulePlan = [...spec.modulePlan, { path: dead, role: "journey screen", journeyIds: ["browse-content"] }];
  gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.equal(gate.ok, false);
  const unreachable = gate.blocking.find((finding) => finding.code === "journey_surface_unreachable"
    && finding.file === dead);
  assert.ok(unreachable);
  const mountedOwner = spec.scaffoldGraph.journeyOwnership
    .find((owner) => owner.journeyId === "browse-content").mountedModule;
  assert.deepEqual(unreachable.journeyIds, ["browse-content"]);
  assert.deepEqual(unreachable.mountedModules, [mountedOwner]);
  const correction = targetedGateCorrection({ layers: { d0d2: {
    failure: { kind: "static_application", findings: [unreachable] },
    problems: [unreachable.message],
  } } }, tree, spec.contract);
  assert.deepEqual(correction.allowedFiles, [dead, mountedOwner].sort());
  assert.match(correction.instruction, /owning mounted screen/);

  delete tree[dead];
  const owner = spec.scaffoldGraph.journeyOwnership[0].mountedModule;
  tree[owner] = "export default function Screen(){ return <div>{reservation ? 'yes' : 'no'}</div>; }";
  gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.ok(gate.blocking.some((finding) => finding.code === "undefined_identifier"
    && finding.identifier === "reservation"));

  tree[owner] = `function OtherScope(){ const reservation = { id: "hidden" }; return reservation.id; }
export default function Screen(){ return <div>{reservation.id}</div>; }`;
  gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.ok(gate.blocking.some((finding) => finding.code === "undefined_identifier"
    && finding.identifier === "reservation"), "a binding in another lexical scope cannot mask an undefined reference");

  tree[owner] = `import Missing from "./does-not-exist.jsx";
export default function Screen(){ return <Missing/>; }`;
  gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.ok(gate.blocking.some((finding) => finding.code === "unresolved_import"),
    "relative imports must resolve before browser verification");
});

test("a broken custom extension cannot poison the deterministic foundation", () => {
  const spec = deriveBuildSpec(INTERACTIVE); const { tree, plan } = compose(spec);
  const before = Object.fromEntries(plan.protectedFiles.map((path) => [path, hash(tree[path])]));
  for (const screen of spec.scaffoldGraph.screens) {
    tree[screen.module] = `export default function Screen(){ return <section>${screen.routeName}</section>; }`;
  }
  const extension = spec.scaffoldGraph.extensions[0];
  tree[extension.module] = "export const broken = true;";
  const invalid = validateScaffoldComposition(tree, spec.scaffoldGraph, plan, { requireExtensions: true });
  assert.equal(invalid.ok, false);
  assert.match(invalid.problems.join(" "), /must export/);
  assert.deepEqual(Object.fromEntries(plan.protectedFiles.map((path) => [path, hash(tree[path])])), before);
});

test("scaffold-aware repair targets mounted/config/custom seams and never protected internals", () => {
  const spec = deriveBuildSpec(INTERACTIVE);
  const owner = spec.scaffoldGraph.journeyOwnership[0];
  const unreachable = routeScaffoldDefect({ journeyId: owner.journeyId,
    modules: ["src/components/DeadFlow.jsx"], failureRefs: [],
    evidence: { surfaceIntegration: { unreachableJourneyModules: ["src/components/DeadFlow.jsx"] } } },
  spec.scaffoldGraph);
  assert.equal(unreachable.classification, SCAFFOLD_REPAIR_CLASS.UNREACHABLE);
  assert.ok(unreachable.targetFiles.includes(owner.mountedModule));
  const internal = routeScaffoldDefect({ journeyId: owner.journeyId,
    modules: [SCAFFOLD_APP_PATH] }, spec.scaffoldGraph);
  assert.equal(internal.classification, SCAFFOLD_REPAIR_CLASS.INTERNAL);
  assert.equal(internal.repairableByModel, false);
  const extension = spec.scaffoldGraph.extensions[0];
  const custom = routeScaffoldDefect({ journeyId: owner.journeyId, modules: [extension.module] }, spec.scaffoldGraph);
  assert.equal(custom.classification, SCAFFOLD_REPAIR_CLASS.CUSTOM_EXTENSION);
  assert.deepEqual(custom.targetFiles, extension.allowedFiles);
  const mountedFlow = "src/screens/scaffold/EnterDemoCompetitionFlow.jsx";
  const control = routeScaffoldDefect({
    journeyId: owner.journeyId,
    code: "contracted_control_undriveable",
    defectClass: "interaction",
    control: { logicalField: "competitionId" },
    modules: [extension.module, mountedFlow, owner.mountedModule],
    failureRefs: [extension.module, mountedFlow, owner.mountedModule],
  }, spec.scaffoldGraph);
  assert.equal(control.classification, SCAFFOLD_REPAIR_CLASS.UI_COMPOSITION,
    "a custom calculation helper cannot steal an undriveable control from its mounted UI owner");
  assert.ok(control.targetFiles.includes(owner.mountedModule));
  assert.ok(control.targetFiles.includes(mountedFlow));
  assert.ok(!control.targetFiles.includes(extension.module));
  const configuration = routeScaffoldDefect({ journeyId: owner.journeyId,
    modules: ["src/extensions/capabilityConfiguration.js"] }, spec.scaffoldGraph);
  assert.equal(configuration.classification, SCAFFOLD_REPAIR_CLASS.INTEGRATION);
  assert.deepEqual(configuration.targetFiles,
    ["src/extensions/capabilityConfiguration.js", owner.mountedModule]);

  const composed = compose(spec);
  const capabilityPath = Object.keys(composed.tree).find((path) => /^src\/lib\/capabilities\/.+\.js$/.test(path));
  assert.ok(capabilityPath, "the capability composer contributes protected platform modules");
  const capabilityRewrite = applyPatches(composed.tree, [{ replaceFile: capabilityPath,
    content: "export const bypass = true;" }], { contract: spec.contract });
  assert.equal(capabilityRewrite.applied.length, 0,
    "existing capability ownership remains protected alongside the scaffold foundation");
  assert.equal(capabilityRewrite.rejected[0].code, "write_scope_violation");
});

test("generation and verifier consume the same mounted scaffold authority while design remains free", () => {
  const spec = deriveBuildSpec(CONTENT); const { tree } = compose(spec);
  const prompt = renderPatchPrompt({ step: "core", contract: spec.contract, tiers: spec.tiers,
    tree, journey: null, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
    capabilityGraph: spec.capabilityGraph, scaffoldGraph: spec.scaffoldGraph,
    scaffoldPlan: spec.scaffoldCompositionPlan });
  assert.match(prompt, /DETERMINISTIC SCAFFOLD COMPOSITION/);
  assert.match(prompt, /PROVIDED, MOUNTED, MODEL-OWNED screen slot/);
  assert.match(prompt, /styling, layout, typography and component composition original/);
  assert.doesNotMatch(prompt, /registered in src\/App\.jsx/);
  const manifest = deriveVerificationManifest(spec);
  assert.equal(manifest.scaffoldGraphVersion, spec.scaffoldGraph.version);
  assert.equal(manifest.scaffoldAssertions.length, spec.contract.journeys.length);
  assert.ok(browserPlan(manifest).scaffoldAssertions.every((row) => row.mounted && row.routePath));
});

test("module proportionality is contract-derived and extreme free-form expansion is flagged", () => {
  const spec = deriveBuildSpec(CONTENT); const { tree } = compose(spec);
  for (const screen of spec.scaffoldGraph.screens) tree[screen.module] = "export default function Screen(){ return <div>Ready</div>; }";
  const maximum = spec.scaffoldGraph.expectedModuleSurface.extremeMaximum;
  for (let index = 0; index < maximum + 3; index += 1) {
    tree[`src/components/free-form/Part${index}.jsx`] = `export default function Part${index}(){ return <div>${index}</div>; }`;
  }
  const gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.equal(gate.ok, true, `proportionality is evidence, not a crude universal file-count failure: ${JSON.stringify(gate.blocking)}`);
  assert.ok(gate.advisory.some((finding) => finding.code === "structural_expansion_exceeded"));
});

test("retained 46-file failure shapes are stopped at their first deterministic cause", () => {
  const spec = deriveBuildSpec(TRANSACTION); const { tree } = compose(spec);
  for (const screen of spec.scaffoldGraph.screens) {
    tree[screen.module] = `export default function TransactionScreen(){
      const [draft] = React.useState({ amount: 10 });
      return <section>{reservation ? reservation.reference : draft.amount}</section>;
    }`;
  }
  const gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
    journeys: spec.journeys, requireExtensions: false });
  assert.equal(gate.ok, false);
  assert.ok(gate.blocking.some((finding) => finding.identifier === "React"));
  assert.ok(gate.blocking.some((finding) => finding.identifier === "reservation"));
  assert.equal(typeof tree[SCAFFOLD_MANIFEST_PATH], "string", "the verified foundation remains retained");
});
