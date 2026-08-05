// The booking-site acceptance fixture, Codex lane only.
//
// The conversational lead agent now (correctly) refuses to run on a Codex connection rather than
// silently rebilling managed credits — so this fixture SKIPS conversation orchestration entirely,
// per the run brief ("skip it or stop clearly"), and dispatches the app_build capability directly
// under the Codex-connected owner. Every quality gate is untouched: this enters the exact same
// startAppBuild the lead agent calls, one step downstream of the chat loop.
//
// Hard stops, enforced live on every poll:
//   - any ai_requests row on a gpt-5.6 managed model
//   - any ai_requests row not billed to the owner's key (byok=false)
//   - any managed ledger debit (ca_usage_records billing_source=managed) after the start mark
// Any of these cancels the job and exits 2 immediately.
//
// SPENDS REAL CODEX ALLOWANCE (never managed credits).
//   BOOKING_OWNER=<codex owner uuid> node ops/prove-booking-codex.mjs

import { startAppBuild } from "../shell/server/lib/appBuild/appBuildService.mjs";
import { conversationStore } from "../shell/server/lib/conversationStore.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { cancelJob } from "../shell/server/lib/buildJobs.mjs";

const ORIGINAL_RUN = process.env.BOOKING_ORIGINAL_RUN || "baa3e8fc-1973-43fb-9ed6-9bf83a18e692";
const TIMEOUT_MS = Number(process.env.BOOKING_TIMEOUT_MS || 2_700_000);
const POLL_MS = 10_000;
const owner = process.env.BOOKING_OWNER;
if (!owner) { console.error("BOOKING_OWNER is required — this fixture never creates accounts."); process.exit(1); }
if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") {
  console.error("Refusing to run: THRALLO_MANAGED_SETTLEMENT_PAUSED must be 1 for this verification.");
  process.exit(1);
}

const db = serviceClient();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the exact prompt, from the original failed run ─────────────────────────────────────────────
const { data: original, error: originalError } = await db
  .from("diag_runs").select("id,prompt").eq("id", ORIGINAL_RUN).maybeSingle();
if (originalError || !original?.prompt) {
  console.error(`Could not read the original prompt: ${originalError?.message || "no row"}`); process.exit(1);
}
console.log(`Prompt from ${original.id.slice(0, 8)} (${original.prompt.length} chars). Owner ${owner.slice(0, 8)} (Codex).`);

// ── pre-run marks for the managed-debit assertions ─────────────────────────────────────────────
const startedIso = new Date().toISOString();
const started = Date.now();

async function managedViolations() {
  const { data: badModel } = await db.from("ai_requests")
    .select("id,model,agent,byok,created_at").eq("owner", owner).gte("created_at", startedIso)
    .or("model.ilike.gpt-5.6%,byok.eq.false");
  const { data: managedDebits } = await db.from("ca_usage_records")
    .select("id,billing_source,input_tokens,output_tokens,metadata,created_at")
    .eq("owner", owner).eq("billing_source", "managed").gte("created_at", startedIso);
  return { badModel: badModel || [], managedDebits: managedDebits || [] };
}

// ── dispatch, one step downstream of the (Codex-refusing) chat loop ────────────────────────────
const store = conversationStore();
const conversation = await store.createConversation(owner, { title: "Codex-only booking verification" });
const emit = (type, payload) => store.appendEvent(conversation, type, payload);
const ctx = { owner, conversation, conversations: store, emit };

let jobId = null;
let verdict = "timeout";
let events = [];
let hardStop = null;

try {
  const dispatched = await startAppBuild(ctx, { description: original.prompt });
  if (dispatched.blocked) {
    console.error(`Build refused before spend: ${dispatched.note}`); process.exit(1);
  }
  jobId = dispatched.jobId;
  console.log(`dispatched — job ${jobId.slice(0, 8)}, build ${dispatched.buildId.slice(0, 8)}, project ${dispatched.projectId.slice(0, 8)}\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastReported = 0;
  let quietTerminalPolls = 0;
  while (Date.now() < deadline) {
    const { data: rows } = await db.from("ca_conversation_events")
      .select("type,payload,sequence").eq("conversation_id", conversation.id).order("sequence");
    events = rows || [];
    if (events.length > lastReported) {
      for (const event of events.slice(lastReported)) {
        const detail = event.payload?.status || event.payload?.agent || event.payload?.text || "";
        console.log(`  ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${event.type}  ${String(detail).replace(/\s+/g, " ").slice(0, 110)}`);
      }
      lastReported = events.length;
    }

    // Live hard-stop sweep: a single managed model call or managed debit ends the run NOW.
    const violations = await managedViolations();
    if (violations.badModel.length || violations.managedDebits.length) {
      hardStop = violations;
      verdict = "hard_stop";
      await cancelJob(owner, jobId).catch(() => {});
      break;
    }

    // Run constraint: at most ONE model-powered verification repair round. A second means the
    // first did not converge — stop with the latest green checkpoint rather than spend more.
    const { data: roundRows } = await db.from("diag_runs")
      .select("repair_rounds").eq("owner", owner).gte("created_at", startedIso);
    const repairRounds = (roundRows || []).reduce((t, r) => t + Number(r.repair_rounds || 0), 0);
    if (repairRounds > 1) {
      hardStop = { repairCap: `repair rounds reached ${repairRounds} — the cap for this run is 1` };
      verdict = "hard_stop";
      await cancelJob(owner, jobId).catch(() => {});
      break;
    }

    if (events.some((e) => e.type === "lead_error")) { verdict = "failed"; break; }

    // Terminal: no diagnostics running for this owner since the start mark, sustained.
    const { data: live } = await db.from("diag_runs")
      .select("id").eq("owner", owner).eq("status", "running").gte("created_at", startedIso);
    const { data: all } = await db.from("diag_runs")
      .select("id").eq("owner", owner).gte("created_at", startedIso);
    if ((all || []).length && !(live || []).length) {
      quietTerminalPolls += 1;
      if (quietTerminalPolls >= 3) { verdict = "done"; break; }
    } else {
      quietTerminalPolls = 0;
    }
    await sleep(POLL_MS);
  }
} catch (error) {
  console.error(`\ndispatch failed: ${error.message}`);
  verdict = "failed";
}

const elapsedMs = Date.now() - started;

// ── the full accounting, read back from durable records ────────────────────────────────────────
const { data: runs } = await db.from("diag_runs")
  .select("id,kind,status,totals,repair_rounds").eq("owner", owner).gte("created_at", startedIso).order("created_at");
const runIds = (runs || []).map((r) => r.id);
const { data: requests } = await db.from("ai_requests")
  .select("id,provider,model,agent,byok,input_tokens,output_tokens,cached_tokens,cost,provider_request_ids,created_at")
  .eq("owner", owner).gte("created_at", startedIso).order("created_at");
const { data: steps } = runIds.length
  ? await db.from("diag_steps").select("run_id,kind,agent,label,status,round").in("run_id", runIds).order("started_at")
  : { data: [] };
const finalViolations = await managedViolations();

const calls = requests || [];
const codexCalls = calls.filter((r) => r.model === "gpt-5.5" && r.byok);
const requestIds = calls.flatMap((r) => r.provider_request_ids || []);
const previewReady = events.some((e) => e.type === "preview_ready");
const byKind = (kind) => (steps || []).filter((s) => s.kind === kind);
const label = (s) => `${s.status === "ok" ? "ok " : s.status.padEnd(3)} ${s.label}`;

console.log("\n──────────────────────────────────────────────────────────────");
console.log("CODEX-ONLY BOOKING VERIFICATION");
console.log(`  outcome              ${verdict}${previewReady ? " (preview delivered)" : ""}`);
console.log(`  wall clock           ${(elapsedMs / 60_000).toFixed(1)} min`);
console.log(`  model calls          ${calls.length} total — ${codexCalls.length} on gpt-5.5 (codex key), ${calls.length - codexCalls.length} anything else`);
for (const r of calls) {
  console.log(`    ${r.created_at.slice(11, 19)}  ${r.model}  byok=${r.byok}  ${r.agent || "?"}  in=${r.input_tokens} out=${r.output_tokens} cached=${r.cached_tokens}  reqIds=${(r.provider_request_ids || []).length}`);
}
console.log(`  provider request ids ${requestIds.length} recorded`);
console.log(`  diagnostic runs      ${(runs || []).map((r) => `${r.kind}:${r.status}`).join(", ") || "none"}`);
console.log(`  repair rounds        ${(runs || []).reduce((t, r) => t + Number(r.repair_rounds || 0), 0)}`);
console.log(`  preflight            ${byKind("preflight").map(label).join(" | ") || "none"}`);
console.log(`  compiles             ${byKind("compiler").map((s) => s.status).join(",") || "none"}`);
console.log(`  deterministic repair ${(steps || []).filter((s) => /deterministic/i.test(s.label || "")).map(label).join(" | ") || "none recorded"}`);
console.log(`  honesty              ${(steps || []).filter((s) => /honesty/i.test(`${s.kind} ${s.label}`)).map(label).join(" | ") || "none recorded"}`);
console.log(`  journeys             ${(steps || []).filter((s) => /journey/i.test(`${s.kind} ${s.label}`)).map(label).join(" | ") || "none recorded"}`);
console.log(`  verification         ${(steps || []).filter((s) => /verif/i.test(`${s.kind} ${s.agent} ${s.label}`)).map(label).join(" | ") || "none recorded"}`);
console.log("  MANAGED SAFETY");
console.log(`    gpt-5.6 / non-byok calls   ${finalViolations.badModel.length}`);
console.log(`    managed ledger debits      ${finalViolations.managedDebits.length}`);
console.log(`    settlement pause           ${process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1" ? "armed throughout" : "NOT ARMED — invalid run"}`);
if (hardStop) {
  console.log(`  HARD STOP DETAIL   ${JSON.stringify(hardStop).slice(0, 500)}`);
}
console.log("──────────────────────────────────────────────────────────────");

const clean = finalViolations.badModel.length === 0 && finalViolations.managedDebits.length === 0;
const pass = verdict === "done" && previewReady && clean;
console.log(`\n${pass ? "PASSED" : "FAILED"} — ${pass
  ? "built, verified, and previewed on Codex alone; zero managed calls, zero managed debits"
  : `run ended ${verdict}${clean ? "" : " WITH MANAGED-LANE VIOLATIONS"}`}`);
process.exit(pass ? 0 : hardStop ? 2 : 1);
