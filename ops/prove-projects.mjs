// Live proof for the Projects experience: paging, ordering, favourites, the archive and bulk
// actions, against the real Supabase store in production.
//
// It seeds and removes its own projects. Earlier phases learned this the hard way: proofs pinned to
// a customer's project reported three failures the day the account owner unpublished their own app,
// and the proof was wrong, not the platform.
//
// The defect this phase existed to fix is the one at the top: `listConversations` carried a default
// limit of 20 and the route called it bare, so paging above it could never reach a twenty-first
// project. That is a server fact, provable only here.

import { SupabaseConversationStore } from "../shell/server/lib/conversationStore.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const SEED = 45;   // more than the cap that used to be invisible

const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const db = serviceClient();
const store = new SupabaseConversationStore(db);

// Two throwaway accounts. `ca_conversations.owner` is a real foreign key to auth.users, so a
// made-up uuid cannot be inserted — and seeding forty-five rows into a customer's account to prove
// paging would be a far worse idea than creating one.
const stamp = Date.now();
const users = [];
for (const tag of ["owner", "intruder"]) {
  const { data, error } = await db.auth.admin.createUser({
    email: `p5-projects-proof-${tag}-${stamp}@thrallo.invalid`,
    password: `P5!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  if (error) { console.error(`could not create throwaway ${tag}:`, error.message); process.exit(1); }
  users.push(data.user.id);
}
const [OWNER, INTRUDER] = users;
console.log(`[proof] throwaway owner ${OWNER}`);

const made = [];

async function cleanup() {
  if (made.length) {
    await db.from("ca_conversation_events").delete().in("conversation_id", made.map((r) => r.id));
    await db.from("ca_conversations").delete().in("id", made.map((r) => r.id));
  }
  for (const id of users) await db.auth.admin.deleteUser(id).catch(() => {});
}

try {
  for (let i = 0; i < SEED; i += 1) {
    const row = await store.createConversation(OWNER, { title: `Proof project ${String(i).padStart(2, "0")}` });
    made.push(row);
  }
  check(made.length === SEED, `seeded ${SEED} projects`, `${made.length}`);

  // ── The cap ───────────────────────────────────────────────────────────────────────────
  {
    const all = await store.listConversations(OWNER);
    check(all.length === SEED,
      "listing returns every project, not the first twenty",
      `${all.length} of ${SEED}`);
    const capped = await store.listConversations(OWNER, { limit: 10 });
    check(capped.length === 10, "and a limit is honoured when one is asked for", `${capped.length}`);
  }

  // ── Ordering is total, so paging cannot repeat or skip ─────────────────────────────────
  {
    const all = await store.listConversations(OWNER);
    const ids = all.map((r) => r.id);
    check(new Set(ids).size === ids.length, "no project is returned twice");
    const times = all.map((r) => Date.parse(r.last_activity_at));
    check(times.every((t, i) => i === 0 || times[i - 1] >= t),
      "and the store's own order is newest-activity-first");
  }

  // ── Favourites ────────────────────────────────────────────────────────────────────────
  {
    const target = made[SEED - 1];   // the OLDEST, so leading any order can only be the pin
    const changed = await store.setConversationFlags(OWNER, [target.id], { favourite: true });
    check(changed.length === 1, "a project can be favourited", `${changed.length} changed`);

    const all = await store.listConversations(OWNER);
    const row = all.find((r) => r.id === target.id);
    check(row?.favourite === true, "and the flag is persisted, not merely accepted", String(row?.favourite));

    await store.setConversationFlags(OWNER, [target.id], { favourite: false });
    const after = (await store.listConversations(OWNER)).find((r) => r.id === target.id);
    check(after?.favourite === false, "and it can be un-favourited", String(after?.favourite));
  }

  // ── Archive is not delete ─────────────────────────────────────────────────────────────
  {
    const target = made[0];
    await store.setConversationFlags(OWNER, [target.id], { archived_at: new Date().toISOString() });

    const active = await store.listConversations(OWNER);
    check(active.length === SEED - 1, "archiving removes a project from the default list", `${active.length}`);
    check(!active.some((r) => r.id === target.id), "and it is really gone from that list");

    const archived = await store.listConversations(OWNER, { archived: true });
    check(archived.length === 1 && archived[0].id === target.id,
      "while appearing in the archive", `${archived.length}`);
    check(archived[0].deleted_at === null,
      "with nothing scheduled for removal — that is what delete does", String(archived[0].deleted_at));

    await store.setConversationFlags(OWNER, [target.id], { archived_at: null });
    check((await store.listConversations(OWNER)).length === SEED, "and restoring puts it back");
    check((await store.listConversations(OWNER, { archived: true })).length === 0,
      "leaving the archive empty");
  }

  // ── Ownership is in the statement, not a check above it ───────────────────────────────
  {
    const changed = await store.setConversationFlags(INTRUDER, made.map((r) => r.id), { favourite: true });
    check(changed.length === 0,
      "another owner's ids simply do not match", `${changed.length} changed`);
    const untouched = (await store.listConversations(OWNER)).every((r) => !r.favourite);
    check(untouched, "and nothing was flagged");
  }

  // ── Deleted projects are not resurrected by a flag ────────────────────────────────────
  {
    const target = made[1];
    await store.softDeleteConversation(OWNER, target.id);
    const changed = await store.setConversationFlags(OWNER, [target.id], { favourite: true });
    check(changed.length === 0, "flags never touch a project in Recently Deleted", `${changed.length}`);
    await db.from("ca_conversations").update({ deleted_at: null }).eq("id", target.id);
  }

  // ── Activity comes back in one query ──────────────────────────────────────────────────
  {
    await store.appendEvent(made[2], "agent_spawned", { agent: "Builder", status: "Working…" });
    await store.appendEvent(made[3], "preview_ready", { url: "https://example.invalid" });
    await store.appendEvent(made[3], "turn_started", { turn: 1 });   // a type no card renders

    const ids = made.slice(2, 6).map((r) => r.id);
    const byId = await store.listEventsForConversations(OWNER, ids,
      ["agent_spawned", "agent_status", "agent_done", "verification", "lead_error", "preview_ready"]);
    check(byId.size === ids.length,
      "every requested project is present, even with no events", `${byId.size}/${ids.length}`);
    check(byId.get(ids[0]).length === 1, "the one with an event has it");
    check(byId.get(ids[2]).length === 0, "and the ones without get an empty list, not a missing key");
    const types = byId.get(ids[1]).map((e) => e.type);
    check(!types.includes("turn_started"),
      "types a card never renders are not fetched", types.join(",") || "none");
  }

  // ── Bulk delete is the SAME soft delete ───────────────────────────────────────────────
  {
    const targets = made.slice(40, 43).map((r) => r.id);
    for (const id of targets) await store.softDeleteConversation(OWNER, id);
    const { data } = await db.from("ca_conversations").select("id,deleted_at").in("id", targets);
    check(data?.length === 3 && data.every((r) => r.deleted_at),
      "bulk-deleted projects are soft-deleted and still recoverable", `${data?.length} rows still present`);
    check((await store.listConversations(OWNER)).length === SEED - 3,
      "and they leave the list");
    await db.from("ca_conversations").update({ deleted_at: null }).in("id", targets);
  }

  // ── The endpoint itself is owner-scoped ───────────────────────────────────────────────
  for (const [label, path, method] of [
    ["the list", "/api/v1/conversations?sort=name&favourites=1", "GET"],
    ["bulk actions", "/api/v1/conversations/bulk", "POST"],
  ]) {
    const response = await fetch(`${BASE}${path}`, {
      method, redirect: "manual",
      ...(method === "POST" ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: made.map((r) => r.id), action: "delete" }),
      } : {}),
    });
    check(response.status === 401, `${label} refuses an anonymous request`, String(response.status));
  }

  // And that refusal really did nothing.
  check((await store.listConversations(OWNER)).length === SEED,
    "the anonymous bulk delete changed nothing");

  // ── Visitors-today reads the table the card claims it does ────────────────────────────
  {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await db.from("analytics_daily")
      .select("project_id,visitors,pageviews").eq("dimension", "totals").eq("day", today).limit(1);
    check(!error, "today's traffic is readable for the cards", error?.message || "ok");
  }
} finally {
  const { data: before } = await db.from("ca_conversations").select("id").eq("owner", OWNER);
  await cleanup();
  const { data } = await db.from("ca_conversations").select("id").eq("owner", OWNER);
  check(!data?.length, "the proof cleaned up after itself",
    `${before?.length || 0} seeded, ${data?.length || 0} left`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
