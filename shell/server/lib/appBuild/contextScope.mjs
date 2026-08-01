// Scoped context pipeline for build/repair jobs. Classifies the task, assigns a token
// budget, infers the entry file for edits (local scoring — no AI), decides whether to run
// the engine in seeded context-selection mode, and produces the context metadata that the
// diagnostics system records per AI request. Also: failure fingerprints for the controlled
// repair loop and the oversized-request cost guard.
//
// Reuses the engine's proven Buildr101 context machinery (contextSelection + entry-file
// seeding + history pruning in src/engine/runAgent.mjs) — measured on the harness at
// ~42% fewer input tokens and half the turns for a one-file edit versus blind discovery.

import { createHash } from "node:crypto";
import { directDeps } from "../../../../src/engine/context.mjs";
import { creditsForUsage } from "../../../../src/billing/costModel.mjs";

export const estTokens = (text) => Math.round(String(text || "").length / 4);

// ── Task classification + budgets ───────────────────────────────────────────────────────

const BUDGET_ENV = {
  simple_edit: "THRALLO_CTX_BUDGET_SIMPLE",
  component_edit: "THRALLO_CTX_BUDGET_COMPONENT",
  feature: "THRALLO_CTX_BUDGET_FEATURE",
  bug_repair: "THRALLO_CTX_BUDGET_REPAIR",
  verification_repair: "THRALLO_CTX_BUDGET_VERIFY_REPAIR",
  full_build: "THRALLO_CTX_BUDGET_BUILD",
};
const BUDGET_DEFAULT = {
  simple_edit: 8_000,
  component_edit: 16_000,
  feature: 40_000,
  bug_repair: 24_000,
  verification_repair: 24_000,
  full_build: 200_000,
};

export function taskBudget(taskType) {
  const env = Number(process.env[BUDGET_ENV[taskType]] || 0);
  return env > 0 ? env : (BUDGET_DEFAULT[taskType] || BUDGET_DEFAULT.feature);
}

export function classifyTask({ mode, prompt = "", redesign = false, trigger = "user" }) {
  if (mode === "build" || redesign) return "full_build";
  if (trigger === "verification_repair") return "verification_repair";
  if (trigger === "autonomous_repair") return "bug_repair";
  const text = String(prompt).toLowerCase();
  if (/repair mode|fix only|bug|error|crash|broken|doesn't work|does not work/.test(text)) return "bug_repair";
  if (/\b(add|create|implement|build)\b.*\b(feature|page|screen|flow|system|integration)\b/.test(text)) return "feature";
  // Small wording/style/content tweaks are the most common follow-up.
  if (text.length < 220 && /\b(rename|change|text|label|colour|color|wording|title|copy|button|spacing|font|say|reads?)\b/.test(text)) {
    return "simple_edit";
  }
  return "component_edit";
}

// ── Entry-file inference (local scoring — repository search without a model) ────────────

const SKIP_PATHS = /^(src\/lib\/backend\/|node_modules|package(-lock)?\.json|index\.html)/;

export function inferEntryFile(tree, text) {
  const hay = String(text || "");
  // 1) An exact path mentioned in the prompt/stderr wins outright.
  for (const path of Object.keys(tree)) {
    if (!SKIP_PATHS.test(path) && hay.includes(path)) return path;
  }
  // 2) Otherwise score files by basename mention + shared keywords with their contents.
  const words = [...new Set(hay.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])].slice(0, 40);
  let best = null;
  let bestScore = 0;
  for (const [path, contents] of Object.entries(tree)) {
    if (SKIP_PATHS.test(path) || typeof contents !== "string") continue;
    const base = path.split("/").pop().replace(/\.[a-z]+$/, "").toLowerCase();
    let score = 0;
    if (base.length > 3 && hay.toLowerCase().includes(base)) score += 8;
    const lower = contents.toLowerCase();
    for (const word of words) if (lower.includes(word)) score += 1;
    if (score > bestScore) { bestScore = score; best = path; }
  }
  return bestScore >= 4 ? best : null;
}

// ── The scope decision for a job ────────────────────────────────────────────────────────

export function scopeForJob({ mode, prompt = "", redesign = false, trigger = "user", tree = null, systemPromptChars = 0 }) {
  const taskType = classifyTask({ mode, prompt, redesign, trigger });
  const budgetTokens = taskBudget(taskType);
  const scope = {
    taskType, budgetTokens, trigger,
    contextSelection: false, entryFile: null,
    files: [], warnings: [],
    estContextTokens: estTokens(prompt) + Math.round(systemPromptChars / 4),
  };
  if (taskType === "full_build" || !tree) return scope; // builds author from scratch — no seeding

  // Follow-up edits and repairs run in seeded context-selection mode: the entry file and
  // its direct imports ride along; everything else stays paths-only in the manifest.
  scope.contextSelection = true;
  const entry = inferEntryFile(tree, prompt);
  if (entry) {
    scope.entryFile = entry;
    scope.files.push({ path: entry, reason: "matched the request/error text" });
    for (const dep of directDeps(tree, entry)) {
      scope.files.push({ path: dep, reason: `direct import of ${entry}` });
    }
    // Budget enforcement: trim dependency seeding before ever exceeding the task budget.
    let seededChars = 0;
    scope.files = scope.files.filter((f) => {
      seededChars += (tree[f.path] || "").length;
      if (estTokens(String(seededChars)) && scope.estContextTokens + Math.round(seededChars / 4) > budgetTokens && f.path !== entry) {
        scope.warnings.push(`dropped ${f.path} to stay inside the ${taskType} budget`);
        return false;
      }
      return true;
    });
    scope.estContextTokens += Math.round(scope.files.reduce((a, f) => a + (tree[f.path] || "").length, 0) / 4);
  } else {
    scope.files.push({ path: "(manifest only)", reason: "no confident entry match — model reads on demand, contents never pre-attached" });
  }
  if (scope.estContextTokens > budgetTokens) {
    scope.warnings.push(`estimated context ${scope.estContextTokens} tok exceeds the ${taskType} budget (${budgetTokens} tok)`);
  }
  return scope;
}

// ── Controlled repair loop: failure + patch fingerprints ────────────────────────────────

export function fingerprintFailure(reasons) {
  const normalized = [].concat(reasons || [])
    .map((r) => String(r).toLowerCase().replace(/[0-9a-f-]{8,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim())
    .sort()
    .join("|");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function fingerprintPrompt(prompt) {
  return createHash("sha1").update(String(prompt || "")).digest("hex").slice(0, 16);
}

// ── Oversized-request cost guard ────────────────────────────────────────────────────────

export function costGuard({ estContextTokens, model = "", trigger = "user", maxTurns = 25 }) {
  // Conservative projection: context resent each turn plus modest growth.
  const projectedTokens = estContextTokens * Math.min(maxTurns, 8) * 1.6;
  let projectedCredits = 0;
  try {
    projectedCredits = creditsForUsage({ usage: { input: projectedTokens, output: projectedTokens * 0.2, total: projectedTokens * 1.2 }, model });
  } catch { projectedCredits = 0; }
  const threshold = Number(process.env.THRALLO_COST_APPROVAL_CREDITS || 150);
  const blocked = trigger !== "user" && projectedCredits > threshold;
  return { projectedCredits: Number(projectedCredits.toFixed(2)), threshold, blocked };
}
