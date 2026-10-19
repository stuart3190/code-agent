// Offline proof of the direct-edit path.
//
// Replay mode feeds recorded model output through the real classifier, prompt, applyPatches,
// compile and smoke. The BeamPlan fixture is partial, so compile and smoke are the esbuild +
// jsdom reconstruction in directEditRuntime.mjs. Production uses the sandbox Vite compile and
// Playwright smoke_v1. Live mode calls a model only when an API key is present.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import { classifyEditRequest, runDirectEdit } from "../shell/server/lib/builderV2/directEdit.mjs";
import { compileDirectEditTree, smokeBeamPlan } from "../shell/server/lib/builderV2/directEditRuntime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIR = path.join(root, "test/code-agent/fixtures/beamplan");
export const FLOW = "src/components/calculate-recessed-lighting-plan/CalculateRecessedLightingPlanFlow.jsx";
export const CM_REQUEST = "Add centimeters (cm) as an option in BeamPlan's existing unit selector";
const LARGE_REQUEST = "add user accounts and save plans";

export async function loadFixtureTree(dir = FIXTURE_DIR) {
  const tree = {};
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(jsx?|mjs|css)$/.test(entry.name)) {
        tree[path.relative(dir, full).split(path.sep).join("/")] = await readFile(full, "utf8");
      }
    }
  };
  await walk(path.join(dir, "src"));
  return tree;
}

export function loadPatchBatches(text) {
  const headers = [...String(text).matchAll(/^===== (.+)$/gm)].map((match) => match[1]);
  const bodies = String(text).split(/^===== .*$/m).slice(1).map((body) => body.trim()).filter(Boolean);
  return bodies.map((body, index) => ({ header: headers[index] || "", patch: JSON.parse(body) }));
}

export function recordedCentimetrePatches(text) {
  const batches = loadPatchBatches(text);
  const firstStamp = (batches[0]?.header || "").slice(0, 19);
  return batches.filter((batch) => batch.header.startsWith(firstStamp)).map((batch) => batch.patch);
}

async function greenProject(tree) {
  const snapshotStore = createSnapshotStore();
  const green = await snapshotStore.createSnapshot("owner", "beamplan", tree, { reason: "working:green" });
  await snapshotStore.promote("owner", "beamplan", "green", green.id);
  return { snapshotStore, greenId: green.id };
}

function scriptedModel(script) {
  const prompts = [];
  let index = 0;
  return {
    prompts,
    modelFn: async ({ prompt }) => {
      prompts.push(prompt);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return typeof step === "function" ? step({ prompt, index }) : step;
    },
  };
}

export async function runOfflineHarness({ live = false } = {}) {
  const tree = await loadFixtureTree();
  const patchText = await readFile(path.join(FIXTURE_DIR, "patches.txt"), "utf8");
  const recorded = recordedCentimetrePatches(patchText);
  const lines = [];
  const say = (line) => { lines.push(line); console.log(line); };
  const results = {};

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const model = scriptedModel([{ patches: recorded, credits: 0.42 }]);
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: (next) => compileDirectEditTree(next, { entry: FLOW }),
      smokeFn: (next) => smokeBeamPlan(next, { entry: FLOW }),
    });
    const pointer = await snapshotStore.pointer("owner", "beamplan", "green");
    const observed = outcome.smoke?.observed || {};
    const ok = outcome.outcome === "applied" && outcome.promoted && pointer !== greenId
      && model.prompts.length === 1
      && String(observed.cm).includes("133.33 cm") && String(observed.cm).includes("150 cm")
      && String(observed.metres).includes("1.33 m") && String(observed.metres).includes("1.50 m")
      && String(observed.reset).includes("Metres (m)");
    results.replayApply = { ok, outcome: outcome.outcome, spentCredits: outcome.spentCredits, observed, error: outcome.smoke?.error || outcome.errors };
    say(`(a) recorded BeamPlan cm patch ${ok ? "PASS" : "FAIL"} outcome=${outcome.outcome} promoted=${outcome.promoted} cm=${JSON.stringify(observed.cm || outcome.errors)} m=${JSON.stringify(observed.metres || "")} reset=${JSON.stringify(observed.reset || "")}`);
  }

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const bogus = "const presets = [{ rows: 2, columns: 2, label: \"4 lights\" }, { rows: 2, columns: 3, label: \"6 lights\" }, { rows: 3, columns: 3, label: \"9 lights\" }, { rows: 3, columns: 4, label: \"12 lights\" }]; NOT A REAL ANCHOR";
    const model = scriptedModel([
      { patches: [{ file: FLOW, ops: [{ op: "insert_after_symbol", symbol: bogus, content: "const extra = 1;\n" }] }], credits: 0.4 },
      { patches: recorded, credits: 0.5 },
    ]);
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: (next) => compileDirectEditTree(next, { entry: FLOW }),
      smokeFn: (next) => smokeBeamPlan(next, { entry: FLOW }),
    });
    const retryHasRejection = /PREVIOUS EXACT-SOURCE PATCH REJECTIONS/.test(model.prompts[1] || "")
      && /present symbols:/.test(model.prompts[1] || "");
    const ok = model.prompts.length === 2 && retryHasRejection && outcome.modelCalls === 2;
    results.retry = { ok, calls: outcome.modelCalls, outcome: outcome.outcome };
    say(`(b) forced rejection retries once ${ok ? "PASS" : "FAIL"} calls=${outcome.modelCalls} retryPromptHasRejection=${retryHasRejection} outcome=${outcome.outcome}`);
  }

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const model = scriptedModel([
      { patches: recorded, credits: 1.06 },
      { patches: recorded, credits: 1.07 },
    ]);
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: async () => ({ ok: true }),
      smokeFn: async () => ({ pass: false, error: "forced smoke failure" }),
    });
    const pointer = await snapshotStore.pointer("owner", "beamplan", "green");
    const honest = outcome.spentCredits === 2.13
      && outcome.modelCalls === 2
      && outcome.outcome === "fallback"
      && /2\.13/.test(outcome.message || "")
      && !/credits remain protected/i.test(outcome.message || "")
      && outcome.settlement.creditsProtected === false;
    const ok = pointer === greenId && outcome.promoted === false && honest;
    results.smokeFailure = { ok, pointerUnchanged: pointer === greenId, spentCredits: outcome.spentCredits, message: outcome.message, outcome: outcome.outcome, calls: outcome.modelCalls };
    say(`(c) concrete smoke crash retries once ${ok ? "PASS" : "FAIL"} outcome=${outcome.outcome} calls=${outcome.modelCalls} spent=${outcome.spentCredits} message=${JSON.stringify(outcome.message)}`);
  }

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const model = scriptedModel([{ patches: recorded, credits: 1.06 }]);
    let compiles = 0;
    let smokes = 0;
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: async () => { compiles += 1; return { ok: true }; },
      smokeFn: async () => {
        smokes += 1;
        return { pass: null, unavailable: true, error: "preview unavailable" };
      },
    });
    const pointer = await snapshotStore.pointer("owner", "beamplan", "green");
    const honest = outcome.spentCredits === 1.06
      && /1\.06/.test(outcome.message || "")
      && !/credits remain protected/i.test(outcome.message || "")
      && outcome.settlement.creditsProtected === false
      && outcome.fallbackRequest == null
      && outcome.route === "direct_edit";
    const ok = outcome.modelCalls === 1 && model.prompts.length === 1
      && compiles === 2 && smokes === 2
      && pointer === greenId && outcome.promoted === false
      && outcome.outcome === "unchanged" && outcome.infra === true && honest;
    results.infraSmoke = {
      ok, calls: outcome.modelCalls, compiles, smokes, outcome: outcome.outcome,
      spentCredits: outcome.spentCredits, message: outcome.message,
    };
    say(`(e) unavailable smoke does not pay for a second model call ${ok ? "PASS" : "FAIL"} calls=${outcome.modelCalls} compiles=${compiles} smokes=${smokes} outcome=${outcome.outcome} spent=${outcome.spentCredits} message=${JSON.stringify(outcome.message)}`);
  }

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const model = scriptedModel([{ patches: recorded, credits: 0.42 }]);
    let smokes = 0;
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: (next) => compileDirectEditTree(next, { entry: FLOW }),
      smokeFn: async (next) => {
        smokes += 1;
        if (smokes === 1) return { pass: null, unavailable: true, error: "preview unavailable" };
        return smokeBeamPlan(next, { entry: FLOW });
      },
    });
    const pointer = await snapshotStore.pointer("owner", "beamplan", "green");
    const ok = outcome.modelCalls === 1 && smokes === 2 && outcome.outcome === "applied"
      && outcome.promoted === true && pointer !== greenId
      && String(outcome.smoke?.observed?.cm || "").includes("133.33 cm");
    results.infraRecovered = { ok, calls: outcome.modelCalls, smokes, outcome: outcome.outcome, promoted: outcome.promoted };
    say(`(f) free compile/smoke re-run can pass the same candidate ${ok ? "PASS" : "FAIL"} calls=${outcome.modelCalls} smokes=${smokes} outcome=${outcome.outcome} promoted=${outcome.promoted}`);
  }

  {
    const { snapshotStore, greenId } = await greenProject(tree);
    const model = scriptedModel([
      { patches: recorded, credits: 0.4 },
      { patches: recorded, credits: 9 },
    ]);
    const outcome = await runDirectEdit({
      owner: "owner", projectId: "beamplan", request: CM_REQUEST, tree,
      snapshotStore, greenSnapshotId: greenId,
      modelFn: model.modelFn,
      compileFn: async () => ({ ok: true }),
      smokeFn: async () => ({ pass: false }),
    });
    const pointer = await snapshotStore.pointer("owner", "beamplan", "green");
    const ok = outcome.modelCalls === 1 && model.prompts.length === 1
      && outcome.outcome === "unchanged" && outcome.infra === false
      && outcome.route === "direct_edit" && outcome.fallbackRequest == null
      && pointer === greenId && outcome.spentCredits === 0.4
      && !/protected/i.test(outcome.message || "");
    results.smokeWithoutError = { ok, calls: outcome.modelCalls, outcome: outcome.outcome, spentCredits: outcome.spentCredits };
    say(`(g) smoke failure without a concrete error does not retry ${ok ? "PASS" : "FAIL"} calls=${outcome.modelCalls} outcome=${outcome.outcome} spent=${outcome.spentCredits}`);
  }

  {
    const classification = classifyEditRequest(LARGE_REQUEST);
    let called = false;
    const outcome = await runDirectEdit({
      request: LARGE_REQUEST, tree,
      modelFn: async () => { called = true; return { patches: [], credits: 1 }; },
      compileFn: async () => ({ ok: true }),
      smokeFn: async () => ({ pass: true }),
    });
    const ok = classification.size === "large" && classification.route === "full_pipeline"
      && outcome.outcome === "escalate" && outcome.route === "full_pipeline" && called === false
      && outcome.spentCredits === 0;
    results.large = { ok, classification, outcome: outcome.outcome, called };
    say(`(d) large request routes to the full pipeline ${ok ? "PASS" : "FAIL"} size=${classification.size} outcome=${outcome.outcome} modelCalled=${called} reasons=${classification.reasons.join(",")}`);
  }

  if (live) {
    const key = ["OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "AZURE_OPENAI_API_KEY"]
      .find((name) => process.env[name]);
    if (!key) {
      results.live = { skipped: true };
      say("LIVE: skipped — no model API key in the environment (OPENAI_API_KEY, XAI_API_KEY, ANTHROPIC_API_KEY, CODEX_API_KEY, OPENROUTER_API_KEY, AZURE_OPENAI_API_KEY).");
    } else {
      results.live = { skipped: false, key };
      say(`LIVE: a ${key} is set, but this harness does not send the fixture to a provider from an unattended run. Re-run with an explicit live adapter if you want a billed call.`);
    }
  } else {
    results.live = { skipped: true, reason: "replay mode" };
    say("LIVE: not requested. Pass --live to check for a model API key.");
  }

  const failed = Object.entries(results).filter(([, value]) => value.ok === false);
  say(failed.length ? `OFFLINE HARNESS FAIL (${failed.map(([name]) => name).join(", ")})` : "OFFLINE HARNESS PASS");
  return { ok: failed.length === 0, lines, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const live = process.argv.includes("--live");
  const report = await runOfflineHarness({ live });
  process.exit(report.ok ? 0 : 1);
}
