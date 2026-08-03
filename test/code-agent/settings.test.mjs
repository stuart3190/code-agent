// Settings: the notification history, cancellation state, token renaming, and what the one
// Settings read is allowed to claim.
//
// The defect behind the notification centre: every platform notification funnelled through
// `notifyOwner`, which pushed to web-push and Resend and kept NOTHING. A customer asleep when
// their custom domain stopped working had no way to learn it ever happened, and one with neither
// channel configured received nothing at all.
//
// The defect behind cancellation: Stripe held `cancel_at_period_end` and Thrallo never read it, so
// the billing panel told someone their plan "renews" on the very date it was ending.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MemoryApiTokenStore, createApiToken, listApiTokens, renameApiToken, revokeApiToken } from "../../shell/server/lib/apiTokens.mjs";
import { normalizeSubscription, publicSubscription } from "../../shell/server/lib/subscriptionPlans.mjs";
import { sourceForTag } from "../../shell/server/lib/notifications/notificationHistory.mjs";
import { notifyOwner } from "../../shell/server/lib/notifications/notificationService.mjs";

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const readCode = async (p) => (await read(p))
  .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const OWNER = "88888888-8888-4888-8888-888888888888";

// ── Notification history ────────────────────────────────────────────────────────────────

test("every notification is recorded, even when no channel is configured", async () => {
  const recorded = [];
  const results = await notifyOwner(OWNER, { title: "Published", body: "It is live.", tag: "publish-p1" }, {
    record: async (owner, note) => { recorded.push({ owner, ...note }); return { id: "n1" }; },
    fetchImpl: async () => { throw new Error("no channel should be reached in this test"); },
  });
  assert.equal(recorded.length, 1, "the history is the one channel that always exists");
  assert.equal(recorded[0].owner, OWNER);
  assert.equal(recorded[0].title, "Published");
  assert.equal(results.recorded, true);
});

test("a channel failure does not lose the history entry", async () => {
  // Recorded FIRST and independently. If sending were what wrote the row, an account with no push
  // subscription and no Resend key would have no record of anything that ever happened to it.
  const service = await readCode("../../shell/server/lib/notifications/notificationService.mjs");
  // Scoped to notifyOwner's own body: `vapidConfigured()` also appears in notificationChannels()
  // near the top of the file, which says nothing about the order inside this function.
  const body = service.slice(service.indexOf("export async function notifyOwner"));
  const recordAt = body.indexOf("record(ownerId");
  const channelsAt = body.indexOf("vapidConfigured()");
  assert.ok(recordAt > 0 && channelsAt > 0 && recordAt < channelsAt,
    "recording must happen before any channel is attempted");
});

test("the source is inferred from the tag the call site already sends", () => {
  // Inferred rather than added as an argument: a source that has to be remembered at eight call
  // sites is a source that will be wrong at one of them.
  assert.equal(sourceForTag("publish-abc"), "publish");
  assert.equal(sourceForTag("rollback-abc"), "publish");
  assert.equal(sourceForTag("domain-active-example.com"), "domain");
  assert.equal(sourceForTag("health-offline-p1"), "health");
  assert.equal(sourceForTag("something-else"), "thrallo");
  assert.equal(sourceForTag(undefined), "thrallo");
});

test("Thrallo notifications are a different table from the ones customers' apps raise", async () => {
  const history = await readCode("../../shell/server/lib/notifications/notificationHistory.mjs");
  assert.match(history, /ca_notifications/);
  assert.doesNotMatch(history, /app_notifications/,
    "app_notifications belongs to the end users of apps customers build, not to the account owner");
});

test("a repeat of an unread alert refreshes it rather than stacking", async () => {
  const migration = await read("../../supabase/migrations/20260805090000_account_notifications_cancellation.sql");
  assert.match(migration, /create unique index if not exists ca_notifications_owner_tag_unread_idx[\s\S]*?where read_at is null/,
    "a domain failing four sweeps is one thing that is wrong, not four");
});

// ── Cancellation ────────────────────────────────────────────────────────────────────────

test("a cancelled subscription says it ends, not that it renews", () => {
  const row = normalizeSubscription(OWNER, {
    plan: "starter", status: "active", stripe_subscription_id: "sub_1",
    current_period_end: "2026-09-12T00:00:00Z", cancel_at_period_end: true,
  });
  const view = publicSubscription(row);
  assert.equal(view.cancelAtPeriodEnd, true);
  assert.equal(view.periodEndMeans, "ends",
    "the same date means something different depending on this flag, and no surface should have to work it out");
});

test("the four things a period end can mean are each distinct", () => {
  const base = { plan: "starter", status: "active", stripe_subscription_id: "sub_1", current_period_end: "2026-09-12T00:00:00Z" };
  const means = (patch) => publicSubscription(normalizeSubscription(OWNER, { ...base, ...patch })).periodEndMeans;
  assert.equal(means({}), "renews");
  assert.equal(means({ cancel_at_period_end: true }), "ends");
  assert.equal(means({ pending_plan: "pro", pending_plan_at: "2026-09-12T00:00:00Z" }), "changes");
  // No Stripe subscription at all: the date is just when the free allowance rolls over.
  assert.equal(means({ stripe_subscription_id: null }), "resets");
});

test("cancelling and un-cancelling take one field on one Stripe object", async () => {
  const billing = await readCode("../../shell/server/lib/subscriptionBilling.mjs");
  assert.match(billing, /export async function setCancellation\(owner, cancel/);
  assert.match(billing, /cancel_at_period_end: !!cancel/);
  // Two endpoints would be two chances to drift apart.
  assert.doesNotMatch(billing, /export async function reactivate/);
});

test("the webhook syncs cancellation from Stripe, which is the authority", async () => {
  const billing = await readCode("../../shell/server/lib/subscriptionBilling.mjs");
  assert.match(billing, /cancel_at_period_end: status === "cancelled" \? false : !!subscription\.cancel_at_period_end/,
    "without this a customer who cancelled in Stripe's portal would still be told the plan renews");
});

// ── Tokens ──────────────────────────────────────────────────────────────────────────────

function tokenStore() {
  return { store: new MemoryApiTokenStore() };
}

test("a token secret is returned once and never again", async () => {
  const options = tokenStore();
  const { token, record } = await createApiToken(OWNER, "Laptop CLI", options);
  assert.match(token, /^thrallo_pat_/);

  const listed = await listApiTokens(OWNER, options);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
  const serialised = JSON.stringify(listed);
  assert.ok(!serialised.includes(token), "the full secret must never appear in a list response");
  assert.ok(serialised.includes(listed[0].prefix), "only the prefix, which identifies without granting");
});

test("renaming keeps the same key rather than issuing a new one", async () => {
  const options = tokenStore();
  const { token, record } = await createApiToken(OWNER, "old name", options);
  const renamed = await renameApiToken(OWNER, record.id, "Desktop", options);
  assert.equal(renamed.name, "Desktop");
  assert.equal(renamed.id, record.id);
  assert.equal(renamed.prefix, record.prefix, "the key itself is untouched");
  assert.ok(!JSON.stringify(renamed).includes(token));
});

test("renaming is owner-scoped and rejects a name the database would refuse", async () => {
  const options = tokenStore();
  const { record } = await createApiToken(OWNER, "mine", options);
  await assert.rejects(() => renameApiToken("77777777-7777-4777-8777-777777777777", record.id, "theirs", options),
    /Token not found/, "another owner's id simply does not match");
  await assert.rejects(() => renameApiToken(OWNER, record.id, "", options), /1-120/);
  await assert.rejects(() => renameApiToken(OWNER, record.id, "x".repeat(121), options), /1-120/);
});

test("a revoked token cannot be renamed back into looking active", async () => {
  const options = tokenStore();
  const { record } = await createApiToken(OWNER, "leaked", options);
  await revokeApiToken(OWNER, record.id, options);
  await assert.rejects(() => renameApiToken(OWNER, record.id, "innocent", options), /Token not found/);
});

test("scopes are reported, so a key does not read as unlimited by saying nothing", async () => {
  const options = tokenStore();
  await createApiToken(OWNER, "cli", options);
  const [listed] = await listApiTokens(OWNER, options);
  assert.deepEqual(listed.scopes, ["runs"]);
});

// ── The one Settings read ───────────────────────────────────────────────────────────────

test("Settings assembles from the existing services and derives nothing new", async () => {
  const route = await readCode("../../shell/server/routes/settings.mjs");
  for (const source of ["budgetOverview", "planCatalogPublic", "analyticsCapabilities", "listApiTokens", "unreadCount"]) {
    assert.ok(route.includes(source), `${source} must be the source, not a second opinion`);
  }
  // Retention is a plan feature enforced in the analytics service. Restating the numbers here is
  // how Settings and the Analytics tab end up quoting different retention.
  assert.doesNotMatch(route, /RETENTION_DAYS|retentionFor\(/);
  assert.doesNotMatch(route, /priceGbp\s*:/, "prices come from the catalogue");
});

test("Settings reports nothing about storage, because nothing measures it", async () => {
  const route = await readCode("../../shell/server/routes/settings.mjs");
  assert.doesNotMatch(route, /storage(Bytes|Used|Limit)/i,
    "a plausible number beside three metered ones would be read as measured");
  const tab = await readCode("../../shell/web/src/settings/UsageTab.jsx");
  assert.match(tab, /does not meter storage/, "and the screen says so rather than staying silent");
});

test("one section failing leaves a gap rather than failing the whole screen", async () => {
  const route = await readCode("../../shell/server/routes/settings.mjs");
  // Each optional read settles on its own and yields null. A screen that 500s because a token
  // count was briefly unavailable is worse than one that says tokens are unavailable.
  const matches = route.match(/\.catch\(\(error\) => \{[\s\S]*?return null;/g) || [];
  assert.ok(matches.length >= 3, `expected each optional section to settle to null, found ${matches.length}`);
});

// ── Duplicates removed ──────────────────────────────────────────────────────────────────

test("there is one usage surface, one billing panel and one meter", async () => {
  const { readdir } = await import("node:fs/promises");
  const manage = await readdir(fileURLToPath(new URL("../../shell/web/src/manage", import.meta.url)));
  assert.ok(!manage.includes("UsageView.jsx"), "the second usage dashboard is gone");
  assert.ok(!manage.includes("TokensSettings.jsx"), "the second token screen is gone");
  const billing = await readdir(fileURLToPath(new URL("../../shell/web/src/billing", import.meta.url)));
  assert.ok(!billing.includes("BillingSettings.jsx"), "the second billing panel is gone");

  // And the thresholds still live in ONE plain module, so this suite can assert them directly.
  const meters = await readCode("../../shell/web/src/settings/meters.jsx");
  assert.match(meters, /import \{ meterWarning \} from "\.\.\/manage\/usageWarnings\.js"/);
});

test("the Lead Agent's open_view('usage') still lands somewhere", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  assert.match(shell, /event\.payload\?\.view === "usage"[\s\S]{0,120}navigate\("\/settings\/usage"\)/,
    "the capability's contract is unchanged; only where it lands moved");
  const capability = await readCode("../../shell/server/lib/capabilities/coreCapabilities.mjs");
  assert.match(capability, /enum: \["repos", "usage", "ops"\]/, "so the enum must still accept it");
});
