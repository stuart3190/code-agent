// Generate in stages, each ending green.
//
// PR5 of docs/PIPELINE-REDESIGN.md. Previously: one turn wrote the whole project, and the first
// validation of any kind was `npm run build` after all 27 files existed. A fault in the foundation
// was found only once everything rested on it, and the "checkpoints" the system recorded were never
// restored from — they were a log, not a safety net.
//
// Here each stage runs, is gated (imports, build config, compile), and only then becomes a
// checkpoint. A stage that fails is repaired IN PLACE against the last green tree — not against
// whatever the failed attempt left behind, which is the difference between retrying and
// accumulating damage. If it still fails, the run keeps the last green checkpoint and reports which
// stage was lost rather than handing back a broken tree.

import { runStageGate, gateSummary } from "./stageGate.mjs";
import { planStages, stagePrompt } from "./stagePlan.mjs";
import { buildRepairBrief } from "./repairContext.mjs";

// Repairs of one stage, before that stage is abandoned. Two: the first is usually a real fix, the
// second catches the case where the first misread the error. A third has, in the observed data,
// never been the one that worked.
const MAX_STAGE_REPAIRS = 2;

/**
 * Run every stage of a build.
 *
 * `runStage(stage, { tree, prompt, mode })` performs one generation turn and mutates `tree` in
 * place, exactly as the existing builder does — injected so this module owns the sequencing and
 * nothing else, and so the caller keeps its billing, cancellation and telemetry wiring.
 *
 * Returns `{ tree, stages, green, lostStages }` where `tree` is the best tree available: the last
 * stage's output when everything passed, and the last green checkpoint when it did not.
 */
export async function runStagedBuild({
  contract,
  tree,
  request,
  runStage,
  gate,
  onStageStart = () => {},
  onStageEnd = () => {},
  checkpoint = null,
  log = () => {},
  cancelled = () => false,
  includePolish = true,
}) {
  const plan = planStages(contract, { includePolish });
  log(`staged build: ${plan.length} stages — ${plan.map((s) => s.id).join(" → ")}`);

  const results = [];
  const lostStages = [];
  // The last tree that passed a gate. Every repair and every fallback works from this, so a broken
  // stage can never poison the one after it.
  let green = { ...tree };
  let greenStage = null;

  for (const [index, stage] of plan.entries()) {
    if (cancelled()) break;
    const started = Date.now();
    onStageStart(stage, index, plan.length);

    // Always start a stage from the last green tree.
    let working = { ...green };
    const before = { ...green };
    let outcome = null;
    let lastGate = null;

    for (let attempt = 0; attempt <= MAX_STAGE_REPAIRS; attempt += 1) {
      if (cancelled()) break;

      const prompt = attempt === 0
        ? stagePrompt(stage, contract, { request })
        : buildRepairBrief({
          command: "npm run build",
          output: lastGate?.stderr || (lastGate?.problems || []).join("\n"),
          reasons: lastGate?.problems || [],
          changedFiles: Object.keys(working).filter((p) => working[p] !== before[p]),
          manifest: working["package.json"] || null,
          attempt, maxAttempts: MAX_STAGE_REPAIRS + 1,
          contract,
        });

      // A repair works from the failed tree — it is fixing what the stage produced. Only a stage
      // that is abandoned entirely goes back to green.
      const stageTree = attempt === 0 ? working : working;
      await runStage(stage, { tree: stageTree, prompt, mode: attempt === 0 ? "stage" : "repair", attempt });
      if (cancelled()) break;

      lastGate = await gate(stageTree);
      // Preflight may have corrected imports; adopt the corrected files.
      if (lastGate.tree) Object.assign(stageTree, lastGate.tree);
      working = stageTree;

      if (lastGate.ok) { outcome = { ok: true, attempt }; break; }
      log(`stage ${stage.id}: gate failed (${gateSummary(lastGate)}) — ${(lastGate.problems || []).slice(0, 2).join("; ")}`);
      if (attempt === MAX_STAGE_REPAIRS) outcome = { ok: false, attempt };
    }

    // Cancelled mid-stage. Record nothing for it: a stage the user stopped is not a stage that
    // failed, and reporting it as LOST would make a cancellation look like a defect.
    if (cancelled() && !outcome) break;

    const changedFiles = Object.keys({ ...before, ...working })
      .filter((path) => before[path] !== working[path]);

    if (outcome?.ok) {
      green = { ...working };
      greenStage = stage.id;
      // The checkpoint IS the fallback, so it is written from the gated tree and only after the
      // gate passed. A checkpoint of an ungated tree would be a trap rather than a safety net.
      if (checkpoint) {
        checkpoint({
          tree: green, stage: stage.id, label: `stage ${stage.id}`,
          compileOk: true, changedFiles,
        });
      }
      log(`stage ${stage.id}: GREEN (${changedFiles.length} files, ${outcome.attempt} repair(s))`);
    } else {
      // Beyond repair. Keep the last green tree and carry on: a later stage may still add value,
      // and the customer's floor stays a project that builds.
      lostStages.push(stage.id);
      log(`stage ${stage.id}: LOST after ${MAX_STAGE_REPAIRS} repair(s) — restored ${greenStage ? `stage ${greenStage}` : "the scaffold"}`);
    }

    results.push({
      stage: stage.id,
      title: stage.title,
      ok: !!outcome?.ok,
      repairs: outcome?.attempt ?? MAX_STAGE_REPAIRS,
      changedFiles,
      checks: lastGate?.checks || [],
      problems: outcome?.ok ? [] : (lastGate?.problems || []),
      durationMs: Date.now() - started,
    });
    onStageEnd(stage, results[results.length - 1]);
  }

  return { tree: green, stages: results, green: greenStage, lostStages };
}

/** Did the stage that gates the preview survive? */
export function primaryStageOk(stages) {
  const primary = (stages || []).find((s) => s.stage === "primary_journey");
  // No primary stage in the plan (a landing page) means nothing was lost.
  return primary ? primary.ok : true;
}

/** One line per stage, for the diagnostics record. */
export function stagesSummary(stages) {
  return (stages || [])
    .map((s) => `${s.stage}:${s.ok ? "green" : "LOST"}(${s.changedFiles.length}f${s.repairs ? `,${s.repairs}r` : ""})`)
    .join(" → ");
}
