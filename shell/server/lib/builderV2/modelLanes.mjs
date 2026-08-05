// The real model lanes behind the orchestrator's two seams (finish plan WP-9; master plan
// Parts 4 and 10). One shared usage bucket + one managedUsageGuard cover EVERY call in a
// build — contract and patches alike — so the job ceiling is a property of the build, not
// of any single call. All spend lands in the canonical diagnostics tables via diag.step
// (creditsForUsage is the ONE pricing function; nothing here invents a second).

import { generateContract } from "../appBuild/contractAgent.mjs";
import { contractBrief } from "../../../shared/implementationContract.mjs";
import { managedUsageGuard } from "../buildJobs.mjs";
import { EMIT_PATCHES_SCHEMA } from "./patchEngine.mjs";
import { capabilityBrief } from "./capabilityRegistry.mjs";

/** Same shape as buildJobs' private bucket: one accumulator for the whole job. */
export function jobUsageBucket() {
  const total = { turns: 0, input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 };
  return {
    add(telemetry) {
      if (!telemetry) return;
      for (const key of Object.keys(total)) total[key] += Number(telemetry[key] || 0);
    },
    summary() { return { ...total }; },
  };
}

// ── prompt rendering (byte-stable given identical inputs — Part 10 prefix discipline) ─────────

const PATCH_SYSTEM_PROMPT = `You are the implementation engine of an app builder. You receive an
implementation contract, the current file tree of a React+Vite app, and pre-resolved image
assets. You make changes ONLY by calling emit_patches — symbol-level operations validated
against a code index. Rules:
- newFile creates files; never rewrite an existing file via newFile. Ops modify existing files.
- Pages live in src/routes/<Name>.jsx and MUST be registered in src/App.jsx's ROUTES map
  (replace_symbol on the existing map or the App component).
- src/lib/backend/, src/lib/visitorSession.js and src/lib/capabilities/ are protected platform
  infrastructure: IMPORT them, never modify or reimplement them. Persistence goes through the
  capabilities (src/lib/capabilities) or the backend SDK — never localStorage.
- Imagery: import { ASSETS } from "./lib/assetData.js" (adjust the relative path) and render
  with the helpers in src/lib/assets.js (imageProps / pictureSources / isPlaceholder /
  placeholderStyle). Never hardcode an image URL and never invent one.
- Every user-visible outcome named in the journeys must appear as real, reachable UI text.
- Keep components small; one route file per page plus small shared components.`;

function renderTreeContext(tree) {
  const paths = Object.keys(tree).sort();
  const listed = paths.map((p) => `  ${p}`).join("\n");
  const show = (path) => (tree[path] ? `\n--- ${path} (current content) ---\n${tree[path]}` : "");
  return [
    "FILE TREE:", listed,
    show("src/App.jsx"),
    show("src/routes/HomePage.jsx"),
    show("src/lib/assetData.js"),
  ].join("\n");
}

export function renderPatchPrompt({ step, contract, tiers, tree, journey, rejections = [], problems = [] }) {
  const parts = [
    `STEP: ${step}`,
    step === "core"
      ? `Build the ESSENTIAL scope only: journeys [${tiers.essential.journeys.join(", ")}], entities [${tiers.essential.entities.join(", ")}]. Secondary work is delivered later as increments — do NOT build it now.`
      : `Build EXACTLY this one increment: journey "${journey?.id}" (${journey?.title}). Touch nothing else.`,
    "",
    "IMPLEMENTATION CONTRACT:",
    contractBrief(contract),
    "",
    "JOURNEYS IN SCOPE (each step's `expect` must be visible in the UI):",
    JSON.stringify(step === "core"
      ? (contract.journeys || []).filter((j) => tiers.essential.journeys.includes(j.id))
      : [journey], null, 1),
    "",
    renderTreeContext(tree),
  ];
  if (rejections.length) {
    parts.push("", "YOUR PREVIOUS PATCH BATCH WAS REJECTED — every reason below is exact; fix and re-emit ALL patches:",
      ...rejections.map((r) => `- ${r.reason}`));
  }
  if (problems.length) {
    parts.push("", "THE VERIFICATION GATE FAILED on your last tree — fix these and re-emit patches:",
      ...problems.map((p) => `- ${p}`));
  }
  parts.push("", "Call emit_patches now with the complete batch for this step.");
  return parts.join("\n");
}

// ── the lanes ─────────────────────────────────────────────────────────────────────────────────

/**
 * Wire a provider (Codex in WP-9) into the orchestrator's contractFn/patchesFn seams with
 * ONE job-wide credit ceiling. Throws ManagedCreditBudgetError (reason job_credit_limit)
 * the moment accumulated spend can no longer fit under the ceiling.
 */
export function createModelLanes({
  provider, ceilingCredits, diag = null, log = () => {},
  bucket = jobUsageBucket(),
}) {
  if (!provider || !ceilingCredits) throw new Error("model lanes need a provider and a ceiling");
  const guard = managedUsageGuard(Number(ceilingCredits), provider.model, bucket);
  const record = (step, { label, prompt, output, usage, durationMs }) => {
    try {
      diag?.step({ agent: "BuilderV2", kind: "agent", label: `${step}: ${label}`, status: "info", prompt, output, usage, model: provider.model, durationMs });
    } catch { /* diagnostics never block a build */ }
  };

  return {
    bucket,

    contractFn: async ({ request }) => {
      const startedAt = Date.now();
      const before = bucket.summary();
      let outcome;
      try {
        outcome = await generateContract({ provider, prompt: request, log, onUsage: guard });
      } finally {
        // Exact spend for THIS call = the shared bucket's delta (generateContract's own
        // `usage` reports only its last attempt). Recorded even when the guard throws —
        // paid work always reaches the diagnostics.
        const after = bucket.summary();
        const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] || 0)]));
        record("contract", {
          label: outcome?.degraded ? "implementation contract (degraded)" : "implementation contract",
          prompt: request, output: outcome ? JSON.stringify(outcome.contract) : null,
          usage: delta, durationMs: Date.now() - startedAt,
        });
      }
      if (!outcome.contract) throw new Error(`contract generation failed: ${(outcome.problems || []).join("; ")}`);
      return outcome.contract;
    },

    patchesFn: async ({ step, contract, tiers, tree, journey, rejections, problems }) => {
      const prompt = renderPatchPrompt({ step, contract, tiers, tree, journey, rejections, problems });
      const systemPrompt = `${PATCH_SYSTEM_PROMPT}\n\nAVAILABLE CAPABILITIES (import, never rewrite):\n${capabilityBrief()}`;
      const startedAt = Date.now();
      const turn = await provider.runTurn({
        systemPrompt,
        messages: [{ role: "user", content: prompt }],
        tools: [EMIT_PATCHES_SCHEMA],
        toolChoice: { type: "function", name: EMIT_PATCHES_SCHEMA.name },
      });
      const call = (turn.toolCalls || []).find((c) => c.name === EMIT_PATCHES_SCHEMA.name);
      // Record BEFORE the guard can throw — the ceiling stopping a build never hides spend.
      record(step, {
        label: `patches (${call?.arguments?.patches?.length ?? 0})`,
        prompt, output: call ? JSON.stringify(call.arguments) : turn.text,
        usage: { ...turn.usage, turns: 1 }, durationMs: Date.now() - startedAt,
      });
      await guard({ ...turn.usage, turns: 1 });
      if (!call || !Array.isArray(call.arguments?.patches)) {
        throw new Error(`the model did not call emit_patches at step ${step}: ${String(turn.text).slice(0, 300)}`);
      }
      return call.arguments.patches;
    },
  };
}
