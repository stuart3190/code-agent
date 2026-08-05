// WP-9 / V2-17 — SPEND GATE 1: the FIRST live Builder v2 build. Runs EXACTLY ONE simple
// build (landing + contact class) through the v2 orchestrator on the Codex lane with a
// hard 5-credit ceiling (target ≤2 first-green, projected 0.9-1.8 — labels per C5).
//
//   node ops/bv2-first-build.mjs           # dry preflight: prints the plan, spends nothing
//   node ops/bv2-first-build.mjs --live    # the ONE approved run
//
// Every model call flows through ONE shared usage bucket + managedUsageGuard(5); spend is
// read back from the canonical diagnostics (diag totals + ai_requests rows). Assets resolve
// through the real Asset Service (Pexels if PEXELS_API_KEY is configured; deterministic
// branded placeholders otherwise — the build never blocks on imagery). Previews and journey
// verification use the SAME production machinery v1 uses.

import crypto from "node:crypto";
import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { createModelLanes } from "../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator, supabaseBuildStore } from "../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import { supabaseSnapshotStorage } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { createAssetService } from "../shell/server/lib/builderV2/assets/assetService.mjs";
import { pexelsProvider } from "../shell/server/lib/builderV2/assets/pexelsProvider.mjs";
import { createOptimiser } from "../shell/server/lib/builderV2/assets/optimiser.mjs";
import { supabaseVerificationCache, verifyJourneysAttributed } from "../shell/server/lib/builderV2/verification.mjs";
import { startDiagSessionSafe } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";
import { buildTree, ensureDeps, depsNodeModules } from "../harness/workspace.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { creditsForUsage } from "../src/billing/costModel.mjs";

const CEILING_CREDITS = 5;      // hard stop (WP-9)
const TARGET_CREDITS = 2;       // first-green target (projected 0.9-1.8; both labels C5)

const REQUEST = `Build a landing page with a contact form for "Harbor & Sage", a two-person
interior design studio in Bristol. Sections: a hero with a strong headline and short
subheading, a services overview with three services (room styling, full renovations,
colour consultations), a short about-the-studio section, and a contact form (name, email,
message) that clearly confirms the message was received. One elegant page plus whatever
navigation it needs.`;

const live = process.argv.includes("--live");
const log = (line) => console.log(`[bv2-first] ${line}`);

// ── preflight ─────────────────────────────────────────────────────────────────────────────────

const client = serviceClient();
const { data: codexRows, error: credError } = await client.from("ca_ai_credentials")
  .select("owner").eq("provider", "codex").limit(2);
if (credError) { console.error(`credential lookup failed: ${credError.message}`); process.exit(1); }
if (!codexRows?.length) { console.error("no Codex-connected owner found"); process.exit(1); }
const owner = codexRows[0].owner;
const projectId = crypto.randomUUID();
const pexels = pexelsProvider();

log(`owner (codex-connected): ${owner}`);
log(`dedicated project id:    ${projectId}`);
log(`ceiling ${CEILING_CREDITS} credits (hard) · target ≤${TARGET_CREDITS} first-green (projected 0.9-1.8)`);
log(`pexels configured: ${pexels.configured()} ${pexels.configured() ? "" : "— placeholder lane (build never blocks on imagery)"}`);
log(`preview mode: ${process.env.PREVIEW_MODE || "local"}`);

if (!live) { log("DRY RUN — pass --live to run the ONE approved build."); process.exit(0); }

// ── assembly: real everything, one shared ceiling ─────────────────────────────────────────────

await ensureDeps();
const provider = createCodexProvider();
const diag = await startDiagSessionSafe({
  owner, projectId, kind: "app_build_v2", prompt: REQUEST, model: provider.model,
});
diag.setByok(true);
log(`diag run: ${diag.id}`);

const lanes = createModelLanes({ provider, ceilingCredits: CEILING_CREDITS, diag, log });
const assetService = createAssetService({
  providers: [pexels],
  optimiser: pexels.configured() ? createOptimiser({}) : null,
});
const snapshotStore = createSnapshotStore(supabaseSnapshotStorage());
const previews = previewProvider();
let previewStarted = false;
let previewUrl = null;
const contractRef = { current: null };

const orchestrator = createOrchestrator({
  contractFn: async (args) => { contractRef.current = await lanes.contractFn(args); return contractRef.current; },
  patchesFn: lanes.patchesFn,
  assetService,
  snapshotStore,
  buildStore: supabaseBuildStore(),
  verificationCache: supabaseVerificationCache(client),
  journeysFn: async ({ tree, journeys, graph }) => {
    const runtime = withRuntimeEnv(tree, projectId);
    const preview = previewStarted
      ? await previews.update(projectId, runtime)
      : await previews.start(projectId, runtime);
    previewStarted = true;
    previewUrl = preview?.url || previewUrl;
    if (!preview?.url) {
      log("preview unavailable — journeys cannot be driven (they will fail closed)");
      return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: "fail" })) };
    }
    log(`verifying ${journeys.length} journey(s) against ${preview.url}`);
    const result = await verifyJourneysAttributed({
      previewUrl: preview.url, contract: { ...contractRef.current, journeys }, graph, timeoutMs: 240_000,
    });
    return { journeys: result.journeys };
  },
  compile: async (candidate) => buildTree(withRuntimeEnv(candidate, projectId), "bv2_first_build", () => {}),
  baseTree: () => clone(fromScaffold(REACT_VITE)),
  baseline: REACT_VITE,
  extraGateOptions: { nodeModules: depsNodeModules(), log },
  log,
});

// ── the ONE build ─────────────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
let result;
try {
  result = await orchestrator.runBuild({ owner, projectId, request: REQUEST, profile: "simple" });
} finally {
  try { if (previewStarted) await previews.stop(projectId); } catch { /* preview teardown is best-effort */ }
}
const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);

// ── measured report (C5: measured vs target vs projected) ─────────────────────────────────────

const usage = lanes.bucket.summary();
const measuredCredits = creditsForUsage({ usage, model: provider.model });
await diag.finish(result.state === "green" ? "passed" : "failed");

const { data: aiRows } = await client.from("ai_requests")
  .select("cost").eq("build_id", diag.id).eq("owner", owner);
const durableCredits = (aiRows || []).reduce((t, r) => t + Number(r.cost || 0), 0);

console.log("\n===== WP-9 MEASURED RESULT =====");
console.log(`state:            ${result.state}`);
console.log(`credits MEASURED: ${measuredCredits.toFixed(2)} (bucket) / ${durableCredits.toFixed(2)} (ai_requests)`);
console.log(`vs TARGET ≤${TARGET_CREDITS} · vs PROJECTED 0.9-1.8 · ceiling ${CEILING_CREDITS}`);
console.log(`tokens: in ${usage.input} (cached ${usage.cached}) out ${usage.output} reasoning ${usage.reasoning}`);
console.log(`wall clock: ${minutes} min`);
console.log(`diag run: ${diag.id}`);
console.log(`bv2 build: ${result.buildId} · snapshot: ${result.snapshotId || "none"}`);
console.log(`provider asset calls: ${result.providerCalls ?? "n/a"}`);
console.log(`shipped increments: ${(result.shipped || []).join(", ") || "none"}`);
console.log(`pending increments: ${JSON.stringify(result.pendingIncrements || [])}`);
if (result.error) console.log(`error: ${result.error}`);
if (previewUrl) console.log(`preview: ${previewUrl}`);
process.exit(result.state === "green" ? 0 : 1);
