// WP-11 / V2-19 — SPEND GATE 3: the definitive v1-vs-v2 head-to-head. ONE booking build
// on the EXACT stored production prompt (diag 689e49e1 / the 24.26→46.10→32.65 fixture),
// Codex lane, hard ceiling 9. Targets: ≤6 credits core-green, ≤9 full (projected 3-5 core
// per the master plan; labels per C5). Includes the V2-20 repair tier and the D4
// backend-row probe (a booking row must REALLY exist after the browser journey).
//
//   node ops/bv2-booking-build.mjs           # dry preflight
//   node ops/bv2-booking-build.mjs --live    # the ONE approved build

import crypto from "node:crypto";
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

const CEILING_CREDITS = 9;       // hard stop (WP-11)
const TARGET_CORE = 6;           // core-green target
const TARGET_FULL = 9;           // full-delivery target
const V1_BASELINES = "v1 measured on this prompt: 24.26 (blocked) · 46.10 (blocked) · 32.65 (blocked)";

// The EXACT stored production prompt (diag 689e49e1) — byte-for-byte.
const REQUEST = `Build a complete polished web application for a pick-your-own strawberry farm called “Berry Brook Farm.” It is a customer-facing seasonal farm website and booking system where visitors reserve a timed slot to pick strawberries in the field.

Brand and visual direction: premium but approachable countryside feel. Use rich strawberry red, leaf green, cream, warm pale pink, and dark soil-brown accents. Editorial serif headings paired with clean sans-serif body text. Include subtle illustrated strawberry/leaf motifs and farm-field imagery or tasteful visual placeholders. The design should feel sunny, local, wholesome, and easy for families to use—not corporate.

Pages / flows:
1. Home page: full hero with farm announcement (“Strawberry season is here”), seasonal status, prominent Book a picking slot CTA, short intro, how it works (choose date/time, check in, pick and pay by weight), farm highlights, practical visitor information (location, parking, accessibility, dogs/picnics policy), testimonials, and newsletter signup.
2. Booking page: an intuitive, multi-step reservation experience. Let customers choose an available date from the next several weeks, select a timed 90-minute picking slot, choose number of adults and children, and enter name/email/phone. Show real-time availability indicators, a clear booking summary, price messaging (reservation deposit / entry fee and strawberries paid by weight), farm terms checkbox, and a polished confirmation state with booking reference, arrival instructions, and an add-to-calendar-style action. Seed realistic availability and make the booking interaction functional entirely in the app, including preventing slots from being booked beyond capacity.
3. Visit page: opening hours, what to bring, field etiquette, weather guidance, accessibility and directions with a map-style visual.
4. Our Farm page: story, sustainable growing practices, and team/farm photography-style panels.
5. Booking management entry point: visitors can look up a reservation using booking reference and email, displaying their booking and a simple cancel option. Keep booking state persisted locally so a newly created reservation can be retrieved in this demo.

Navigation: home, book now, plan your visit, our farm; mobile responsive menu. Persistent book CTA in header. Footer with farm contact details, social links, policies and seasonal note.

Make all interactions feel complete: navigation, date and slot selection, validation, booking confirmation, booking lookup/cancellation, and responsive layouts. Do not require external payments or real external APIs; label payment as on-arrival where appropriate. Use accessible controls, good focus states, semantic content, and thoughtful empty/error states. Verify the primary customer booking path works before presenting the preview.`;

const live = process.argv.includes("--live");
const log = (line) => console.log(`[bv2-booking] ${line}`);
const client = serviceClient();

const { data: codexRows } = await client.from("ca_ai_credentials").select("owner").eq("provider", "codex").limit(1);
const owner = codexRows?.[0]?.owner;
if (!owner) { console.error("no codex-connected owner"); process.exit(1); }
const projectId = crypto.randomUUID();
const pexels = pexelsProvider();
const runStartIso = new Date().toISOString();

log(`owner: ${owner} · project: ${projectId}`);
log(`ceiling ${CEILING_CREDITS} (hard) · targets ≤${TARGET_CORE} core / ≤${TARGET_FULL} full · ${V1_BASELINES}`);
log(`pexels configured: ${pexels.configured()}`);
if (!live) { log("DRY RUN — pass --live to run the ONE approved build."); process.exit(0); }

await ensureDeps();
const provider = createCodexProvider();
const diag = await startDiagSessionSafe({ owner, projectId, kind: "app_build_v2", prompt: REQUEST, model: provider.model });
diag.setByok(true);
log(`diag run: ${diag.id}`);

const lanes = createModelLanes({ provider, ceilingCredits: CEILING_CREDITS, diag, log });
const previews = previewProvider();
let previewStarted = false;
let previewUrl = null;
let coreGreenCredits = null;
const contractRef = { current: null };

const orchestrator = createOrchestrator({
  contractFn: async (args) => { contractRef.current = await lanes.contractFn(args); return contractRef.current; },
  patchesFn: lanes.patchesFn,
  assetService: createAssetService({ providers: [pexels] }),
  snapshotStore: createSnapshotStore(supabaseSnapshotStorage()),
  buildStore: supabaseBuildStore(),
  verificationCache: supabaseVerificationCache(client),
  journeysFn: async ({ tree, journeys, graph }) => {
    const runtime = withRuntimeEnv(tree, projectId);
    const preview = previewStarted ? await previews.update(projectId, runtime) : await previews.start(projectId, runtime);
    previewStarted = true;
    previewUrl = preview?.url || previewUrl;
    if (!preview?.url) return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: "fail" })) };
    log(`verifying ${journeys.length} journey(s) against ${preview.url}`);
    const result = await verifyJourneysAttributed({ previewUrl: preview.url, contract: { ...contractRef.current, journeys }, graph, timeoutMs: 300_000 });
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
  // D4: after the browser says the booking happened, the DATABASE must agree.
  backendProbeFn: async ({ contract }) => {
    const primary = (contract.journeys || []).find((j) => j.priority === "primary");
    const { data, error } = await client.from("entities").select("id")
      .eq("app_id", projectId).eq("type", "booking").gte("created_at", runStartIso).limit(1);
    if (error) { log(`backend probe unavailable (${error.message}) — not counted against the build`); return []; }
    return data?.length ? [] : [{ journeyId: primary?.id, detail: "no booking row exists in entities for this app since the run began" }];
  },
  compile: async (candidate) => buildTree(withRuntimeEnv(candidate, projectId), "bv2_booking", () => {}),
  baseTree: () => clone(fromScaffold(REACT_VITE)),
  baseline: REACT_VITE,
  maxCoreAttempts: 4, // medium profile (Part 4): det → 2 targeted → 1 regen-class round
  extraGateOptions: { nodeModules: depsNodeModules(), log },
  log: (line) => {
    if (/^core green:/.test(line) && coreGreenCredits === null) {
      coreGreenCredits = creditsForUsage({ usage: lanes.bucket.summary(), model: provider.model });
    }
    log(line);
  },
});

const startedAt = Date.now();
let result;
try {
  result = await orchestrator.runBuild({ owner, projectId, request: REQUEST, profile: "medium" });
} finally {
  try { if (previewStarted) await previews.stop(projectId); } catch { /* best-effort */ }
}

const usage = lanes.bucket.summary();
const fullCredits = creditsForUsage({ usage, model: provider.model });
await diag.finish(result.state === "green" ? "passed" : "failed");
const { data: aiRows } = await client.from("ai_requests").select("cost").eq("build_id", diag.id).eq("owner", owner);
const durable = (aiRows || []).reduce((t, r) => t + Number(r.cost || 0), 0);

console.log("\n===== WP-11 MEASURED RESULT =====");
console.log(`state:              ${result.state}`);
console.log(`credits CORE-GREEN: ${coreGreenCredits === null ? "never reached" : coreGreenCredits.toFixed(2)} (target ≤${TARGET_CORE})`);
console.log(`credits FULL:       ${fullCredits.toFixed(2)} (bucket) / ${durable.toFixed(2)} (ai_requests) (target ≤${TARGET_FULL}, ceiling ${CEILING_CREDITS})`);
console.log(`${V1_BASELINES}`);
console.log(`tokens: in ${usage.input} (cached ${usage.cached}) out ${usage.output} reasoning ${usage.reasoning}`);
console.log(`wall clock: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
console.log(`diag run: ${diag.id} · bv2 build: ${result.buildId}`);
console.log(`snapshot: ${result.snapshotId || "none"} · core snapshot: ${result.coreSnapshotId || "none"}`);
console.log(`shipped increments: ${(result.shipped || []).join(", ") || "none"}`);
console.log(`pending increments: ${JSON.stringify(result.pendingIncrements || [])}`);
if (result.error) console.log(`error: ${result.error}`);
if (previewUrl) console.log(`preview: ${previewUrl}`);
process.exit(result.state === "green" ? 0 : 1);
