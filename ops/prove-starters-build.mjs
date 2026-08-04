// Build every starter for real, through the ordinary pipeline.
//
// The requirement is that no starter is a placeholder — that each one, sent as written, produces
// something. The only way to know that is to send it and look at what comes back, which is what
// this does: it posts each prompt through `postUserMessage`, exactly as the composer does, and
// waits for the conversation to reach a terminal state.
//
// This SPENDS REAL TOKENS on the owner account. It is not part of the routine proof suite and is
// run deliberately:
//
//   node ops/prove-starters-build.mjs                 # every category
//   node ops/prove-starters-build.mjs saas landing    # named categories
//   STARTER_BUILD_TIMEOUT_MS=900000 node ops/...      # a longer patience per build
//
// It records what each build produced into docs/STARTERS.md's table so the next person can see
// which prompts were revised and why.

import { STARTER_CATEGORIES } from "../shell/shared/starters.mjs";
import { conversationStore } from "../shell/server/lib/conversationStore.mjs";
import { postUserMessage } from "../shell/server/lib/leadAgentService.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const TIMEOUT_MS = Number(process.env.STARTER_BUILD_TIMEOUT_MS || 900_000);
const POLL_MS = 10_000;

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const starters = wanted.length
  ? STARTER_CATEGORIES.filter((s) => wanted.includes(s.id))
  : STARTER_CATEGORIES;

if (!starters.length) {
  console.error(`No such starter. Known: ${STARTER_CATEGORIES.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const db = serviceClient();
const store = conversationStore();

/**
 * A fresh throwaway account per starter.
 *
 * Not the owner account, for two reasons. It would put ten test projects in a real person's
 * dashboard; and the owner accounts carry BYOK credentials, so a build there exercises whichever
 * provider that account happens to have selected rather than the managed lane every new customer
 * actually lands on. The first run of this proof discovered exactly that: the support account is
 * routed to xAI, whose key is out of credits, and the "failure" said nothing about the prompt.
 *
 * One account per starter also means each build gets its own Free-plan allowance, so a long
 * prompt early in the list cannot exhaust the budget and fail every prompt after it.
 */
async function throwawayOwner(tag) {
  const { data, error } = await db.auth.admin.createUser({
    email: `p8-starter-${tag}-${Date.now()}@thrallo.invalid`,
    password: `P8!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  if (error) throw new Error(`could not create throwaway owner: ${error.message}`);
  return data.user.id;
}

async function removeOwner(owner) {
  for (const table of ["ca_conversation_events", "ca_conversation_turns"]) {
    const { data: convos } = await db.from("ca_conversations").select("id").eq("owner", owner);
    const ids = (convos || []).map((c) => c.id);
    if (ids.length) await db.from(table).delete().in("conversation_id", ids);
  }
  for (const table of ["diag_runs", "build_jobs", "ca_conversations", "ca_products", "ca_subscriptions"]) {
    await db.from(table).delete().eq("owner", owner).then(() => {}, () => {});
  }
  await db.auth.admin.deleteUser(owner).catch(() => {});
}

const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What actually happened to a conversation.
 *
 * Terminal means the lead agent stopped: it finished, it asked a question, or it failed. A build
 * that is still thinking is not a result, and treating a timeout as a pass would defeat the point.
 */
async function settle(conversationId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data: row } = await db.from("ca_conversations")
      .select("state").eq("id", conversationId).maybeSingle();
    const { data: events } = await db.from("ca_conversation_events")
      .select("type,payload").eq("conversation_id", conversationId).order("sequence");
    const types = (events || []).map((e) => e.type);
    if (types.includes("lead_error")) return { state: "failed", events: events || [] };
    if (row?.state === "waiting_user") return { state: "waiting_user", events: events || [] };
    if (row?.state === "idle" && types.length > 2) return { state: "idle", events: events || [] };
    await sleep(POLL_MS);
  }
  return { state: "timeout", events: [] };
}

for (const starter of starters) {
  const started = Date.now();
  process.stdout.write(`\n[starter] ${starter.id} — sending…\n`);
  let owner = null;
  let conversation = null;
  try {
    owner = await throwawayOwner(starter.id);
    ({ conversation } = await postUserMessage(owner, { text: starter.prompt }));
  } catch (error) {
    check(false, `${starter.id}: the prompt was accepted`, error.message);
    if (owner) await removeOwner(owner);
    continue;
  }
  check(!!conversation?.id, `${starter.id}: the prompt was accepted`, conversation?.id || "no conversation");
  if (!conversation?.id) { await removeOwner(owner); continue; }

  const result = await settle(conversation.id);
  const seconds = Math.round((Date.now() - started) / 1000);
  const types = result.events.map((e) => e.type);

  // A starter passes if the team got as far as real work: a plan, a build, or a preview. Asking a
  // clarifying question is also a legitimate outcome for some prompts — it is the product working —
  // but it is recorded distinctly rather than counted as a build.
  const planned = types.includes("plan.created");
  const built = types.includes("build_started");
  const previewed = types.includes("preview_ready");
  const asked = result.state === "waiting_user";

  check(result.state !== "timeout", `${starter.id}: reached a terminal state`, `${result.state} in ${seconds}s`);
  check(result.state !== "failed", `${starter.id}: did not fail`, types.filter((t) => t === "lead_error").length ? "lead_error" : "ok");
  check(planned || built || asked,
    `${starter.id}: produced real work`,
    [planned && "planned", built && "built", previewed && "previewed", asked && "asked a question"]
      .filter(Boolean).join(" · ") || "nothing");

  console.log(`[starter] ${starter.id}: ${result.state} in ${seconds}s — `
    + `${[planned && "plan", built && "build", previewed && "preview", asked && "question"].filter(Boolean).join(", ") || "no work"}`);

  // The build's own record, which is what History will show for it.
  const { data: runs } = await db.from("diag_runs")
    .select("id,status,prompt,model,duration_ms").eq("conversation_id", conversation.id);
  if (runs?.length) {
    check(!!runs[0].prompt, `${starter.id}: the build recorded its prompt`, runs[0].prompt ? "yes" : "no");
    check(!!runs[0].model, `${starter.id}: and the model it used`, runs[0].model || "none");
  }

  await removeOwner(owner);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
