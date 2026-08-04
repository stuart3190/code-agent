// PR5 — generation happens in stages, each ending in a green checkpoint.
//
// The whole project used to be written in one turn, with `npm run build` as the first validation of
// any kind. A fault in the foundation was discovered only once 27 files rested on it, and the
// checkpoints the system recorded were never restored from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runStagedBuild, primaryStageOk, stagesSummary } from "../../shell/server/lib/appBuild/stagedBuild.mjs";
import { planStages, stagePrompt, STAGE_DEFINITIONS } from "../../shell/server/lib/appBuild/stagePlan.mjs";
import { validateBuildConfig, runStageGate, gateSummary } from "../../shell/server/lib/appBuild/stageGate.mjs";
import { STAGES } from "../../shell/shared/implementationContract.mjs";

const CONTRACT = {
  summary: "A farm booking site",
  projectType: "booking",
  routes: [{ path: "/", name: "Home", purpose: "seasonal status", auth: false },
    { path: "/book", name: "Book", purpose: "the reservation journey", auth: false }],
  journeys: [
    {
      id: "book", title: "A visitor books a slot", priority: "primary", stage: "primary_journey",
      steps: [
        { action: "open /book", expect: "the slot list is visible" },
        { action: "submit details", expect: "a confirmation reference is shown" },
      ],
    },
    {
      id: "manage", title: "The owner cancels a booking", priority: "secondary", stage: "supporting",
      steps: [
        { action: "sign in", expect: "the bookings list is displayed" },
        { action: "cancel one", expect: "it stays gone after a reload" },
      ],
    },
  ],
  entities: [{ name: "booking", owned: true, fields: [{ name: "slotId", type: "string", required: true }], relationships: [] }],
  auth: { required: true, model: "email + password", rules: ["a visitor cannot read another's booking"] },
  operations: [{ id: "create-booking", entity: "booking", kind: "create", description: "persist via db.entity('booking').create" }],
  states: [{ surface: "booking", loading: "skeleton", empty: "no slots", validation: "email must be valid", error: "try again", success: "reference shown" }],
  acceptance: [], deferred: [{ item: "card payment", reason: "paid on arrival" }],
};

const SCAFFOLD = {
  "package.json": JSON.stringify({ name: "a", type: "module", scripts: { build: "vite build" } }),
  "index.html": '<!doctype html><div id="root"></div>',
  "vite.config.js": "export default {}",
  "src/main.jsx": "export default 1;",
  "src/lib/backend/index.js": "export const db = {};",
};

// ── the plan ──────────────────────────────────────────────────────────────────────────────────

test("stages are planned from the contract, in order", () => {
  const plan = planStages(CONTRACT);
  assert.deepEqual(plan.map((s) => s.id), ["foundation", "data", "primary_journey", "supporting", "polish"]);
  assert.deepEqual(plan.find((s) => s.id === "primary_journey").journeys.map((j) => j.id), ["book"]);
  assert.deepEqual(plan.find((s) => s.id === "supporting").journeys.map((j) => j.id), ["manage"]);
  assert.deepEqual(plan.find((s) => s.id === "data").entities.map((e) => e.name), ["booking"]);
  for (const stage of plan) assert.ok(STAGES.includes(stage.id));
});

test("a stage with nothing to do is skipped rather than spending a model call", () => {
  const landing = {
    summary: "A one-page site", journeys: [{
      id: "read", title: "A visitor reads the page", priority: "primary", stage: "foundation",
      steps: [{ action: "open /", expect: "the hero is visible" }, { action: "scroll", expect: "the footer is visible" }],
    }],
    entities: [], auth: { required: false }, routes: [{ path: "/", name: "Home" }],
    operations: [], states: [], acceptance: [], deferred: [],
  };
  const plan = planStages(landing);
  assert.deepEqual(plan.map((s) => s.id), ["foundation", "polish"], "no data stage without entities or auth");
});

test("each stage prompt carries only its own slice of the contract", () => {
  const plan = planStages(CONTRACT);
  const byId = Object.fromEntries(plan.map((s) => [s.id, s]));
  const request = "build a farm booking site";

  const foundation = stagePrompt(byId.foundation, CONTRACT, { request });
  assert.match(foundation, /STAGE FOUNDATION/);
  assert.match(foundation, /ROUTES THIS STAGE MUST RENDER/);
  assert.match(foundation, /\/book — Book/);
  // The foundation must not be handed the journey it is not building.
  assert.ok(!/a confirmation reference is shown/.test(foundation),
    "a stage shown the whole contract builds the whole contract");
  assert.match(foundation, /no button may be present that has no handler/);

  const data = stagePrompt(byId.data, CONTRACT, { request });
  assert.match(data, /ENTITIES THIS STAGE MUST IMPLEMENT/);
  assert.match(data, /booking — rows belong to the signed-in user/);
  assert.match(data, /slotId:string \(required\)/);
  assert.match(data, /db\.entity\('booking'\)\.create/);
  assert.match(data, /No component may hold records in useState as its source of truth/);

  const primary = stagePrompt(byId.primary_journey, CONTRACT, { request });
  assert.match(primary, /JOURNEY — A visitor books a slot \(PRIMARY\)/);
  assert.match(primary, /a confirmation reference is shown/);
  assert.match(primary, /readable after a full page reload/);

  // Deferred work is named in every stage, because any stage could fake it.
  for (const stage of plan) {
    assert.match(stagePrompt(stage, CONTRACT, { request }), /card payment \(paid on arrival\)/);
  }
});

// ── the gate ──────────────────────────────────────────────────────────────────────────────────

test("build configuration problems are named precisely, not left to the compiler", () => {
  assert.equal(validateBuildConfig(SCAFFOLD).ok, true);

  const noConfig = { ...SCAFFOLD };
  delete noConfig["vite.config.js"];
  assert.match(validateBuildConfig(noConfig).problems[0], /vite\.config\.js is missing/);

  const badJson = { ...SCAFFOLD, "package.json": "{ nope" };
  assert.match(validateBuildConfig(badJson).problems[0], /not valid JSON/);

  const noScript = { ...SCAFFOLD, "package.json": JSON.stringify({ name: "a", type: "module", scripts: {} }) };
  assert.match(validateBuildConfig(noScript).problems[0], /no build script/);

  const noRoot = { ...SCAFFOLD, "index.html": "<!doctype html><div id=app></div>" };
  assert.match(validateBuildConfig(noRoot).problems[0], /#root mount point/);

  // The backend SDK is infrastructure. Rewriting it is how "persisted" becomes "persisted
  // somewhere else" without anything noticing.
  const editedSdk = { ...SCAFFOLD, "src/lib/backend/index.js": "export const db = { fake: true };" };
  assert.match(validateBuildConfig(editedSdk, { baseline: SCAFFOLD }).problems[0], /backend SDK must not be edited/);
});

test("the gate stops at the first failure, cheapest check first", async () => {
  let compiled = false;
  const broken = {
    ...SCAFFOLD,
    "src/App.jsx": `import { missing } from "./nowhere";\nexport default () => null;\n`,
  };
  const result = await runStageGate(broken, {
    nodeModules: "/definitely/not/here",
    compile: async () => { compiled = true; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(compiled, false, "an unresolvable import must not cost a four-second compile");
  assert.equal(result.checks[0].name, "imports");
  assert.match(gateSummary(result), /imports:FAILED/);
});

test("a gate that passes reports every check it ran", async () => {
  const result = await runStageGate(SCAFFOLD, {
    nodeModules: "/definitely/not/here",
    compile: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((c) => c.name), ["imports", "config", "compile"]);
  assert.equal(gateSummary(result), "imports:ok config:ok compile:ok");
});

// ── the run ───────────────────────────────────────────────────────────────────────────────────

// A harness that lets a test say "stage N fails K times, then succeeds".
function harness({ failures = {} } = {}) {
  const attempts = {};
  const checkpoints = [];
  return {
    checkpoints,
    attempts,
    runStage: async (stage, { tree }) => {
      attempts[stage.id] = (attempts[stage.id] || 0) + 1;
      tree[`src/${stage.id}.jsx`] = `// ${stage.id} attempt ${attempts[stage.id]}\nexport default () => null;\n`;
    },
    gate: async (tree) => {
      const stage = Object.keys(tree).map((p) => p.match(/^src\/(\w+)\.jsx$/)?.[1]).filter(Boolean).pop();
      const budget = failures[stage] || 0;
      const ok = (attempts[stage] || 0) > budget;
      return ok
        ? { ok: true, checks: [{ name: "compile", ok: true }], tree, problems: [] }
        : { ok: false, checks: [{ name: "compile", ok: false }], tree, problems: [`${stage} does not compile`], stderr: `error in ${stage}` };
    },
    checkpoint: (entry) => checkpoints.push(entry),
  };
}

test("every stage that passes becomes a checkpoint, in order", async () => {
  const h = harness();
  const result = await runStagedBuild({
    contract: CONTRACT, tree: SCAFFOLD, request: "build it",
    runStage: h.runStage, gate: h.gate, checkpoint: h.checkpoint,
  });

  assert.deepEqual(result.stages.map((s) => s.stage), ["foundation", "data", "primary_journey", "supporting", "polish"]);
  assert.ok(result.stages.every((s) => s.ok));
  assert.deepEqual(h.checkpoints.map((c) => c.stage), ["foundation", "data", "primary_journey", "supporting", "polish"]);
  assert.equal(result.green, "polish");
  assert.deepEqual(result.lostStages, []);
  // Each checkpoint records what changed in that stage.
  assert.ok(h.checkpoints.every((c) => c.changedFiles.length > 0));
  assert.match(stagesSummary(result.stages), /foundation:green/);
});

test("a stage that fails once is repaired and still ends green", async () => {
  const h = harness({ failures: { data: 1 } });
  const result = await runStagedBuild({
    contract: CONTRACT, tree: SCAFFOLD, request: "build it",
    runStage: h.runStage, gate: h.gate, checkpoint: h.checkpoint,
  });
  const data = result.stages.find((s) => s.stage === "data");
  assert.equal(data.ok, true);
  assert.equal(data.repairs, 1, "one repair, not a whole rebuild");
  assert.equal(result.lostStages.length, 0);
  assert.equal(h.checkpoints.length, 5);
});

test("a stage beyond repair is lost, and the run keeps the last green tree", async () => {
  // The stage fails more times than it has repairs.
  const h = harness({ failures: { primary_journey: 99 } });
  const result = await runStagedBuild({
    contract: CONTRACT, tree: SCAFFOLD, request: "build it",
    runStage: h.runStage, gate: h.gate, checkpoint: h.checkpoint,
  });

  assert.deepEqual(result.lostStages, ["primary_journey"]);
  assert.equal(primaryStageOk(result.stages), false, "the preview must not ship on this");
  assert.equal(h.attempts.primary_journey, 3, "one attempt plus two repairs, then it stops");

  // No checkpoint for the failed stage, and the later stages still ran from the last green tree.
  assert.ok(!h.checkpoints.some((c) => c.stage === "primary_journey"));
  assert.deepEqual(h.checkpoints.map((c) => c.stage), ["foundation", "data", "supporting", "polish"]);

  // The returned tree is green: it contains no artefact of the stage that failed.
  assert.ok(!result.tree["src/primary_journey.jsx"], "a lost stage must not leak into the delivered tree");
  assert.ok(result.tree["src/data.jsx"], "and everything that did pass is still there");
  assert.match(stagesSummary(result.stages), /primary_journey:LOST/);
});

test("a later stage always starts from the last green tree, never from a failed one", async () => {
  const seen = [];
  const h = harness({ failures: { data: 99 } });
  const result = await runStagedBuild({
    contract: CONTRACT, tree: SCAFFOLD, request: "build it",
    runStage: async (stage, args) => {
      // What the stage was handed, before it writes anything.
      seen.push({ stage: stage.id, files: Object.keys(args.tree).filter((p) => p.startsWith("src/") && p.endsWith(".jsx")) });
      await h.runStage(stage, args);
    },
    gate: h.gate, checkpoint: h.checkpoint,
  });

  const primaryStart = seen.find((s) => s.stage === "primary_journey");
  assert.ok(!primaryStart.files.includes("src/data.jsx"),
    "the stage after a lost one must not inherit the broken stage's files");
  assert.ok(primaryStart.files.includes("src/foundation.jsx"),
    "but it does inherit everything that passed its gate");
  assert.deepEqual(result.lostStages, ["data"]);
});

test("cancellation stops between stages without corrupting the tree", async () => {
  const h = harness();
  let calls = 0;
  const result = await runStagedBuild({
    contract: CONTRACT, tree: SCAFFOLD, request: "build it",
    runStage: h.runStage, gate: h.gate, checkpoint: h.checkpoint,
    cancelled: () => { calls += 1; return calls > 4; },
  });
  assert.ok(result.stages.length < 5, "it stopped early");
  assert.ok(result.stages.every((s) => s.ok), "and everything it did record had passed its gate");
});

test("every stage definition instructs something materially different", () => {
  const instructions = STAGES.map((id) => STAGE_DEFINITIONS[id].instruction);
  assert.equal(new Set(instructions).size, instructions.length);
  assert.match(STAGE_DEFINITIONS.polish.instruction, /Change no behaviour, remove no feature/);
  assert.match(STAGE_DEFINITIONS.data.instruction, /db\.entity/);
});
