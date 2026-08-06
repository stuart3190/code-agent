// The real model lanes behind the orchestrator's two seams (finish plan WP-9; master plan
// Parts 4 and 10). One shared usage bucket + one managedUsageGuard cover EVERY call in a
// build — contract and patches alike — so the job ceiling is a property of the build, not
// of any single call. All spend lands in the canonical diagnostics tables via diag.step
// (creditsForUsage is the ONE pricing function; nothing here invents a second).

import { generateContract } from "../appBuild/contractAgent.mjs";
import { contractBrief } from "../../../shared/implementationContract.mjs";
import { managedUsageGuard } from "../buildJobs.mjs";
import { expectationKeywords } from "../appBuild/journeyVerifier.mjs";
import { EMIT_PATCHES_SCHEMA } from "./patchEngine.mjs";
import { capabilityBrief } from "./capabilityRegistry.mjs";
import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { retrieve, renderRetrieval } from "./retrieval.mjs";

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
- newFile creates files; never rewrite an existing file via newFile. Ops modify existing files:
  add_import adds an import line (imports are NOT symbols); replace_symbol swaps a component
  wholesale (never append a second default component); replaceFile is for index-opaque files.
- Pages live in src/routes/<Name>.jsx and MUST be registered in src/App.jsx's ROUTES map
  (replace_symbol on the existing map or the App component).
- src/lib/backend/, src/lib/visitorSession.js and src/lib/capabilities/ are protected platform
  infrastructure: IMPORT them, never modify or reimplement them. Persistence goes through the
  capabilities (src/lib/capabilities) — never localStorage. Contact messages, newsletter
  signups and bookings MUST use their capability (submitContact / subscribe / createBooking):
  a raw db.entity(...) write has no session and fails with 401 for anonymous visitors. Any
  other entity mutation must call await ensureVisitorSession() first.
- Imagery: import { ASSETS } from "./lib/assetData.js" (adjust the relative path) and render
  with the helpers in src/lib/assets.js (imageProps / pictureSources / isPlaceholder /
  placeholderStyle). Never hardcode an image URL and never invent one.
- Every user-visible outcome named in the journeys must appear as real, reachable UI text.
- Keep components small; one route file per page plus small shared components.
- BUILD THE WHOLE STEP IN THIS ONE BATCH. A real step is several patches and several
  kilobytes of new JSX: new files for every section/page, real copy, real form state, and
  the App.jsx registration. A batch that re-emits existing content, leaves scaffold stubs
  in place, or only tweaks one line is rejected as a no-op and costs you a round.`;

function renderTreeContext(tree, { extraFullPaths = [] } = {}) {
  const paths = Object.keys(tree).sort();
  const listed = paths.map((p) => `  ${p}`).join("\n");
  const shown = new Set();
  const show = (path) => {
    if (!tree[path] || shown.has(path)) return "";
    shown.add(path);
    return `\n--- ${path} (current content) ---\n${tree[path]}`;
  };
  return [
    "FILE TREE:", listed,
    show("src/App.jsx"),
    show("src/routes/HomePage.jsx"),
    show("src/lib/assetData.js"),
    ...extraFullPaths.map(show),
  ].join("\n");
}

/**
 * WP-12 cost work: edit and repair steps carry RETRIEVAL-SLICED context — the evidence's
 * files in full, neighbours as interfaces, the rest as one-line summaries under a hard
 * 9k-token budget — instead of whole files (the WP-10 edit paid ~8k tokens per round to
 * re-send a monolith page it barely touched).
 */
export function renderScopedContext(tree, { step, editRequest = null, problems = [], journeys = [] } = {}) {
  const graph = memoryGraph("ctx", "ctx", indexTree(tree));
  const evidenceText = step === "edit" ? String(editRequest || "") : problems.join(" ");
  const failureRefs = [...new Set(problems.join("\n").match(/src\/[\w/.-]+\.(?:jsx?|tsx?|css|mjs)/g) || [])];
  const targets = editTargets(tree, evidenceText, { limit: 4 });
  const result = retrieve({ graph, tree, targets, failureRefs, journeys, budgetTokens: 9_000 });
  const paths = Object.keys(tree).sort().map((p) => `  ${p}`).join("\n");
  return [
    "FILE TREE (paths only — retrieval below carries the relevant content):", paths, "",
    renderRetrieval(result, tree),
    tree["src/lib/assetData.js"] ? `\n--- src/lib/assetData.js (current content) ---\n${tree["src/lib/assetData.js"]}` : "",
  ].join("\n");
}

/** Deterministic edit-scope targeting: generated files ranked by request-keyword hits. */
export function editTargets(tree, request, { limit = 3 } = {}) {
  const words = [...new Set(String(request).toLowerCase().match(/[a-z]{4,}/g) || [])];
  return Object.entries(tree)
    .filter(([path]) => /^src\/(routes|components|data)\/.*\.(jsx?|tsx?)$/.test(path))
    .map(([path, source]) => {
      const body = String(source).toLowerCase();
      return { path, hits: words.filter((w) => body.includes(w)).length };
    })
    .filter((f) => f.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((f) => f.path);
}

// The live-proven v1 transition brief (stagePlan.mjs): the verifier snapshots the page
// BEFORE each action and only counts what changed AFTER it; a step passes when ≥ half its
// expectation keywords are visible — NEWLY visible, unless the step is navigational. The
// second live run failed exactly because the builder was never told this contract.
function renderJourneyBrief(journeys) {
  const lines = [
    "JOURNEYS THIS STEP MUST MAKE PASS — a real browser drives every step. The verifier",
    "snapshots the page BEFORE each action and passes the step only when the expected",
    "outcome APPEARS OR CHANGES as a result of the action. Words already present as",
    "static copy count for NOTHING on action steps — a page that always says \"received\"",
    "fails the submit step. Every outcome must be a real state transition:",
    "  - choosing an option: unchosen first; the click adds a visible active/selected state;",
    "  - submitting: the confirmation wording must NOT exist anywhere before submit and must",
    "    render after it — use DISTINCTIVE confirmation copy, not words the page already shows;",
    "  - cancelling or updating: the visible status text changes to the new state;",
    "  - navigation/page-load steps: at least half the listed keywords must be visible on the page.",
    "",
  ];
  for (const journey of journeys) {
    if (!journey) continue;
    lines.push(`JOURNEY — ${journey.title}${journey.priority === "primary" ? " (PRIMARY — the preview is gated on this)" : ""}:`);
    for (const [i, step] of (journey.steps || []).entries()) {
      lines.push(`  ${i + 1}. ACTION: ${step.action}${step.target ? ` (${step.target})` : ""}`);
      lines.push(`     RESULT (must be caused by the action): ${step.expect}`);
      const wanted = expectationKeywords(step.expect);
      if (wanted.length) {
        lines.push(`     the verifier looks for these EXACT words as visible text: [${wanted.join(", ")}] — at least half must be present (newly, unless this step is navigation/page-load)`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderPatchPrompt({ step, contract, tiers, tree, journey, rejections = [], problems = [], editRequest = null }) {
  const isEdit = step === "edit";
  const isRepair = step === "repair";
  const scopedJourneys = step === "core" || isRepair
    ? (contract.journeys || []).filter((j) => tiers.essential.journeys.includes(j.id))
    : isEdit ? (contract.journeys || []) : [journey];
  const parts = [
    `STEP: ${step}`,
    step === "core"
      ? `Build the ESSENTIAL scope only: journeys [${tiers.essential.journeys.join(", ")}], entities [${tiers.essential.entities.join(", ")}]. Secondary work is delivered later as increments — do NOT build it now.`
      : isRepair
        ? "REPAIR: a real browser drove the journeys below against your current tree and the listed steps FAILED with the exact evidence shown. Fix ONLY what the evidence names — the smallest correct patch wins, and everything currently passing must keep passing."
        : isEdit
          ? `Apply EXACTLY this change to the existing app, and nothing else:\n  ${editRequest}\nThe smallest correct patch wins: prefer symbol ops on existing files over rewrites. Every existing journey must KEEP working — do not remove or reword the outcomes they verify.`
          : `Build EXACTLY this one increment: journey "${journey?.id}" (${journey?.title}). Touch nothing else.`,
    "",
    "IMPLEMENTATION CONTRACT:",
    contractBrief(contract),
    "",
    renderJourneyBrief(scopedJourneys),
    isEdit || isRepair
      ? renderScopedContext(tree, { step, editRequest, problems, journeys: scopedJourneys })
      : renderTreeContext(tree),
  ];
  if (rejections.length) {
    parts.push("", "YOUR PREVIOUS PATCH BATCH WAS REJECTED — every reason below is exact; fix and re-emit ALL patches:",
      ...rejections.map((r) => `- ${r.reason}`));
  }
  if (problems.length) {
    parts.push("", "VERIFICATION FAILED on your last tree — fix these and re-emit patches:",
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
// Per-step routing (master plan Part 10, WP-12): one transport model on the Codex lane,
// so the routable lever is REASONING EFFORT — full thinking where design happens, less
// where the step is mechanical. Tuned from live traces as they accumulate.
export const STEP_ROUTING = Object.freeze({
  contract: { reasoningEffort: "medium" },
  core: { reasoningEffort: "medium" },
  repair: { reasoningEffort: "medium" },
  edit: { reasoningEffort: "low" },
  increment: { reasoningEffort: "low" },
});

export function routeForStep(step) {
  const kind = String(step || "").startsWith("increment:") ? "increment" : String(step || "");
  return STEP_ROUTING[kind] || STEP_ROUTING.core;
}

export function createModelLanes({
  provider, ceilingCredits, diag = null, log = () => {},
  bucket = jobUsageBucket(),
}) {
  if (!provider || !ceilingCredits) throw new Error("model lanes need a provider and a ceiling");
  const guard = managedUsageGuard(Number(ceilingCredits), provider.model, bucket);
  // WP-12 trace hierarchy: root = the diag run (the build); every model call is a child
  // span named by its pipeline step. Verification spans join from the runners.
  const record = (step, { label, prompt, output, usage, durationMs }) => {
    try {
      diag?.step({
        agent: "BuilderV2", kind: "agent", label: `${step}: ${label}`, status: "info",
        prompt, output, usage, model: provider.model, durationMs,
        trace: { traceId: diag?.id || null, parentId: diag?.id || null, step },
      });
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

    patchesFn: async ({ step, contract, tiers, tree, journey, rejections, problems, editRequest }) => {
      const prompt = renderPatchPrompt({ step, contract, tiers, tree, journey, rejections, problems, editRequest });
      const systemPrompt = `${PATCH_SYSTEM_PROMPT}\n\nAVAILABLE CAPABILITIES (import, never rewrite):\n${capabilityBrief()}`;
      const startedAt = Date.now();
      const turn = await provider.runTurn({
        systemPrompt,
        messages: [{ role: "user", content: prompt }],
        tools: [EMIT_PATCHES_SCHEMA],
        toolChoice: { type: "function", name: EMIT_PATCHES_SCHEMA.name },
        // The first live run produced an 82-token no-op with zero reasoning; a forced tool
        // call still needs thinking room — how much is the per-step routing table's call.
        reasoningEffort: routeForStep(step).reasoningEffort,
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
