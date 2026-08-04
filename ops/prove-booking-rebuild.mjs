// The original booking-site request, sent again, unchanged.
//
// This is the acceptance test for PR1-PR3 as a whole. The prompt is read verbatim out of the
// diagnostics row of the run that failed (baa3e8fc) — not retyped, not paraphrased — and sent
// through the ordinary customer path on a fresh account.
//
// It records what the run cost and what it needed from a human, so the result can be set beside
// the failed run rather than merely asserted to be better:
//
//   baa3e8fc  app_build  failed   10.52 credits  1 repair round
//   f00c7950  repair     failed   10.85 credits  1 repair round
//                                 -------------
//                                 21.37 credits, no working project, customer left blocked
//
// SPENDS REAL TOKENS.  node ops/prove-booking-rebuild.mjs

import { postUserMessage } from "../shell/server/lib/leadAgentService.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const ORIGINAL_RUN = process.env.BOOKING_ORIGINAL_RUN || "baa3e8fc-1973-43fb-9ed6-9bf83a18e692";
const TIMEOUT_MS = Number(process.env.BOOKING_TIMEOUT_MS || 1_800_000);
const POLL_MS = 10_000;
const db = serviceClient();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the prompt, from the failed run itself ────────────────────────────────────────────────────
// The full uuid, not the 8-character prefix the diagnostics UI shows: `id` is a uuid column, and
// PostgREST cannot cast it in a filter, so LIKE on a prefix is a type error.
const { data: original, error: originalError } = await db
  .from("diag_runs").select("id,prompt,totals,repair_rounds,status")
  .eq("id", ORIGINAL_RUN).maybeSingle();
if (originalError || !original?.prompt) {
  console.error(`Could not read the original prompt from diag_runs ${ORIGINAL_RUN}: ${originalError?.message || "no row"}`);
  process.exit(1);
}
console.log(`Re-sending the exact prompt from ${original.id.slice(0, 8)} (${original.prompt.length} characters).`);
console.log(`That run: ${original.status}, ${Number(original.totals?.cost || 0).toFixed(2)} credits, ${original.repair_rounds} repair round(s).\n`);

// ── a fresh account, on the managed lane every new customer lands on ───────────────────────────
const { data: created, error: createError } = await db.auth.admin.createUser({
  email: `pipeline-rebuild-${Date.now()}@thrallo.invalid`,
  password: `Pr!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (createError) { console.error(`could not create account: ${createError.message}`); process.exit(1); }
const owner = created.user.id;

async function cleanup() {
  const { data: convos } = await db.from("ca_conversations").select("id").eq("owner", owner);
  const ids = (convos || []).map((c) => c.id);
  for (const table of ["ca_conversation_events", "ca_conversation_turns"]) {
    if (ids.length) await db.from(table).delete().in("conversation_id", ids).then(() => {}, () => {});
  }
  for (const table of ["ca_conversations", "ca_products", "ca_subscriptions"]) {
    await db.from(table).delete().eq("owner", owner).then(() => {}, () => {});
  }
  await db.auth.admin.deleteUser(owner).catch(() => {});
}

const started = Date.now();
// postUserMessage returns the conversation ROW, not its id.
let conversationId = null;
let verdict = "timeout";
let events = [];

try {
  const { conversation } = await postUserMessage(owner, { text: original.prompt });
  conversationId = conversation.id;
  console.log(`sent — conversation ${conversationId.slice(0, 8)}, polling…\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastReported = 0;
  while (Date.now() < deadline) {
    const { data: row } = await db.from("ca_conversations").select("state").eq("id", conversationId).maybeSingle();
    const { data: rows } = await db.from("ca_conversation_events")
      .select("type,payload,sequence").eq("conversation_id", conversationId).order("sequence");
    events = rows || [];
    const types = events.map((e) => e.type);

    if (events.length > lastReported) {
      for (const event of events.slice(lastReported)) {
        const detail = event.payload?.status || event.payload?.agent || event.payload?.text || "";
        console.log(`  ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${event.type}  ${String(detail).replace(/\s+/g, " ").slice(0, 96)}`);
      }
      lastReported = events.length;
    }

    if (types.includes("lead_error")) { verdict = "failed"; break; }
    // waiting_user is the outcome the acceptance criterion forbids: it means a human was needed.
    if (row?.state === "waiting_user") { verdict = "waiting_user"; break; }

    // The conversation returns to idle as soon as the lead agent hands off — the BUILD keeps
    // running for minutes afterwards. Polling on conversation state alone declared victory at 31
    // seconds and then deleted the account out from under the running job.
    if (row?.state === "idle" && types.length > 2) {
      const { data: live } = await db.from("diag_runs")
        .select("id,status").eq("owner", owner).eq("status", "running");
      if (!live?.length) { verdict = "idle"; break; }
    }
    await sleep(POLL_MS);
  }

  const elapsedMs = Date.now() - started;

  // ── what it actually cost, read from the diagnostics this run wrote ──────────────────────────
  const { data: runs } = await db.from("diag_runs")
    .select("id,kind,status,totals,repair_rounds,plan").eq("owner", owner).order("created_at");
  const credits = (runs || []).reduce((total, r) => total + Number(r.totals?.cost || 0), 0);
  const repairs = (runs || []).reduce((total, r) => total + Number(r.repair_rounds || 0), 0);

  const { data: requests } = await db.from("ai_requests").select("id").eq("owner", owner);
  const { data: steps } = await db.from("diag_steps")
    .select("kind,status,label,run_id").in("run_id", (runs || []).map((r) => r.id).concat(["none"]));

  const preflights = (steps || []).filter((s) => s.kind === "preflight");
  const compiles = (steps || []).filter((s) => s.kind === "compiler");
  const previewReady = events.some((e) => e.type === "preview_ready");

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("THIS RUN");
  console.log(`  outcome            ${verdict}${previewReady ? " (preview delivered)" : ""}`);
  console.log(`  wall clock         ${(elapsedMs / 60_000).toFixed(1)} min`);
  console.log(`  credits            ${credits.toFixed(2)}`);
  console.log(`  model calls        ${(requests || []).length}`);
  console.log(`  repair rounds      ${repairs}`);
  console.log(`  diagnostic runs    ${(runs || []).map((r) => `${r.kind}:${r.status}`).join(", ") || "none"}`);
  console.log(`  preflight steps    ${preflights.length}${preflights.length ? ` (${preflights.filter((s) => s.status === "ok").length} clean)` : ""}`);
  console.log(`  compiles           ${compiles.length} (${compiles.filter((s) => s.status === "ok").length} passed)`);
  console.log(`  customer needed    ${verdict === "waiting_user" ? "YES" : "no"}`);
  console.log("\nTHE FAILED RUNS, for comparison");
  console.log("  baa3e8fc app_build failed   10.52 credits   1 repair round");
  console.log("  f00c7950 repair    failed   10.85 credits   1 repair round");
  console.log("  total                       21.37 credits   no working project");
  console.log("─────────────────────────────────────────────────────────────");

  const pass = verdict === "idle" && previewReady;
  console.log(`\n${pass ? "PASSED" : "FAILED"} — the booking site ${pass ? "built unattended" : `did not complete (${verdict})`}`);
  await cleanup();
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error(`\nrun failed: ${error.message}`);
  await cleanup();
  process.exit(1);
}
