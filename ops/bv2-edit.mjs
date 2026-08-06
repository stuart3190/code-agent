// WP-10 / V2-18 — SPEND GATE 2: the FIRST live Builder v2 EDIT. Runs EXACTLY ONE edit
// against the WP-9 green project through the v2 edit path (adopt → patch → gate →
// differential verify → atomic promotion) on the Codex lane. Target ≤0.5 credits, hard
// ceiling 2. No contract call, no asset search — everything persistent is resumed.
//
//   node ops/bv2-edit.mjs                # dry preflight
//   node ops/bv2-edit.mjs --live        # the ONE approved edit

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { createModelLanes } from "../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator, supabaseBuildStore } from "../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import { supabaseSnapshotStorage } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { createAssetService } from "../shell/server/lib/builderV2/assets/assetService.mjs";
import { pexelsProvider } from "../shell/server/lib/builderV2/assets/pexelsProvider.mjs";
import { supabaseVerificationCache, verifyJourneysAttributed } from "../shell/server/lib/builderV2/verification.mjs";
import { startDiagSessionSafe } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";
import { buildTree, ensureDeps, depsNodeModules } from "../harness/workspace.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { creditsForUsage } from "../src/billing/costModel.mjs";

const CEILING_CREDITS = 2;      // hard stop (WP-10)
const TARGET_CREDITS = 0.5;     // edit target (projected 0.15-0.4; labels per C5)

// The WP-9 green project and the diag run that holds its contract.
const PROJECT_ID = "78c3ce56-48b3-41d9-8879-d88f48dcb7eb";
const BUILD_DIAG = "143b0d95-e1b8-4c41-acc5-5b18992efe8f";

const EDIT_REQUEST = `Add the studio phone number 0117 946 0000 to the contact section,
visibly displayed near the contact form with a short label such as "Call the studio".
Change nothing else.`;

const live = process.argv.includes("--live");
const log = (line) => console.log(`[bv2-edit] ${line}`);
const client = serviceClient();

// Owner + contract come from the persisted build — no model involvement.
const { data: codexRows } = await client.from("ca_ai_credentials").select("owner").eq("provider", "codex").limit(1);
const owner = codexRows?.[0]?.owner;
if (!owner) { console.error("no codex-connected owner"); process.exit(1); }
const { data: contractStep } = await client.from("diag_steps").select("output")
  .eq("run_id", BUILD_DIAG).eq("kind", "agent").like("label", "contract%").limit(1).maybeSingle();
const contract = JSON.parse(contractStep.output);
log(`owner: ${owner} · project: ${PROJECT_ID}`);
log(`contract: ${contract.journeys.length} journeys (from build diag ${BUILD_DIAG})`);
log(`ceiling ${CEILING_CREDITS} (hard) · target ≤${TARGET_CREDITS} (projected 0.15-0.4)`);
if (!live) { log("DRY RUN — pass --live to run the ONE approved edit."); process.exit(0); }

await ensureDeps();
const provider = createCodexProvider();
const diag = await startDiagSessionSafe({
  owner, projectId: PROJECT_ID, kind: "app_edit_v2", prompt: EDIT_REQUEST, model: provider.model,
});
diag.setByok(true);
log(`diag run: ${diag.id}`);

const lanes = createModelLanes({ provider, ceilingCredits: CEILING_CREDITS, diag, log });
const previews = previewProvider();
let previewStarted = false;
let previewUrl = null;

const orchestrator = createOrchestrator({
  contractFn: async () => { throw new Error("an edit never calls the contract model"); },
  patchesFn: lanes.patchesFn,
  assetService: createAssetService({ providers: [pexelsProvider()] }),
  snapshotStore: createSnapshotStore(supabaseSnapshotStorage()),
  buildStore: supabaseBuildStore(),
  verificationCache: supabaseVerificationCache(client),
  journeysFn: async ({ tree, journeys, graph }) => {
    const runtime = withRuntimeEnv(tree, PROJECT_ID);
    const preview = previewStarted ? await previews.update(PROJECT_ID, runtime) : await previews.start(PROJECT_ID, runtime);
    previewStarted = true;
    previewUrl = preview?.url || previewUrl;
    if (!preview?.url) return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: "fail" })) };
    log(`verifying ${journeys.length} journey(s) against ${preview.url}`);
    const result = await verifyJourneysAttributed({ previewUrl: preview.url, contract: { ...contract, journeys }, graph, timeoutMs: 240_000 });
    try {
      diag.step({
        agent: "BuilderV2", kind: "verification",
        label: `journeys: ${result.journeys.map((j) => `${j.id}=${j.status}`).join(" ")}`,
        status: result.journeys.some((j) => j.status === "fail") ? "failed" : "passed",
        output: JSON.stringify({ journeys: result.journeys, consoleErrors: result.consoleErrors, failedRequests: result.failedRequests }),
      });
    } catch { /* diagnostics never block */ }
    for (const j of result.journeys) for (const s of j.steps || []) log(`  ${j.id} · ${String(s.action || "").slice(0, 55)} → ${s.status}${s.detail ? ` — ${s.detail}` : ""}`);
    return { journeys: result.journeys };
  },
  compile: async (candidate) => buildTree(withRuntimeEnv(candidate, PROJECT_ID), "bv2_edit", () => {}),
  baseTree: () => clone(fromScaffold(REACT_VITE)),
  baseline: REACT_VITE,
  extraGateOptions: { nodeModules: depsNodeModules(), log },
  log,
});

const startedAt = Date.now();
let result;
try {
  result = await orchestrator.runEdit({ owner, projectId: PROJECT_ID, request: EDIT_REQUEST, contract });
} finally {
  try { if (previewStarted) await previews.stop(PROJECT_ID); } catch { /* best-effort */ }
}

const usage = lanes.bucket.summary();
const measured = creditsForUsage({ usage, model: provider.model });
await diag.finish(result.state === "green" ? "passed" : "failed");
const { data: aiRows } = await client.from("ai_requests").select("cost").eq("build_id", diag.id).eq("owner", owner);
const durable = (aiRows || []).reduce((t, r) => t + Number(r.cost || 0), 0);

console.log("\n===== WP-10 MEASURED RESULT =====");
console.log(`state:            ${result.state}`);
console.log(`credits MEASURED: ${measured.toFixed(2)} (bucket) / ${durable.toFixed(2)} (ai_requests)`);
console.log(`vs TARGET ≤${TARGET_CREDITS} · ceiling ${CEILING_CREDITS}`);
console.log(`tokens: in ${usage.input} (cached ${usage.cached}) out ${usage.output} reasoning ${usage.reasoning}`);
console.log(`wall clock: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
console.log(`diag run: ${diag.id} · bv2 build: ${result.buildId}`);
console.log(`snapshot: ${result.snapshotId || "none"} (parent ${result.parentSnapshotId || "n/a"})`);
console.log(`drove: ${JSON.stringify(result.drove || [])} · reused: ${JSON.stringify(result.reused || [])}`);
if (result.error) console.log(`error: ${result.error}`);
if (previewUrl) console.log(`preview: ${previewUrl}`);
process.exit(result.state === "green" ? 0 : 1);
