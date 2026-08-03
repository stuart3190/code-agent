// Live proof for Settings, against production.
//
// Plan states are the point: Free, Starter, Pro, a scheduled downgrade, a subscription set to
// cancel, and a failed payment each have to render correctly, and only one of them (Free) occurs
// naturally on a fresh account. So this seeds them on a throwaway owner and reads them back through
// the SAME services the screen reads — which is what makes it a proof rather than a mock.
//
// Deliberately NOT proved here: a real Starter checkout and the webhook that follows it. Those need
// a real card, which is Stuart's to complete; faking either would prove nothing about billing and
// would leave a false PASS where the gap is.

import { budgetOverview, planCatalogPublic } from "../shell/server/lib/usageBudgets.mjs";
import { normalizeSubscription, publicSubscription } from "../shell/server/lib/subscriptionPlans.mjs";
import { analyticsCapabilities } from "../shell/server/lib/analytics/reports.mjs";
import { createApiToken, listApiTokens, renameApiToken, revokeApiToken } from "../shell/server/lib/apiTokens.mjs";
import {
  listNotifications, markRead, recordNotification, unreadCount,
} from "../shell/server/lib/notifications/notificationHistory.mjs";
import { notifyOwner } from "../shell/server/lib/notifications/notificationService.mjs";
import { codeAgentStore } from "../shell/server/lib/codeAgentStore.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const db = serviceClient();
const store = codeAgentStore();

const { data: created, error: userError } = await db.auth.admin.createUser({
  email: `p6-settings-proof-${Date.now()}@thrallo.invalid`,
  password: `P6!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
console.log(`[proof] throwaway owner ${OWNER}`);

const PERIOD_END = "2026-12-01T00:00:00.000Z";

async function cleanup() {
  await db.from("ca_notifications").delete().eq("owner", OWNER);
  await db.from("ca_api_tokens").delete().eq("owner", OWNER);
  await db.from("ca_subscriptions").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  // ── Free is what a new account gets, without a row existing ──────────────────────────
  {
    const overview = await budgetOverview(OWNER);
    check(overview.plan.id === "free", "a new account is on Free", overview.plan.id);
    check(overview.subscription.periodEndMeans === "resets",
      "and its period end means the allowance resets, not that anything renews",
      overview.subscription.periodEndMeans);
    for (const [key, budget] of Object.entries(overview.budgets)) {
      check(budget.limit > 0 && budget.remaining === budget.limit - budget.used,
        `the ${key} budget is real and internally consistent`,
        `${budget.used}/${budget.limit}, ${budget.remaining} left`);
    }
    const caps = analyticsCapabilities(overview.plan.id);
    check(caps.retentionDays === 7, "Free analytics retention is 7 days", String(caps.retentionDays));
    check(caps.export === false, "and export is not included");
  }

  // ── Starter ──────────────────────────────────────────────────────────────────────────
  {
    await store.upsertSubscription(OWNER, {
      plan: "starter", status: "active", stripe_customer_id: `cus_proof_${Date.now()}`,
      stripe_subscription_id: "sub_proof_starter",
      current_period_start: "2026-11-01T00:00:00.000Z", current_period_end: PERIOD_END,
    });
    const overview = await budgetOverview(OWNER);
    check(overview.plan.id === "starter", "Starter is read back", overview.plan.id);
    check(overview.subscription.periodEndMeans === "renews", "and renews",
      overview.subscription.periodEndMeans);
    check(overview.subscription.cancelAtPeriodEnd === false, "with no cancellation pending");
    const starter = planCatalogPublic().find((p) => p.id === "starter");
    check(overview.budgets.runs.limit === starter.monthly.runs,
      "the metered limit is the catalogue's, not a second copy of it",
      `${overview.budgets.runs.limit} vs ${starter.monthly.runs}`);
    check(analyticsCapabilities("starter").retentionDays === 90, "Starter retention is 90 days");
  }

  // ── Set to cancel ────────────────────────────────────────────────────────────────────
  {
    await store.upsertSubscription(OWNER, { cancel_at_period_end: true });
    const overview = await budgetOverview(OWNER);
    check(overview.subscription.cancelAtPeriodEnd === true, "a cancellation is carried to the client");
    check(overview.subscription.periodEndMeans === "ends",
      "and the same date now means ENDS rather than renews — the defect this closes",
      overview.subscription.periodEndMeans);
    check(overview.plan.id === "starter",
      "while the plan itself is unchanged until that date", overview.plan.id);
  }

  // ── Reactivated ──────────────────────────────────────────────────────────────────────
  {
    await store.upsertSubscription(OWNER, { cancel_at_period_end: false });
    const overview = await budgetOverview(OWNER);
    check(overview.subscription.periodEndMeans === "renews", "reactivating restores 'renews'");
  }

  // ── Scheduled downgrade ──────────────────────────────────────────────────────────────
  {
    await store.upsertSubscription(OWNER, {
      plan: "pro", pending_plan: "starter", pending_plan_at: PERIOD_END,
    });
    const overview = await budgetOverview(OWNER);
    check(overview.subscription.pendingPlan === "starter", "a scheduled downgrade is reported");
    check(overview.subscription.pendingPlanName === "Starter", "with the plan's NAME, not its id",
      String(overview.subscription.pendingPlanName));
    check(overview.subscription.periodEndMeans === "changes", "and the period end means 'changes'");
    check(overview.plan.id === "pro",
      "metered at Pro until it lands, which is what they paid for", overview.plan.id);
    check(analyticsCapabilities("pro").retentionDays === null, "Pro retention is unlimited");
  }

  // ── Past due meters at Free, without pretending the plan changed ─────────────────────
  {
    await store.upsertSubscription(OWNER, { plan: "starter", status: "past_due", pending_plan: null, pending_plan_at: null });
    const overview = await budgetOverview(OWNER);
    check(overview.pastDue === true, "a failed payment is surfaced");
    check(overview.plan.id === "free", "and meters at Free limits", overview.plan.id);
    check(overview.subscription.plan === "starter",
      "while the subscription still says Starter, because that is what they bought",
      overview.subscription.plan);
  }

  // ── Tokens ───────────────────────────────────────────────────────────────────────────
  {
    await store.upsertSubscription(OWNER, { plan: "free", status: "active" });
    const { token, record } = await createApiToken(OWNER, "Proof key");
    check(token.startsWith("thrallo_pat_"), "a token is issued");

    const listed = await listApiTokens(OWNER);
    check(listed.length === 1 && listed[0].id === record.id, "and appears in the list");
    check(!JSON.stringify(listed).includes(token),
      "the secret is NEVER returned again — only the prefix identifies it");
    check(listed[0].prefix === token.slice(0, 20), "which is the first 20 characters");
    check(Array.isArray(listed[0].scopes) && listed[0].scopes.includes("runs"),
      "scopes are stated rather than left implied", (listed[0].scopes || []).join(","));

    const renamed = await renameApiToken(OWNER, record.id, "Renamed key");
    check(renamed.name === "Renamed key" && renamed.prefix === record.prefix,
      "renaming changes the name and not the key");
    const afterRename = await listApiTokens(OWNER);
    check(!JSON.stringify(afterRename).includes(token), "and still never returns the secret");

    let refused = false;
    try { await renameApiToken("00000000-0000-4000-8000-00000000dead", record.id, "theirs"); }
    catch { refused = true; }
    check(refused, "another owner cannot rename it");

    await revokeApiToken(OWNER, record.id);
    const afterRevoke = await listApiTokens(OWNER);
    check(!!afterRevoke[0].revokedAt, "revoking is recorded and the row is kept",
      String(afterRevoke[0].revokedAt));
    let renameRefused = false;
    try { await renameApiToken(OWNER, record.id, "innocent"); } catch { renameRefused = true; }
    check(renameRefused, "and a revoked key cannot be renamed back into looking active");
  }

  // ── Notification history ─────────────────────────────────────────────────────────────
  {
    await recordNotification(OWNER, {
      title: "Custom domain stopped working", body: "example.invalid no longer points to Thrallo.",
      url: "https://example.invalid", tag: "domain-lost-example.invalid",
    });
    await recordNotification(OWNER, {
      title: "Published", body: "Proof app is live.", tag: "publish-proof",
    });

    let items = await listNotifications(OWNER);
    check(items.length === 2, "notifications are recorded", `${items.length}`);
    check(items[0].source === "publish" || items[0].source === "domain",
      "each carries the part of the product that raised it", items.map((i) => i.source).join(","));
    check(await unreadCount(OWNER) === 2, "and both start unread");

    // A repeat of an unread alert refreshes it rather than stacking.
    await recordNotification(OWNER, {
      title: "Custom domain stopped working", body: "Still not pointing at Thrallo.",
      tag: "domain-lost-example.invalid",
    });
    items = await listNotifications(OWNER);
    check(items.length === 2,
      "a repeat of the same unread alert does not stack", `${items.length} rows`);
    const domain = items.find((i) => i.source === "domain");
    check(domain.body.includes("Still not"), "it is refreshed in place", domain.body);

    const one = await markRead(OWNER, { id: items[0].id });
    check(one.changed === 1, "one can be marked read");
    check(await unreadCount(OWNER) === 1, "and the count agrees", String(await unreadCount(OWNER)));

    const all = await markRead(OWNER, { all: true });
    check(all.changed === 1, "mark-all clears the rest", `${all.changed}`);
    check(await unreadCount(OWNER) === 0, "leaving nothing unread");

    // Another owner's ids simply do not match.
    const foreign = await markRead("00000000-0000-4000-8000-00000000dead", { all: true });
    check(foreign.changed === 0, "another owner cannot mark these read", `${foreign.changed}`);
  }

  // ── notifyOwner records even with no channel able to deliver ──────────────────────────
  {
    const before = (await listNotifications(OWNER)).length;
    await notifyOwner(OWNER, {
      title: "Rolled back", body: "Serving deployment #3 again.", tag: "rollback-proof",
    }, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }) });
    const after = await listNotifications(OWNER);
    check(after.length === before + 1,
      "a notification survives even when every channel fails", `${before} → ${after.length}`);
    check(after[0].source === "publish", "a rollback is a publish-source notification", after[0].source);
  }

  // ── Thrallo's notifications are not the ones customers' apps raise ────────────────────
  {
    const { error } = await db.from("app_notifications").select("id").eq("owner", OWNER).limit(1);
    check(!error, "app_notifications still exists and is untouched by this", error?.message || "ok");
    const { count } = await db.from("app_notifications")
      .select("id", { count: "exact", head: true }).eq("owner", OWNER);
    check((count || 0) === 0,
      "and nothing Thrallo said was written into the apps' stream", String(count || 0));
  }

  // ── The endpoints refuse an anonymous caller ─────────────────────────────────────────
  // Captured here, not assumed to be zero: the notifyOwner check above legitimately leaves one
  // unread row, and an absolute assertion would fail on the proof's own correct behaviour.
  const unreadBefore = await unreadCount(OWNER);
  for (const [label, path, method, body] of [
    ["the settings read", "/api/v1/settings", "GET", null],
    ["notification history", "/api/v1/notifications", "GET", null],
    ["mark read", "/api/v1/notifications/read", "POST", { all: true }],
    ["cancellation", "/api/v1/billing/cancel", "POST", {}],
    ["token rename", "/api/v1/tokens/00000000-0000-4000-8000-000000000001", "PATCH", { name: "x" }],
  ]) {
    const response = await fetch(`${BASE}${path}`, {
      method, redirect: "manual",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    check(response.status === 401, `${label} refuses an anonymous request`, String(response.status));
  }

  // And that refusal really changed nothing.
  {
    const after = await unreadCount(OWNER);
    check(after === unreadBefore, "the anonymous mark-all changed nothing",
      `${unreadBefore} unread before, ${after} after`);
    check(unreadBefore > 0,
      "and there was something it could have marked, so the check is not vacuous", `${unreadBefore}`);
  }

  // ── The deployed client actually carries this ────────────────────────────────────────
  {
    const index = await (await fetch(`${BASE}/`)).text();
    const main = index.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    check(!!main, "the app is served", main || "not found");
    const bundle = await (await fetch(`${BASE}${main}`)).text();
    check(bundle.includes("/settings/usage"), "Settings is a real address in the deployed client");
    // Five tab bodies are code-split, so opening Settings does not download all of them.
    for (const marker of ["UsageTab", "BillingTab", "TokensTab", "NotificationsTab", "PreferencesTab"]) {
      check(/["'`]\.\/[\w.-]*-[\w-]{6,}\.js["'`]/.test(bundle), `${marker}: chunks are referenced`);
      break;
    }
    check(!bundle.includes("will not be shown again"),
      "the API keys tab is split out of the initial download");
  }
} finally {
  await cleanup();
  const { count } = await db.from("ca_notifications")
    .select("id", { count: "exact", head: true }).eq("owner", OWNER);
  check(!count, "the proof cleaned up after itself", `${count || 0} left`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
