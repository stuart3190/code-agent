// A page crash in the smoke gate is the application's defect, so it is repairable, briefed with the
// real error and the files that contain it, and the platform no longer manufactures it.
//
// Root cause this pins (Downlight calculator, builds 2de59929 / 223c4772): the contract kept
// `layoutCalculation` as a transient, not-owned entity, so the composed `crud.js` carried
// `entityStores = {}` and `entityStore("layoutCalculation")` THREW while the screen module was being
// imported. The smoke saw a blank page, the crash was filed as tier NONE (no repair spent), and on
// resume the brief called it "not an application defect" and pointed repair at the journey's
// extension files, never at the Flow file that made the call.
//
// P0-1  fatal_runtime_crash is a repair-tier, application-owned defect.
// P0-2  the smoke keeps the stack; the brief names the file and line that hold the failing
//       identifier, calls the crash an application defect, and says when a prior attempt failed.
// P0-3  the composed entityStore() degrades to an in-memory store instead of throwing; a static
//       lint flags calls that can only reach that store; the generation brief says transient
//       entities have no store.
//
// Deterministic fixtures only. Nothing here launches a browser or spends a credit.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import {
  DEFECT_OWNER, REPAIR_TIER,
  actionableDefects, crashIdentifiers, crashSourceEvidence, defectEvidence, defectSignature,
  defectWriteBoundary, previousAttemptNotes, verificationDefects,
} from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import { governRepairRound, REPAIR_OWNERSHIP, classifyRepairOwnership }
  from "../../shell/server/lib/builderV2/repairGovernance.mjs";
import { browserRepairEvidence, changedTreePaths, targetedGateCorrection }
  from "../../shell/server/lib/builderV2/orchestrator.mjs";
import {
  lintUnresolvedEntityStoreCalls, runStaticApplicationGate,
} from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { SEVERITY, isBlocking, severityOf, assertSeverityTablesDisjoint }
  from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { transientStateBrief, transientStateEntities } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { describePageError } from "../../shell/server/lib/appBuild/smokeVerifier.mjs";
import {
  SMOKE_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

// The Downlight shape: one transient, not-owned entity, one read operation, no durable anything.
const TRANSIENT_CONTRACT = {
  summary: "client-only room layout calculator",
  entities: [{ name: "layoutCalculation", owned: false, storage: "transient", fields: [
    { name: "lights", type: "number" },
  ] }],
  operations: [{ id: "calculate-layout", entity: "layoutCalculation", kind: "read", journey: "calculate",
    output: { type: "transient_result" } }],
  routes: [{ path: "/", name: "Calculator" }], auth: { required: false },
  deferred: [], imageIntents: [], integrations: [],
  journeys: [{ id: "calculate", title: "Calculate a layout", priority: "primary", steps: [
    { action: "enter the room length", target: "length", operates: ["lights"], primitive: "textbox", expect: "the length is held" },
    { action: "calculate the layout", target: "calculate", operates: ["calculate-layout"], expect: "the layout is shown" },
    { action: "read the result", target: "result", expect: "the light count is visible" },
  ] }],
};

const FLOW = "src/components/calculate-layout/CalculateLayoutFlow.jsx";
const EXTENSION = "src/extensions/custom/calculate-layout.js";
const CRUD = "src/lib/capabilities/composed/crud.js";
const MANIFEST = "src/lib/scaffolds/composed/manifest.js";

// The line the model really wrote: module scope, so it executes while the screen is imported.
const FLOW_SOURCE = `import { entityStore } from "../../lib/capabilities/composed/crud.js";
const calculationStore = entityStore("layoutCalculation");
export default function CalculateLayoutFlow() {
  return <button onClick={() => calculationStore.create({ lights: 4 })}>Calculate</button>;
}
`;
const EXTENSION_SOURCE = `export function calculateLayout(input) { return { lights: Number(input.length) * 2 }; }\n`;

const spec = deriveBuildSpec(TRANSIENT_CONTRACT);
const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph);

function treeWith(files = {}) {
  return {
    ...composed.tree,
    "src/App.jsx": `import Flow from "./components/calculate-layout/CalculateLayoutFlow.jsx";\nexport default function App(){ return <Flow/>; }`,
    [FLOW]: FLOW_SOURCE,
    [EXTENSION]: EXTENSION_SOURCE,
    ...files,
  };
}

const CRASH_MESSAGE = "No composed entity store for layoutCalculation";
const CRASH_DETAIL = `fatal runtime error during load: ${CRASH_MESSAGE}`;
const STACK = [
  `at entityStore (http://127.0.0.1:5173/${CRUD}?t=1:20:11)`,
  `at http://127.0.0.1:5173/${FLOW}?t=1:2:26`,
];

/** A smoke verdict in the exact shape `smokeJourneysFn` returns: every contract journey the same. */
function smokeVerdicts({ withCrash = true, status = "fail",
  classification = VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE, detail = CRASH_DETAIL,
  ids = ["calculate", "calculate-again"] } = {}) {
  const crash = withCrash ? { phase: "load", control: null, message: CRASH_MESSAGE, stack: STACK,
    sourceFiles: [CRUD, FLOW] } : null;
  return {
    pass: false, verifierPolicy: SMOKE_VERIFIER_POLICY,
    journeys: ids.map((id) => ({
      id, status, classification, detail, steps: [], failedSteps: 1, verifiedBy: SMOKE_VERIFIER_POLICY,
      // What attribution hands the defect: the journey's extension files, never the Flow.
      owners: [EXTENSION], fallbackRefs: [],
      ...(crash ? { crash } : {}),
    })),
    fatalErrors: [detail], consoleErrors: [], failedRequests: [], advisories: [], verifierDefects: [],
    smoke: { crashes: crash ? [{ ...crash, error: detail }] : [] },
  };
}

const defectsFor = (verdicts, tree = treeWith()) => verificationDefects({
  contract: spec.contract, interactionContract: spec.interactionContract, journeyResults: verdicts, tree,
});

// ── P0-1 ──────────────────────────────────────────────────────────────────────────────────────

test("P0-1: a smoke fatal_runtime_crash is an application-owned, repair-tier, actionable defect", () => {
  const defects = defectsFor(smokeVerdicts());
  assert.equal(defects.length, 2, "one defect per contract journey, as the smoke stamps them");
  for (const defect of defects) {
    assert.equal(defect.code, "fatal_runtime_crash");
    assert.equal(defect.owner, DEFECT_OWNER.APP);
    assert.equal(defect.tier, REPAIR_TIER.REPAIR, "it used to be tier none, so repairUntilGreen spent nothing");
  }
  assert.equal(actionableDefects(defects).length, 2,
    "actionableDefects is what repairUntilGreen reads: empty meant stopReason no_actionable_defect");
});

test("P0-1: repair governance dispatches the crash to the generated application", () => {
  const defects = defectsFor(smokeVerdicts());
  const verdict = classifyRepairOwnership(defects[0], { tree: treeWith() });
  assert.equal(verdict.ownership, REPAIR_OWNERSHIP.GENERATED_APP);
  const round = governRepairRound({ tree: treeWith(), defects, strategy: "exact_owning_file_repair",
    boundary: defectWriteBoundary(defects) });
  assert.equal(round.dispatchable.length, 2, JSON.stringify(round.withheld));
  assert.deepEqual(round.withheld, []);
});

test("P0-1: an unreachable preview (platform verdict) stays non-repairable", () => {
  const defects = defectsFor(smokeVerdicts({ withCrash: false, status: "undriveable",
    classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE, detail: "preview unreachable: connect ECONNREFUSED" }));
  assert.ok(defects.length > 0);
  assert.ok(defects.every((defect) => defect.tier === REPAIR_TIER.NONE));
  assert.equal(actionableDefects(defects).length, 0);
});

test("P0-1: a crash with no page error (blank screen) is still repairable and carries no invented evidence", () => {
  const defects = defectsFor(smokeVerdicts({ withCrash: false, detail: "nothing rendered in the preview" }));
  assert.equal(defects[0].tier, REPAIR_TIER.REPAIR);
  assert.deepEqual(defects[0].evidence.crash?.tokens || [], []);
  assert.deepEqual(defects[0].modules, [EXTENSION], "journey owners remain the fallback when nothing names a file");
});

// ── P0-2 ──────────────────────────────────────────────────────────────────────────────────────

test("P0-2: the smoke verifier keeps the message, the first stack frames and the generated files they name", () => {
  const error = new Error(CRASH_MESSAGE);
  error.stack = [`Error: ${CRASH_MESSAGE}`, ...STACK.map((frame) => `    ${frame}`),
    "    at http://127.0.0.1:5173/@vite/client:1:1", "    at a", "    at b", "    at c"].join("\n");
  const described = describePageError(error);
  assert.equal(described.message, CRASH_MESSAGE);
  assert.equal(described.stack.length, 5, "bounded to five frames");
  assert.equal(described.stack[0], STACK[0]);
  assert.deepEqual(described.sourceFiles, [CRUD, FLOW]);
  assert.deepEqual(describePageError("boom"), { message: "boom", stack: [], sourceFiles: [] });
  assert.equal(describePageError(new Error("x".repeat(500))).message.length, 300);
});

test("P0-2: the file that holds the failing identifier leads the defect's modules, ahead of the journey owners", () => {
  const [defect] = defectsFor(smokeVerdicts());
  assert.equal(defect.modules[0], FLOW, JSON.stringify(defect.modules));
  assert.ok(defect.modules.includes(EXTENSION), "the journey owners stay in as the fallback");
  assert.ok(!defect.modules.some((file) => file.startsWith("src/lib/capabilities/")),
    "the protected composed store is context, never a repair target");
  assert.deepEqual(defect.evidence.crash.files, [FLOW]);
  assert.deepEqual(defect.evidence.crash.hits.map((hit) => [hit.path, hit.line, hit.token]),
    [[FLOW, 2, "layoutCalculation"]]);
});

test("P0-2: with no stack, the tree is searched for the identifier named by the message", () => {
  const verdicts = smokeVerdicts();
  for (const journey of verdicts.journeys) journey.crash = { phase: "load", message: CRASH_MESSAGE, stack: [], sourceFiles: [] };
  const [defect] = defectsFor(verdicts);
  assert.equal(defect.modules[0], FLOW);
  // Only the journey's detail string exists on a retained verdict from before the smoke kept stacks.
  const legacy = smokeVerdicts({ withCrash: false });
  const [fromDetail] = defectsFor(legacy);
  assert.equal(fromDetail.modules[0], FLOW, "the identifier is recovered from the detail text alone");
});

test("P0-2: the crash brief says application defect, names the error, stack and file:line, and shows the remedy", () => {
  const lines = defectEvidence(defectsFor(smokeVerdicts()));
  const prose = lines.filter((line) => !line.trim().startsWith("{"));
  assert.equal(prose.length, 1, "one narrative for the crash the smoke stamped on both journeys");
  const brief = prose[0];
  assert.match(brief, /this is an application defect/);
  assert.match(brief, /No composed entity store for layoutCalculation/);
  assert.match(brief, new RegExp(`${FLOW.replace(/[./]/g, "\\$&")}:2`));
  assert.match(brief, /Stack: at entityStore/);
  assert.match(brief, /journeys calculate, calculate-again/);
  assert.match(brief, /useState/, "an entityStore crash is told its remedy");
  assert.doesNotMatch(brief, /not an application defect/);
  assert.doesNotMatch(brief, /\b(?:not[_ ]reached|skipped)\b/i,
    "isDownstreamFailureEvidence would drop the sentence from the model's brief");
  const rows = lines.filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "interaction_verification_failure");
  assert.equal(rows[0].repairTier, "repair");
  assert.equal(rows[0].runtimeCrash.message, CRASH_MESSAGE);
  assert.ok(rows[0].stateOwners.includes(FLOW), "repair scoping reads the structured owners");
});

test("P0-2: the write boundary of the first strategy includes the throwing file, ordered first", () => {
  const boundary = defectWriteBoundary(defectsFor(smokeVerdicts()));
  assert.equal(boundary.allowedFiles[0], FLOW);
  assert.ok(boundary.allowedFiles.includes(EXTENSION));
  // A long owner list cannot sort the one file that has to change out of the bounded boundary.
  const owners = Array.from({ length: 20 }, (_, index) => `src/extensions/custom/a-${String(index).padStart(2, "0")}.js`);
  const crowded = smokeVerdicts();
  for (const journey of crowded.journeys) journey.owners = owners;
  const wide = defectWriteBoundary(defectsFor(crowded, treeWith(Object.fromEntries(owners.map((file) => [file, "export {};"])))));
  assert.equal(wide.allowedFiles[0], FLOW);
  assert.ok(wide.allowedFiles.length <= 12);
});

test("P0-2: the context line for an app-owned defect with no repair tier no longer says 'not an application defect'", () => {
  const lines = defectEvidence([{
    code: "fatal_runtime_crash", owner: DEFECT_OWNER.APP, tier: REPAIR_TIER.NONE, journeyId: "calculate",
    modules: [FLOW], evidence: { observed: CRASH_DETAIL },
  }, {
    code: "journey_verifier_unavailable", owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
    journeyId: null, modules: [], evidence: { observed: "the browser verifier was unavailable" },
  }]);
  const context = lines.filter((line) => line.startsWith("context ("));
  assert.match(context[0], /^context \(application-owned defect, fix the cause\) fatal_runtime_crash/);
  assert.match(context[0], new RegExp(`bounded fallback files: ${FLOW.replace(/[./]/g, "\\$&")}`));
  assert.match(context[1], /^context \(platform-owned, not an application defect\)/);
});

test("P0-2: browserRepairEvidence (the resume path and the in-build loop) carries the same crash brief", () => {
  const lines = browserRepairEvidence({
    contract: spec.contract, interactionContract: spec.interactionContract,
    journeyResults: smokeVerdicts(), tree: treeWith(),
  });
  assert.ok(lines.some((line) => /application crash \(this is an application defect/.test(line)));
  assert.ok(lines.some((line) => line.includes(`${FLOW}:2`)));
});

test("P0-2: crashIdentifiers pulls specific identifiers, never error class names or generic words", () => {
  assert.deepEqual(crashIdentifiers(CRASH_MESSAGE), ["layoutCalculation"]);
  assert.deepEqual(crashIdentifiers("TypeError: reset is not a function"), ["reset"]);
  assert.deepEqual(crashIdentifiers("Cannot read properties of undefined (reading 'rooms')"), ["rooms"]);
  assert.deepEqual(crashIdentifiers("boot failed before render"), []);
  assert.ok(!crashIdentifiers("Uncaught TypeError: undefined is not iterable").includes("TypeError"));
});

test("P0-2: a token found everywhere names a habit, not a cause, and is not searched for", () => {
  const tree = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`src/components/c${index}.jsx`,
    "export default () => items.map((item) => item);"]));
  const found = crashSourceEvidence(tree, { message: "Cannot read properties of undefined (reading 'items')" });
  assert.deepEqual(found.files, []);
  const specific = crashSourceEvidence({ ...tree, "src/components/c3.jsx": "const roomPlan = undefined; roomPlan.rows;" },
    { message: "Cannot read properties of undefined (reading 'roomPlan')" });
  assert.deepEqual(specific.files, ["src/components/c3.jsx"]);
});

test("P0-2: a distinctive identifier outranks a plain word that happens to share a file", () => {
  const tree = {
    "src/components/ui/dialog.jsx": "export const open = true;",
    "src/routes/Marketing.jsx": "const seatPlannerStore = {}; seatPlannerStore.open();",
  };
  const found = crashSourceEvidence(tree, { message: "seatPlannerStore.open is not a function" });
  assert.deepEqual(found.files, ["src/routes/Marketing.jsx"]);
  assert.deepEqual(found.hits.map((hit) => hit.token), ["seatPlannerStore"]);
  // With no distinctive token the plain word is used rather than nothing.
  assert.deepEqual(crashSourceEvidence(tree, { message: "x.open is not a function" }).files,
    ["src/components/ui/dialog.jsx", "src/routes/Marketing.jsx"]);
});

test("P0-2: 'previous attempt did not fix it' appears only once a round left the same defect in place", () => {
  const defects = defectsFor(smokeVerdicts());
  const signatures = defects.map(defectSignature);
  assert.deepEqual(previousAttemptNotes({ attempts: [], defects, tree: treeWith() }), []);

  const attempts = [{ round: 1, strategy: "exact_owning_file_repair", changedFiles: [EXTENSION], persisted: signatures }];
  const [note] = previousAttemptNotes({ attempts, defects, tree: treeWith() });
  assert.match(note, /^PREVIOUS ATTEMPT DID NOT FIX THIS: round 1 \[exact_owning_file_repair\]/);
  assert.match(note, new RegExp(`changed \\[${EXTENSION.replace(/[./]/g, "\\$&")}\\]`));
  assert.match(note, new RegExp(`The cause is still present at ${FLOW.replace(/[./]/g, "\\$&")}:2`));
  assert.match(note, new RegExp(`never modified \\[${FLOW.replace(/[./]/g, "\\$&")}\\]`));
  assert.doesNotMatch(note, /\b(?:not[_ ]reached|skipped)\b/i);

  // The round that did touch the cause file is not told it ignored it.
  const touched = previousAttemptNotes({ attempts: [{ ...attempts[0], changedFiles: [FLOW] }], defects, tree: treeWith() });
  assert.doesNotMatch(touched[0], /never modified/);
  // A defect that no longer exists produces no note.
  assert.deepEqual(previousAttemptNotes({ attempts, defects: [], tree: treeWith() }), []);
  assert.deepEqual(changedTreePaths({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" }), ["b", "c"]);
});

// ── P0-3 (a): the composed store ──────────────────────────────────────────────────────────────

test("P0-3a: the platform composes no store for a transient entity — the premise of the crash", () => {
  const source = composed.tree[CRUD];
  assert.match(source, /export const entityStores = Object\.freeze\(\{\s*\}\);/);
  assert.doesNotMatch(source, /throw new Error\(`No composed entity store/,
    "entityStore() no longer throws for an entity it has no composed store for");
  assert.deepEqual(transientStateEntities(TRANSIENT_CONTRACT), ["layoutCalculation"]);
});

/** Load the composed crud.js (and a generated module that imports it) the way the browser would. */
async function loadComposed(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composed-crud-"));
  const write = async (relative, content) => {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  await write("package.json", JSON.stringify({ type: "module" }));
  // The real ../crud.js imports the Supabase backend; the composed store only calls it for composed entities.
  await write("src/lib/capabilities/crud.js", "export const makeEntityStore = (type) => ({ durable: true, type });\n");
  await write(CRUD, composed.tree[CRUD]);
  for (const [file, content] of Object.entries(files || {})) await write(file, content);
  return { dir, url: (relative) => pathToFileURL(path.join(dir, relative)).href };
}

test("P0-3a regression: a generated module calling entityStore('layoutCalculation') for a non-owned entity no longer crashes at load", async () => {
  // JSX cannot be imported by Node; the statement that threw is the module-scope call, so keep it verbatim.
  const { dir, url } = await loadComposed({
    "src/components/flow.js": `import { entityStore } from "../lib/capabilities/composed/crud.js";
export const calculationStore = entityStore("layoutCalculation");
export async function calculate() { return calculationStore.create({ lights: 6 }); }
`,
  });
  try {
    const flow = await import(url("src/components/flow.js"));
    assert.ok(flow.calculationStore, "module evaluation completed instead of throwing");
    const row = await flow.calculate();
    assert.equal(row.lights, 6);
    assert.ok(row.id && row.createdAt);
    assert.equal(await flow.calculationStore.count(), 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("P0-3a: the in-memory fallback honours the store surface and is per-entity and per-page-load", async () => {
  const { dir, url } = await loadComposed();
  try {
    const { entityStore, entityStores } = await import(url(CRUD));
    assert.deepEqual(Object.keys(entityStores), [], "nothing was composed");
    const rooms = entityStore("rooms");
    assert.equal(entityStore("rooms"), rooms, "the same entity resolves to the same store");
    assert.notEqual(entityStore("other"), rooms);

    const seen = [];
    const unsubscribe = rooms.subscribe((event) => seen.push(event.eventType));
    const a = await rooms.create({ name: "kitchen", area: 12 });
    const b = await rooms.create({ name: "hall", area: 5 });
    assert.deepEqual((await rooms.list()).map((row) => row.name), ["hall", "kitchen"], "newest first like the backend");
    assert.deepEqual((await rooms.list({ ascending: true })).map((row) => row.name), ["kitchen", "hall"]);
    assert.deepEqual((await rooms.list({ filters: { name: "hall" } })).map((row) => row.id), [b.id]);
    assert.equal(await rooms.count({ area: 12 }), 1);
    assert.equal((await rooms.get(a.id)).name, "kitchen");
    const updated = await rooms.update(a.id, { area: 14 });
    assert.deepEqual([updated.name, updated.area], ["kitchen", 14], "update merges, as the real store does");
    await rooms.remove(b.id);
    assert.equal(await rooms.count(), 1);
    await assert.rejects(() => rooms.get(b.id), /No rooms record/);
    unsubscribe();
    await rooms.create({ name: "after" });
    assert.deepEqual(seen, ["INSERT", "INSERT", "UPDATE", "DELETE"], "unsubscribe stops events");
    assert.equal(await entityStore("other").count(), 0, "stores do not share rows");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("P0-3a: an entity the capability graph did compose keeps its durable store", async () => {
  const durable = deriveBuildSpec({
    ...TRANSIENT_CONTRACT,
    entities: [...TRANSIENT_CONTRACT.entities, { name: "project", fields: [{ name: "name", type: "string" }] }],
    operations: [...TRANSIENT_CONTRACT.operations,
      { id: "create-project", entity: "project", kind: "create", journey: "calculate" }],
  });
  const tree = composeCapabilityFoundation(REACT_VITE, durable.capabilityGraph).tree;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composed-crud-"));
  try {
    await fs.mkdir(path.join(dir, "src/lib/capabilities/composed"), { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(dir, "src/lib/capabilities/crud.js"),
      "export const makeEntityStore = (type) => ({ durable: true, type });\n");
    await fs.writeFile(path.join(dir, CRUD), tree[CRUD]);
    const { entityStore, entityStores } = await import(pathToFileURL(path.join(dir, CRUD)).href);
    assert.deepEqual(Object.keys(entityStores), ["project"]);
    assert.deepEqual(entityStore("project"), { durable: true, type: "project" });
    assert.equal(entityStore("layoutCalculation").durable, undefined, "the transient one is still in-memory");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── P0-3 (b): the static lint ─────────────────────────────────────────────────────────────────

test("P0-3b: entityStore() for a contract entity with no composed store is advisory, with file and line", () => {
  const findings = lintUnresolvedEntityStoreCalls(treeWith(), TRANSIENT_CONTRACT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "entity_store_call_transient");
  assert.equal(findings[0].file, FLOW);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].entity, "layoutCalculation");
  assert.match(findings[0].message, /useState/);
  assert.equal(isBlocking(findings[0]), false);
});

test("P0-3b: entityStore() for a name the contract never declared is blocking", () => {
  const tree = treeWith({ [FLOW]: FLOW_SOURCE.replace("layoutCalculation", "layoutCalc") });
  const [finding] = lintUnresolvedEntityStoreCalls(tree, TRANSIENT_CONTRACT);
  assert.equal(finding.code, "entity_store_call_unresolved");
  assert.equal(finding.file, FLOW);
  assert.equal(isBlocking(finding), true);
  assert.equal(severityOf("entity_store_call_unresolved"), SEVERITY.BLOCKING);
  assert.equal(severityOf("entity_store_call_transient"), SEVERITY.ADVISORY);
  assert.equal(assertSeverityTablesDisjoint(), true);

  // A case slip on a composed durable entity would silently become a throwaway store: say so.
  const durable = deriveBuildSpec({
    ...TRANSIENT_CONTRACT,
    entities: [{ name: "project", fields: [{ name: "name", type: "string" }] }],
    operations: [{ id: "create-project", entity: "project", kind: "create", journey: "calculate" }],
  });
  const durableTree = {
    ...composeCapabilityFoundation(REACT_VITE, durable.capabilityGraph).tree,
    [FLOW]: FLOW_SOURCE.replace("layoutCalculation", "Project"),
  };
  const [slip] = lintUnresolvedEntityStoreCalls(durableTree, durable.contract);
  assert.equal(slip.code, "entity_store_call_unresolved");
  assert.match(slip.message, /did you mean "project"\?/);
});

test("P0-3b: composed entities, dynamic names, platform files and legacy trees are not flagged", () => {
  const durable = deriveBuildSpec({
    ...TRANSIENT_CONTRACT,
    entities: [{ name: "project", fields: [{ name: "name", type: "string" }] }],
    operations: [{ id: "create-project", entity: "project", kind: "create", journey: "calculate" }],
  });
  const tree = composeCapabilityFoundation(REACT_VITE, durable.capabilityGraph).tree;
  const ok = { ...tree, [FLOW]: FLOW_SOURCE.replace("layoutCalculation", "project") };
  assert.deepEqual(lintUnresolvedEntityStoreCalls(ok, durable.contract), []);
  const dynamic = { ...tree, [FLOW]: `import { entityStore } from "../../lib/capabilities/composed/crud.js";
export const s = (name) => entityStore(name);` };
  assert.deepEqual(lintUnresolvedEntityStoreCalls(dynamic, durable.contract), []);
  const { [CRUD]: _crud, ...legacy } = treeWith();
  assert.deepEqual(lintUnresolvedEntityStoreCalls(legacy, TRANSIENT_CONTRACT), [], "no composed crud module, no claim");
  // A string that merely looks like a call, in a comment, is not a call.
  assert.deepEqual(lintUnresolvedEntityStoreCalls(treeWith({
    [FLOW]: `// entityStore("ghost")\nexport default function F(){ return null; }`,
  }), TRANSIENT_CONTRACT), []);
});

test("P0-3b: the static application gate blocks a typo'd name before compile and teaches the exact correction", () => {
  const tree = treeWith({ [FLOW]: FLOW_SOURCE.replace("layoutCalculation", "layoutCalc"), [MANIFEST]: "export const manifest = {};" });
  const gate = runStaticApplicationGate(tree, { contract: spec.contract, journeys: spec.contract.journeys });
  assert.equal(gate.active, true);
  const blocking = gate.blocking.find((row) => row.code === "entity_store_call_unresolved");
  assert.ok(blocking, JSON.stringify({ blocking: gate.blocking, advisory: gate.advisory }));
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((check) => check.name === "entity_store_calls").ok, false);
  const correction = targetedGateCorrection(
    { layers: { d0d2: { failure: { kind: "static_application", findings: [blocking] }, problems: [] } } },
    tree, spec.contract, []);
  assert.deepEqual(correction?.allowedFiles, [FLOW]);
});

test("P0-3b regression: the exact Downlight call is advisory, not a block, and the page no longer dies", () => {
  const gate = runStaticApplicationGate(treeWith({ [MANIFEST]: "export const manifest = {};" }),
    { contract: spec.contract, journeys: spec.contract.journeys });
  assert.equal(gate.active, true);
  assert.equal(gate.blocking.some((row) => /entity_store_call/.test(row.code)), false,
    JSON.stringify(gate.blocking));
  const advisory = gate.advisory.find((row) => row.code === "entity_store_call_transient");
  assert.ok(advisory, "recorded and briefed so repair can move the value to component state");
  assert.equal(advisory.severity, "advisory");
  assert.equal(gate.checks.find((check) => check.name === "entity_store_calls").ok, true);
});

// ── P0-3 (c): the generation brief ────────────────────────────────────────────────────────────

test("P0-3c: the generation brief tells the model that transient entities have no store", () => {
  const line = transientStateBrief(TRANSIENT_CONTRACT);
  assert.match(line, /^TRANSIENT STATE: entities \[layoutCalculation\] have no platform store/);
  assert.match(line, /useState/);
  assert.match(line, /Do not call entityStore\(\), db\.entity\(\), repository\(\) or localStorage/);
  assert.match(line, /no durable persistence at all/, "an all-transient contract is told it needs no backend call");

  const prompt = renderPatchPrompt({
    step: "core", contract: spec.contract, tiers: spec.tiers, tree: REACT_VITE,
    journey: spec.contract.journeys[0], modulePlan: spec.modulePlan,
    moduleContracts: spec.moduleContracts, capabilityGraph: spec.capabilityGraph,
    compositionPlan: spec.compositionPlan,
  });
  assert.match(prompt, /PERSISTENCE OWNERSHIP CONTRACT: no durable journey in this scope\.\nTRANSIENT STATE: entities \[layoutCalculation\]/,
    "the section the model used to get nothing from now says what to do");
});

test("P0-3c: a contract with only durable entities gets no transient line, and a mixed one names only the transient ones", () => {
  const durableOnly = {
    ...TRANSIENT_CONTRACT,
    entities: [{ name: "project", fields: [{ name: "name", type: "string" }] }],
    operations: [{ id: "create-project", entity: "project", kind: "create", journey: "calculate" }],
  };
  assert.equal(transientStateBrief(durableOnly), null);
  const mixed = {
    ...TRANSIENT_CONTRACT,
    entities: [...TRANSIENT_CONTRACT.entities, ...durableOnly.entities],
    operations: [...TRANSIENT_CONTRACT.operations, ...durableOnly.operations],
  };
  const line = transientStateBrief(mixed);
  assert.match(line, /entities \[layoutCalculation\]/);
  assert.doesNotMatch(line, /project/);
  assert.doesNotMatch(line, /no durable persistence at all/);
});

// ── the orchestrated loop: a smoke crash now buys a repair, briefed with the file that throws ─────

import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";

const BOOKING_CONTRACT = {
  summary: "A booking workflow with durable confirmation",
  entities: [{ name: "booking", fields: [{ name: "guestName" }, { name: "eventDate" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create", journey: "booking" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "booking", title: "Complete a booking", priority: "primary", steps: [
    { action: "enter the guest name", target: "guestName", expect: "the name is held" },
    { action: "select an event date", target: "eventDate", expect: "the date becomes selected" },
    { action: "confirm the booking", target: "confirm booking", expect: "a confirmation reference appears" },
    { action: "reload the confirmed booking", target: "booking", expect: "the confirmed booking is recovered" },
  ] }],
};
const JOURNEY_OWNER = "src/routes/Booking.jsx";
const CULPRIT = "src/routes/Marketing.jsx"; // never a journey owner: only the error names it
const BOOKING_APP = {
  "src/data/store.js": `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "booking", steps: ["guestName", "eventDate", "confirm"] });`,
  [JOURNEY_OWNER]: `import { useSyncExternalStore } from "react";
import { bookings, wizard } from "../data/store.js";
export default function Booking() {
  const state = useSyncExternalStore(wizard.subscribe, wizard.getState);
  return <main>
    <label htmlFor="guestName">Guest Name</label>
    <input id="guestName" name="guestName" value={state.values.guestName || ""} onChange={(e) => { wizard.restore(); wizard.setValue("guestName", e.target.value); }} />
    <label htmlFor="eventDate">Event Date</label>
    <input id="eventDate" name="eventDate" value={state.values.eventDate || ""} onChange={(e) => wizard.select("eventDate", e.target.value)} />
    <button onClick={async () => wizard.confirm(await bookings.createBooking(state.values))}>Confirm booking</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up booking</button>
  </main>;
}`,
  [CULPRIT]: `const seatPlannerStore = {};
export default function Marketing() { const seatPlanner = seatPlannerStore.open(); return <aside>{seatPlanner}</aside>; }`,
  "src/screens/scaffold/BookingScreen.jsx": `import Booking from "../../routes/Booking.jsx";
export default function BookingScreen() { return <Booking />; }`,
};
const asPatches = (tree) => Object.entries(tree).map(([file, content]) => (
  Object.hasOwn(REACT_VITE, file) || file.startsWith("src/screens/scaffold/")
    ? { replaceFile: file, content } : { newFile: file, content }));

const SMOKE_MESSAGE = "seatPlannerStore.open is not a function";
const smokeCrash = () => ({
  pass: false, verifierPolicy: SMOKE_VERIFIER_POLICY, blockingErrors: [], consoleErrors: [], failedRequests: [],
  journeys: [{
    id: "booking", title: "Complete a booking", priority: "primary", status: "fail",
    classification: VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE, steps: [], failedSteps: 1,
    detail: `fatal runtime error during load: ${SMOKE_MESSAGE}`, owners: [JOURNEY_OWNER], fallbackRefs: [],
    crash: { phase: "load", control: null, message: SMOKE_MESSAGE, stack: [], sourceFiles: [] },
  }],
});
const smokePass = () => ({
  pass: true, verifierPolicy: SMOKE_VERIFIER_POLICY, blockingErrors: [], consoleErrors: [], failedRequests: [],
  journeys: [{ id: "booking", title: "Complete a booking", priority: "primary", status: "pass", steps: [] }],
});

function crashHarness({ browser, repair }) {
  const patchInputs = [];
  let calls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => BOOKING_CONTRACT,
    patchesFn: async (input) => {
      patchInputs.push(input);
      if (input.step === "repair" || input.originalStep === "repair") return repair(input, patchInputs);
      return asPatches(BOOKING_APP);
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: createSnapshotStore(), buildStore: memoryBuildStore(),
    baseTree: () => fromScaffold(REACT_VITE), baseline: REACT_VITE,
    compile: async () => ({ ok: true }),
    journeysFn: async () => browser(calls += 1),
    events: {}, log: () => {},
  });
  return { orchestrator, patchInputs };
}

test("loop: a smoke crash used to end the build with no repair; now repair runs, scoped to the file the error names", async () => {
  const h = crashHarness({
    browser: (call) => (call === 1 ? smokeCrash() : smokePass()),
    repair: (input) => {
      assert.ok(input.repairBoundary.allowedFiles.includes(CULPRIT), JSON.stringify(input.repairBoundary));
      return [{ replaceFile: CULPRIT, content: `export default function Marketing() { return <aside>ok</aside>; }` }];
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 2 });
  const repair = h.patchInputs.find((input) => input.step === "repair");
  assert.ok(repair, "a repair was dispatched (stopReason used to be no_actionable_defect)");
  assert.equal(repair.repairBoundary.allowedFiles[0], CULPRIT,
    "the file containing the failing identifier leads; the journey owner is only the fallback");
  assert.ok(repair.repairBoundary.allowedFiles.includes(JOURNEY_OWNER));
  const brief = repair.problems.filter((line) => !line.trim().startsWith("{")).join("\n");
  assert.match(brief, /this is an application defect/);
  assert.match(brief, new RegExp(`${CULPRIT.replace(/[./]/g, "\\$&")}:\\d+`));
  assert.doesNotMatch(brief, /not an application defect/);
  assert.equal(result.state, "green", JSON.stringify(result).slice(0, 400));
});

test("loop: when the same crash survives a round, the next brief says the previous attempt did not fix it", async () => {
  const h = crashHarness({
    browser: () => smokeCrash(),
    // A round that edits only the journey owner and leaves the throwing file alone, as the live resume did.
    repair: () => [{ replaceFile: JOURNEY_OWNER, content: `${BOOKING_APP[JOURNEY_OWNER]}\n// tweak` }],
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 3 });
  assert.equal(result.state, "blocked");
  const repairs = h.patchInputs.filter((input) => input.step === "repair");
  const notes = (input) => input.problems.filter((line) => line.startsWith("PREVIOUS ATTEMPT DID NOT FIX THIS"));
  assert.ok(repairs.length >= 2, `rounds: ${repairs.length}`);
  assert.deepEqual(notes(repairs[0]), [], "the first round has no earlier attempt to report");
  const [note] = notes(repairs.at(-1));
  assert.ok(note, "a later round is told what failed");
  assert.match(note, new RegExp(`changed \\[${JOURNEY_OWNER.replace(/[./]/g, "\\$&")}\\]`));
  assert.match(note, new RegExp(`never modified \\[${CULPRIT.replace(/[./]/g, "\\$&")}\\]`));
});
