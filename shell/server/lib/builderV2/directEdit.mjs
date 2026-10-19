// Direct edit: the built ⇄ iterating loop for a small change to a green app.
//
// One full-context model call, applyPatches, compile, smoke. A second model call happens
// only for a patch rejection, a compile error, or a smoke crash with a concrete error to
// feed back. A preview that comes back pass:null / unavailable is infrastructure, not an
// app failure: compile and smoke run once more on the same candidate, for free, and the
// green snapshot stays put when that re-run also fails. No contract, journey, headroom or
// repair machinery. A prompt that cannot fit the per-call ceiling, a large request, or a
// patch that outgrows the small-edit boundary returns to the full pipeline.

import { applyPatches, isProtectedPath } from "./patchEngine.mjs";
import { ESTIMATED_BYTES_PER_TOKEN, editTargets, isHeadroomFitError } from "./modelLanes.mjs";

export const DIRECT_EDIT_CALL_CEILING_CREDITS = 1.5;
export const DIRECT_EDIT_JOB_CEILING_CREDITS = 3;
export const DIRECT_EDIT_SOURCE_TOKEN_BUDGET = 12_000;
export const DIRECT_EDIT_MAX_FILES = 3;
export const DIRECT_EDIT_MAX_DIFF_LINES = 150;

export const DIRECT_EDIT_SYSTEM_PROMPT = `You edit an existing React+Vite app. Respond only by calling emit_patches.
Change only the files the request needs. Prefer replace_exact: put the exact old excerpt in symbol and its complete replacement in content. The old excerpt must occur exactly once.
insert_after_symbol, insert_before_symbol, replace_symbol and delete_symbol take the indexed declaration name (for example presets), never a copied source line.
Do not add routes, packages, persistence, auth, or new files. Preserve every behavior the request does not name.`;

const LARGE_RULES = Object.freeze([
  { code: "auth", re: /\b(user accounts?|accounts?|authentication|sign[\s-]?in|sign[\s-]?up|log[\s-]?in|password|oauth)\b/i },
  { code: "persistence", re: /\b(persist|database|supabase|backend|save plans|save the plans|store plans)\b/i },
  { code: "new_route", re: /\b(new|add|another)\s+(page|route|screen|entity)\b/i },
  { code: "package", re: /\bpackage\.json\b|\b(npm install|add a dependency|new dependency)\b/i },
  { code: "backend", re: /\b(api endpoint|server route|edge function)\b/i },
]);

/** Default on. `0`, `false`, `off` or `no` disables it for the current process without a redeploy. */
export function directEditEnabled(env = process.env) {
  const raw = env?.THRALLO_DIRECT_EDIT;
  if (raw == null || String(raw).trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function readCreditCeiling(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value * 100) / 100;
}

/**
 * Per-call and whole-direct-edit ceilings, read at request time.
 * `THRALLO_DIRECT_EDIT_CALL_CEILING` defaults to 1.5. `THRALLO_DIRECT_EDIT_JOB_CEILING` defaults to 3.
 * A non-numeric or non-positive value keeps the default.
 */
export function directEditCeilings(env = process.env) {
  return {
    callCeilingCredits: readCreditCeiling(env?.THRALLO_DIRECT_EDIT_CALL_CEILING, DIRECT_EDIT_CALL_CEILING_CREDITS),
    jobCeilingCredits: readCreditCeiling(env?.THRALLO_DIRECT_EDIT_JOB_CEILING, DIRECT_EDIT_JOB_CEILING_CREDITS),
  };
}

/** Stage 1. A lead proposal of "large" is accepted. A "small" proposal cannot hide a hard large signal. */
export function classifyEditRequest(request, { proposal = null } = {}) {
  const text = String(request || "");
  const reasons = [];
  for (const rule of LARGE_RULES) {
    if (rule.re.test(text) && !reasons.includes(rule.code)) reasons.push(rule.code);
  }
  if (proposal === "large" && !reasons.includes("lead_proposal")) reasons.push("lead_proposal");
  if (reasons.length) return { size: "large", reasons, route: "full_pipeline" };
  return { size: "small", reasons: [], route: "direct_edit" };
}

function patchFiles(patch) {
  return [patch?.file, patch?.newFile, patch?.replaceFile, patch?.deleteFile].filter(Boolean);
}

function patchIntroducesRoute(patch, tree) {
  const file = patch?.newFile || patch?.file || "";
  if (patch?.newFile && /^src\/(routes|pages|screens)\//.test(file)) return true;
  const blob = `${JSON.stringify(patch?.ops || [])}\n${patch?.content || ""}`;
  if (!/<Route\b|createBrowserRouter\(/.test(blob)) return false;
  return !/<Route\b|createBrowserRouter\(/.test(String(tree?.[file] || ""));
}

/** Stage 2. The server checks the emitted patch before it can become the candidate. */
export function assessDirectEditPatch(patches, tree = {}) {
  const files = new Set();
  const reasons = [];
  let diffLines = 0;
  for (const patch of patches || []) {
    for (const file of patchFiles(patch)) {
      files.add(file);
      if (/package\.json$/.test(file) && !reasons.includes("package")) reasons.push("package");
      if (/^src\/lib\/(modules|app)\//.test(file) && !reasons.includes("protected_path")) reasons.push("protected_path");
      if (isProtectedPath(file, { tree }) && !reasons.includes("protected_path")) reasons.push("protected_path");
    }
    if ((patch?.newFile || patch?.deleteFile) && !reasons.includes("new_file")) reasons.push("new_file");
    if (patchIntroducesRoute(patch, tree) && !reasons.includes("new_route")) reasons.push("new_route");
    for (const op of patch?.ops || []) diffLines += String(op?.content || "").split("\n").length;
    if (patch?.content) diffLines += String(patch.content).split("\n").length;
  }
  if (files.size > DIRECT_EDIT_MAX_FILES) reasons.push("too_many_files");
  if (diffLines > DIRECT_EDIT_MAX_DIFF_LINES) reasons.push("diff_too_large");
  return { ok: reasons.length === 0 && files.size > 0, reasons, files: [...files].sort(), diffLines };
}

function capUtf8(text, maxTokens) {
  const maxBytes = Math.max(1, Math.floor(Number(maxTokens) || 0)) * ESTIMATED_BYTES_PER_TOKEN;
  const bytes = Buffer.from(String(text || ""), "utf8");
  if (bytes.length <= maxBytes) return String(text || "");
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function relatedImports(tree, targets) {
  const related = [];
  for (const target of targets) {
    const source = String(tree[target] || "");
    const specs = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
    for (const spec of specs) {
      const base = target.split("/").slice(0, -1);
      const parts = [...base, ...spec.split("/")].filter((part) => part && part !== ".");
      const stack = [];
      for (const part of parts) {
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      const stem = stack.join("/");
      const candidates = [stem, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}/index.js`];
      const found = candidates.find((candidate) => typeof tree[candidate] === "string");
      if (found && !targets.includes(found) && !related.includes(found)) related.push(found);
    }
  }
  return related;
}

export function renderDirectEditPrompt({
  request = "", tree = {}, turns = [], targets = null, rejections = [], errors = [],
} = {}) {
  const paths = Object.keys(tree || {}).sort();
  const chosen = (targets && targets.length ? targets : editTargets(tree, request, { limit: DIRECT_EDIT_MAX_FILES }))
    .filter((path) => typeof tree?.[path] === "string");
  const related = relatedImports(tree, chosen);
  let remaining = DIRECT_EDIT_SOURCE_TOKEN_BUDGET;
  const blocks = [];
  const take = (path, role) => {
    if (remaining <= 200 || typeof tree[path] !== "string") return;
    const body = capUtf8(tree[path], remaining);
    const tokens = Math.ceil(Buffer.byteLength(body, "utf8") / ESTIMATED_BYTES_PER_TOKEN);
    remaining -= tokens;
    blocks.push(`--- ${path} (${role}) ---\n${body}`);
  };
  for (const path of chosen) take(path, "full target");
  for (const path of related) take(path, "imported by a target");
  const history = (turns || []).slice(-6).map((turn) => {
    const role = turn?.role === "lead" || turn?.role === "assistant" ? "Assistant" : "User";
    return `${role}: ${String(turn?.content || turn?.text || "").replace(/\s+/g, " ").slice(0, 500)}`;
  }).filter((line) => line.length > "User: ".length);
  const rejected = [...new Set([...(rejections || []), ...(errors || [])]
    .map((item) => String(item?.reason || item || "")).filter(Boolean))].slice(0, 8);
  return [
    "DIRECT EDIT of the current green app. Apply exactly this change and nothing else:",
    String(request || "").trim() || "Make the requested change.",
    "",
    "FILE TREE:",
    ...paths.map((path) => `  ${path}`),
    "",
    ...(history.length ? ["RECENT CONVERSATION:", ...history, ""] : []),
    ...(rejected.length ? [
      "PREVIOUS EXACT-SOURCE PATCH REJECTIONS (authoritative):",
      ...rejected.map((reason) => `- ${reason}`),
      "Emit a substantively corrected replacement. Do not repeat the rejected operation.",
      "insert_after_symbol, insert_before_symbol, replace_symbol and delete_symbol take the indexed declaration name (for example presets), never a copied source line.",
      "",
    ] : []),
    "CURRENT SOURCE:",
    ...blocks,
    "",
    "Call emit_patches now.",
  ].join("\n");
}

export function directEditAck(request) {
  if (/\b(cm|centimetres?)\b/i.test(String(request || ""))) return "Adding cm now.";
  return "Applying that change now.";
}

export function directEditSuccessMessage(request) {
  if (/\b(cm|centimetres?)\b/i.test(String(request || ""))) return "Done, cm is in. Preview updated.";
  return "Done. Preview updated.";
}

export function directEditFailureMessage(spentCredits, { infra = false } = {}) {
  const spent = Number(spentCredits) || 0;
  const spend = spent > 0 ? ` This attempt used ${spent.toFixed(2)} credits.` : "";
  if (infra) return `The preview check didn't finish, so your app is unchanged.${spend}`;
  return `I couldn't apply that, your app is unchanged.${spend}`;
}

export function settleDirectEdit({ spentCredits = 0, outcome = "unchanged" } = {}) {
  const spent = Math.round((Number(spentCredits) || 0) * 100) / 100;
  return {
    profile: "direct_edit",
    compensationEligible: false,
    managedRefundCredits: 0,
    creditsProtected: !(spent > 0),
    spentCredits: spent,
    outcome,
  };
}

export function composeFallbackRequest({ request = "", attemptedPatches = [], errors = [] } = {}) {
  return [
    String(request || "").trim(),
    "",
    "A direct edit of the current green app did not land. Continue from that green snapshot through the full edit pipeline.",
    "The attempted patch is a hint. Do not replay a rejected operation.",
    "Attempted patch:",
    JSON.stringify(attemptedPatches || []).slice(0, 8_000),
    "Errors:",
    ...(errors || []).map((error) => `- ${String(error?.reason || error)}`),
  ].join("\n");
}

function roundCredits(value) {
  const number = Number(value) || 0;
  return Math.round(number * 100) / 100;
}

function smokeDetail(smoke) {
  const fatal = (Array.isArray(smoke?.fatalErrors) ? smoke.fatalErrors : [])
    .map((item) => String(item || "").trim()).filter(Boolean);
  const error = String(smoke?.error || "").trim();
  return [error, ...fatal.filter((item) => item !== error)].filter(Boolean).join("; ");
}

/** pass:null or unavailable is a preview/infrastructure miss, not evidence the app crashed. */
function isInfraSmoke(smoke) {
  return smoke?.unavailable === true || smoke?.pass == null;
}

/** A crash the model can correct: the smoke failed and named an error. */
function isConcreteSmokeCrash(smoke) {
  return smoke?.pass === false && !isInfraSmoke(smoke) && Boolean(smokeDetail(smoke));
}

/**
 * Real direct-edit path. `modelFn`, `compileFn` and `smokeFn` are the only seams.
 * When `snapshotStore` is set, a candidate stays non-promotable until smoke passes,
 * and only then does the green pointer move.
 */
export async function runDirectEdit({
  owner = "owner", projectId = "project", buildId = "direct-edit",
  request, tree, turns = [], proposal = null,
  modelFn, compileFn, smokeFn,
  snapshotStore = null, greenSnapshotId = null, promoteGreen = true,
  callCeilingCredits = null, jobCeilingCredits = null,
} = {}) {
  if (typeof modelFn !== "function") throw new Error("direct edit needs a modelFn");
  const ceilings = directEditCeilings();
  const callCeiling = Number(callCeilingCredits) > 0 ? Number(callCeilingCredits) : ceilings.callCeilingCredits;
  const jobCeiling = Number(jobCeilingCredits) > 0 ? Number(jobCeilingCredits) : ceilings.jobCeilingCredits;
  const classification = classifyEditRequest(request, { proposal });
  const prompts = [];
  const errors = [];
  const attemptedPatches = [];
  let spentCredits = 0;
  let modelCalls = 0;
  const greenBefore = snapshotStore && greenSnapshotId
    ? greenSnapshotId
    : snapshotStore ? await snapshotStore.pointer(owner, projectId, "green") : greenSnapshotId;

  const finish = (outcome, extra = {}) => {
    const settlement = settleDirectEdit({ spentCredits, outcome });
    const infra = extra.infra === true;
    const message = outcome === "applied"
      ? directEditSuccessMessage(request)
      : outcome === "escalate"
        ? null
        : directEditFailureMessage(spentCredits, { infra });
    return {
      outcome, route: outcome === "applied" || outcome === "unchanged" ? "direct_edit" : "full_pipeline",
      classification, prompts, errors, attemptedPatches, modelCalls,
      spentCredits: roundCredits(spentCredits), settlement, message,
      infra,
      greenSnapshotId: extra.greenSnapshotId || greenBefore || null,
      candidateSnapshotId: extra.candidateSnapshotId || null,
      promoted: extra.promoted === true,
      tree: extra.tree || null,
      smoke: extra.smoke || null,
      fallbackRequest: outcome === "escalate" || outcome === "fallback"
        ? composeFallbackRequest({ request, attemptedPatches, errors }) : null,
      patchAssessment: extra.patchAssessment || null,
    };
  };

  if (classification.size === "large") return finish("escalate");

  const callModel = async (prompt) => {
    if (modelCalls >= 2) throw new Error("direct edit already used its one retry");
    const remaining = roundCredits(jobCeiling - spentCredits);
    const handoff = attemptedPatches.length ? "fallback" : "escalate";
    if (!(remaining > 0)) {
      errors.push("direct edit credit ceiling is exhausted");
      return { stop: true, outcome: handoff };
    }
    prompts.push(prompt);
    let result;
    try {
      result = await modelFn({
        prompt, systemPrompt: DIRECT_EDIT_SYSTEM_PROMPT, attempt: modelCalls + 1,
        callCeilingCredits: roundCredits(Math.min(callCeiling, remaining)),
      });
    } catch (error) {
      if (isHeadroomFitError(error)) {
        errors.push(String(error.message || "direct edit prompt does not fit the call ceiling"));
        return { stop: true, outcome: handoff };
      }
      throw error;
    }
    modelCalls += 1;
    const credits = roundCredits(result?.credits);
    spentCredits = roundCredits(spentCredits + credits);
    const patches = Array.isArray(result?.patches) ? result.patches : [];
    attemptedPatches.push(...patches);
    return { patches };
  };

  const held = (candidate, smoke) => ({
    candidateSnapshotId: candidate?.id || null, smoke,
  });

  const promoteApplied = async (assessment, applied, candidate, smoke) => {
    let promotedId = candidate?.id || null;
    if (snapshotStore && candidate && promoteGreen) {
      const validated = await snapshotStore.markCandidateValidated(owner, projectId, candidate.id, {
        reason: "working:direct-edit",
      });
      await snapshotStore.promote(owner, projectId, "green", validated.id);
      promotedId = validated.id;
    }
    return finish("applied", {
      patchAssessment: assessment, tree: applied.tree, smoke,
      candidateSnapshotId: candidate?.id || null,
      greenSnapshotId: promotedId || greenBefore,
      promoted: Boolean(snapshotStore && candidate && promoteGreen),
    });
  };

  // One paid retry, against the tree the caller names. A ceiling or fit failure does not spend.
  const retryModel = async (prompt, { assessment, candidate = null, smoke = null, baseTree = null }) => {
    if (retried) return finish("fallback", { patchAssessment: assessment, ...held(candidate, smoke) });
    retried = true;
    const next = await callModel(prompt);
    if (next.stop) return finish(next.outcome, { patchAssessment: assessment, ...held(candidate, smoke) });
    if (baseTree) tree = baseTree;
    patches = next.patches;
    return null;
  };

  let retried = false;
  let infraRerunUsed = false;
  let patches;
  const first = await callModel(renderDirectEditPrompt({ request, tree, turns }));
  if (first.stop) return finish(first.outcome);
  patches = first.patches;
  for (;;) {
    const assessment = assessDirectEditPatch(patches, tree);
    if (!assessment.ok) {
      errors.push(`direct edit patch is outside the small-edit boundary: ${assessment.reasons.join(", ") || "empty"}`);
      return finish(retried ? "fallback" : "escalate", { patchAssessment: assessment });
    }
    const applied = applyPatches(tree, patches);
    if (applied.rejected?.length) {
      const reasons = applied.rejected.map((row) => row.reason);
      errors.push(...reasons);
      const stopped = await retryModel(renderDirectEditPrompt({
        request, tree, turns, rejections: applied.rejected, errors: reasons,
      }), { assessment });
      if (stopped) return stopped;
      continue;
    }
    const compiled = compileFn ? await compileFn(applied.tree) : { ok: true };
    if (!compiled?.ok) {
      const reason = String(compiled?.error || compiled?.stderr || "compile failed");
      errors.push(reason);
      const stopped = await retryModel(renderDirectEditPrompt({
        request, tree, turns, errors: [reason],
      }), { assessment });
      if (stopped) return stopped;
      continue;
    }
    let candidate = null;
    if (snapshotStore) {
      candidate = await snapshotStore.createSnapshot(owner, projectId, applied.tree, {
        buildId, parent: greenBefore, reason: "candidate:direct-edit",
      });
    }
    let smoke = smokeFn ? await smokeFn(applied.tree) : { pass: true };
    if (isInfraSmoke(smoke) && !infraRerunUsed) {
      infraRerunUsed = true;
      errors.push(smokeDetail(smoke) || "smoke unavailable");
      const againCompiled = compileFn ? await compileFn(applied.tree) : { ok: true };
      if (!againCompiled?.ok) {
        const reason = String(againCompiled?.error || againCompiled?.stderr || "compile failed");
        errors.push(reason);
        const stopped = await retryModel(renderDirectEditPrompt({
          request, tree, turns, errors: [reason],
        }), { assessment, candidate, smoke });
        if (stopped) return stopped;
        continue;
      }
      smoke = smokeFn ? await smokeFn(applied.tree) : { pass: true };
      if (smoke?.pass === true) return promoteApplied(assessment, applied, candidate, smoke);
      if (isInfraSmoke(smoke)) {
        errors.push(smokeDetail(smoke) || "smoke unavailable");
        return finish("unchanged", { patchAssessment: assessment, infra: true, ...held(candidate, smoke) });
      }
    }
    if (smoke?.pass === true) return promoteApplied(assessment, applied, candidate, smoke);
    if (isInfraSmoke(smoke)) {
      errors.push(smokeDetail(smoke) || "smoke unavailable");
      return finish("unchanged", { patchAssessment: assessment, infra: true, ...held(candidate, smoke) });
    }
    if (isConcreteSmokeCrash(smoke)) {
      const reason = smokeDetail(smoke);
      errors.push(reason);
      const stopped = await retryModel(renderDirectEditPrompt({
        request, tree: applied.tree, turns, errors: [reason],
      }), { assessment, candidate, smoke, baseTree: applied.tree });
      if (stopped) return stopped;
      continue;
    }
    return finish(retried ? "fallback" : "unchanged", {
      patchAssessment: assessment, ...held(candidate, smoke),
    });
  }
}
