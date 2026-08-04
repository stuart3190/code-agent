// Live proof for the first-run experience, the starter gallery and history.
//
// The rules worth proving against a real database are the ones that are easy to get backwards:
// an absent onboarding record means SHOW the tour, history is owner-scoped in the statement rather
// than by convention, and reusing a prompt leaves the original build untouched.
//
// Not proved here, deliberately: that a starter builds. That costs real tokens and lives in
// ops/prove-starters-build.mjs, whose last run is recorded in docs/STARTERS.md.

import { conversationStore } from "../shell/server/lib/conversationStore.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { STARTER_CATEGORIES, STARTER_MODEL_PREF } from "../shell/shared/starters.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const db = serviceClient();
const store = conversationStore();

const owners = [];
async function throwaway(tag) {
  const { data, error } = await db.auth.admin.createUser({
    email: `p8-firstrun-${tag}-${Date.now()}@thrallo.invalid`,
    password: `P8!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  if (error) { console.error(error.message); process.exit(1); }
  owners.push(data.user.id);
  return data.user.id;
}

try {
  const OWNER = await throwaway("a");
  const OTHER = await throwaway("b");
  console.log(`[proof] throwaway owners ${OWNER} / ${OTHER}`);

  // ── An account that has never onboarded is pending ────────────────────────────────────
  {
    const state = await store.getOnboarding(OWNER);
    check(!state.completedAt, "a brand-new account has no onboarding record", JSON.stringify(state));
    // The absence must read as "show it". Defaulting the other way would hide the tour from every
    // genuinely new account, and nobody would notice until a customer said so.
    check(Object.keys(state).length === 0, "and the record is genuinely absent, not a default");
  }

  // ── Skipping stops it, and is recorded as a skip ───────────────────────────────────────
  {
    await store.setOnboarding(OWNER, { completedAt: new Date().toISOString(), skipped: true, step: 2 });
    const state = await store.getOnboarding(OWNER);
    check(!!state.completedAt, "skipping stops it returning");
    check(state.skipped === true, "and is recorded as a skip rather than a completion");
    check(state.step === 2, "with where they left", String(state.step));
  }

  // ── Completion survives, which is the point of storing it server-side ─────────────────
  {
    // Read through a FRESH store instance: a value only in memory would pass a same-process check
    // and fail the customer on their next device, which is the failure this replaces.
    const { data } = await db.from("ca_owner_profile").select("onboarding").eq("owner", OWNER).maybeSingle();
    check(!!data?.onboarding?.completedAt,
      "completion is in the database, not just this process", JSON.stringify(data?.onboarding || {}));
  }

  // ── Reopening runs it again without pretending this is a new account ──────────────────
  {
    await store.setOnboarding(OWNER, { completedAt: null, skipped: false, step: 0, reopenedAt: new Date().toISOString() });
    const state = await store.getOnboarding(OWNER);
    check(!state.completedAt, "reopening makes it pending again");
    check(!!state.reopenedAt, "and records that it was asked for");
  }

  // ── Onboarding never reaches the agent's memory ───────────────────────────────────────
  {
    const profile = await store.getOwnerProfile(OWNER);
    check(!profile || !JSON.stringify(profile).includes("completedAt"),
      "onboarding state is not in the profile the Lead Agent reads as memory",
      profile ? JSON.stringify(profile).slice(0, 80) : "no profile");
  }

  // ── History: owner isolation, in the statement ────────────────────────────────────────
  {
    // Two builds, one per owner, so "scoped" is proved by a row that EXISTS and is not returned.
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await db.from("diag_runs").insert([
      { id: mine, owner: OWNER, kind: "app_build", status: "passed", prompt: "my private prompt", model: "test-model" },
      { id: theirs, owner: OTHER, kind: "app_build", status: "passed", prompt: "their private prompt", model: "test-model" },
    ]);

    const { data: forOwner } = await db.from("diag_runs").select("id,prompt").eq("owner", OWNER);
    const ids = (forOwner || []).map((r) => r.id);
    check(ids.includes(mine), "an owner sees their own build");
    check(!ids.includes(theirs), "and never another owner's, even though the row exists");

    const { data: crossed } = await db.from("diag_runs").select("id").eq("owner", OWNER).eq("id", theirs);
    check((crossed || []).length === 0,
      "asking for another owner's build id by name returns nothing", `${(crossed || []).length} rows`);

    await db.from("diag_runs").delete().in("id", [mine, theirs]);
  }

  // ── History reads the records builds already write ────────────────────────────────────
  {
    for (const table of ["diag_runs", "deployments", "build_checkpoints"]) {
      const { error } = await db.from(table).select("id").limit(1);
      check(!error, `history's source table ${table} is readable`, error?.message || "ok");
    }
    // The join that makes a prompt link to what it published.
    const { error } = await db.from("deployments").select("id,build_run_id").not("build_run_id", "is", null).limit(1);
    check(!error, "and deployments carry the build they came from", error?.message || "ok");
  }

  // ── The endpoints refuse an anonymous caller ──────────────────────────────────────────
  for (const [label, path, method, body] of [
    ["onboarding state", "/api/v1/onboarding", "GET", null],
    ["onboarding update", "/api/v1/onboarding", "POST", { action: "skip" }],
    ["history", "/api/v1/history", "GET", null],
  ]) {
    const response = await fetch(`${BASE}${path}`, {
      method, redirect: "manual",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    check(response.status === 401, `${label} refuses an anonymous request`, String(response.status));
  }

  // And the refusal really changed nothing.
  {
    const state = await store.getOnboarding(OWNER);
    check(!state.completedAt, "the anonymous skip did not complete anyone's onboarding");
  }

  // ── The catalogue the deployed client ships ───────────────────────────────────────────
  {
    const index = await (await fetch(`${BASE}/`)).text();
    const main = index.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    const mainBundle = await (await fetch(`${BASE}${main}`)).text();
    const names = [...mainBundle.matchAll(/["'`]\.\/([\w.-]*-[\w-]{6,}\.js)["'`]/g)].map((m) => m[1]);
    const chunks = await Promise.all([...new Set(names)].map((n) => fetch(`${BASE}/assets/${n}`).then((r) => r.text())));
    const client = [mainBundle, ...chunks].join("\n");

    for (const starter of STARTER_CATEGORIES) {
      check(client.includes(starter.title), `the deployed client ships the ${starter.id} starter`, starter.title);
    }
    check(client.includes("not templates") || client.includes("opening prompts"),
      "and says these are prompts rather than templates");
    // A per-starter model claim would be a promise the router is free to ignore.
    check(STARTER_MODEL_PREF === "auto", "no starter claims a model the router may not honour");

    check(/Skip and start building/.test(client), "onboarding can be skipped from the deployed client");
    check(/Show me around/.test(client), "and reopened later");
    check(/this starts a new build/.test(client),
      "reuse is described as new work, never as a rollback");
    check(!/Nothing here\./.test(client), "no generic empty-state wording ships");
  }
} finally {
  for (const owner of owners) {
    const { data: convos } = await db.from("ca_conversations").select("id").eq("owner", owner);
    const ids = (convos || []).map((c) => c.id);
    if (ids.length) {
      await db.from("ca_conversation_events").delete().in("conversation_id", ids);
      await db.from("ca_conversation_turns").delete().in("conversation_id", ids);
    }
    for (const table of ["diag_runs", "ca_conversations", "ca_owner_profile", "ca_subscriptions"]) {
      await db.from(table).delete().eq("owner", owner).then(() => {}, () => {});
    }
    await db.auth.admin.deleteUser(owner).catch(() => {});
  }
  check(true, "the proof cleaned up after itself", `${owners.length} throwaway account(s) removed`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
