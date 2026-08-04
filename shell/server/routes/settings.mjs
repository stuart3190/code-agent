// The Settings screen, in one request.
//
// Settings used to assemble itself from four separate calls made by four separate components —
// usage, billing, tokens, notification config — each with its own loading state and each able to
// fail on its own. Opening Settings meant watching four panels arrive in an arbitrary order, and
// one failing left the others claiming everything was fine.
//
// Nothing here derives anything new. Every number comes from the service that already owned it:
// budgets from `budgetOverview`, the catalogue from `planCatalogPublic`, retention from
// `analyticsCapabilities`, tokens from `listApiTokens`. This route is an assembly point, not a
// second opinion — a second opinion is how two surfaces end up disagreeing about a customer's plan.

import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { budgetOverview, planCatalogPublic } from "../lib/usageBudgets.mjs";
import { setCancellation, thralloStripeConfigured } from "../lib/subscriptionBilling.mjs";
import { analyticsCapabilities } from "../lib/analytics/reports.mjs";
import { listApiTokens, renameApiToken } from "../lib/apiTokens.mjs";
import { listNotifications, markRead, unreadCount } from "../lib/notifications/notificationHistory.mjs";
import { notificationChannels, vapidPublicKey } from "../lib/notifications/notificationService.mjs";
import { serviceClient } from "../lib/supabase.mjs";

export async function handleSettings(_req, res, owner) {
  return wrap(async () => {
    const overview = await budgetOverview(owner.id);
    // Everything below is context around the budgets. Each is settled on its own so one
    // unavailable section leaves a gap the client can name, rather than failing the whole screen —
    // the failure mode Phase 1 spent its length removing.
    const [tokens, unread, counts] = await Promise.all([
      listApiTokens(owner.id).catch((error) => {
        console.error(`[settings] tokens unavailable: ${describe(error)}`); return null;
      }),
      unreadCount(owner.id).catch((error) => {
        console.error(`[settings] unread count unavailable: ${describe(error)}`); return null;
      }),
      accountCounts(owner.id).catch((error) => {
        console.error(`[settings] counts unavailable: ${describe(error)}`); return null;
      }),
    ]);

    sendJson(res, 200, {
      ...overview,
      plans: planCatalogPublic(),
      stripeConfigured: thralloStripeConfigured(),
      // What the plan includes beyond the three metered budgets. Read from the analytics service,
      // so Settings and the Analytics tab cannot quote different retention.
      capabilities: analyticsCapabilities(overview.plan.id),
      tokens,
      notifications: {
        unread,
        channels: notificationChannels(),
        vapidPublicKey: vapidPublicKey(),
      },
      counts,
    });
  });
}

/**
 * What the account actually holds.
 *
 * Deliberately only things that are genuinely counted somewhere. Thrallo has no storage meter —
 * no bytes are measured anywhere and no plan limits any — so this reports projects, live sites and
 * deployments and says nothing about storage at all. A plausible estimate sitting next to real
 * metered numbers would be read as measured, which is worse than the gap.
 */
async function accountCounts(owner, { client = serviceClient() } = {}) {
  const count = async (table, filters = {}) => {
    let query = client.from(table).select("id", { count: "exact", head: true }).eq("owner", owner);
    for (const [column, value] of Object.entries(filters)) {
      query = value === null ? query.is(column, null) : query.eq(column, value);
    }
    const { count: n, error } = await query;
    // The whole error, not just `.message`: PostgREST puts the useful part in `details` or `hint`
    // for exactly the failure that happened here, so `.message` alone logged an empty reason.
    if (error) throw new Error(describe(error));
    return n || 0;
  };
  const [projects, liveSites, deployments] = await Promise.all([
    count("ca_conversations", { deleted_at: null, archived_at: null }),
    // `published_sites` has no `live` column — being live IS having no unpublished_at, which is the
    // same rule resolvePublishState applies. Filtering on a column that does not exist threw, the
    // catch above turned it into `counts: null`, and the Usage tab read "temporarily unavailable"
    // for every customer from the moment Phase 6 shipped.
    count("published_sites", { unpublished_at: null }),
    count("deployments"),
  ]);
  return { projects, liveSites, deployments };
}

// ── Cancellation ────────────────────────────────────────────────────────────────────────

export async function handleCancellation(_req, res, owner, body = {}) {
  return wrap(async () => {
    // `resume` rather than a second endpoint: cancelling and un-cancelling are one field on one
    // Stripe object, and two endpoints would be two chances to drift apart.
    const result = await setCancellation(owner.id, !body?.resume);
    sendJson(res, 200, {
      ...result,
      ...(await budgetOverview(owner.id)),
      plans: planCatalogPublic(),
      stripeConfigured: thralloStripeConfigured(),
    });
  });
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────

export async function handleTokenRename(_req, res, owner, tokenId, body = {}) {
  return wrap(async () => {
    await renameApiToken(owner.id, tokenId, body?.name);
    sendJson(res, 200, { tokens: await listApiTokens(owner.id) });
  });
}

// ── Notifications ───────────────────────────────────────────────────────────────────────

export async function handleNotificationList(_req, res, owner, url = null) {
  return wrap(async () => {
    const before = url?.searchParams?.get("before") || null;
    const limit = Number(url?.searchParams?.get("limit") || 50);
    const [items, unread] = await Promise.all([
      listNotifications(owner.id, { limit, before }),
      unreadCount(owner.id),
    ]);
    sendJson(res, 200, { items, unread });
  });
}

export async function handleNotificationRead(_req, res, owner, body = {}) {
  return wrap(async () => {
    const all = body?.all === true;
    const id = body?.id ? String(body.id) : null;
    if (!all && !id) throw new CodeAgentInputError("Nothing to mark read", 400, "no_selection");
    const result = await markRead(owner.id, { id, all });
    sendJson(res, 200, { ...result, unread: await unreadCount(owner.id) });
  });
}

// ── plumbing ────────────────────────────────────────────────────────────────────────────

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CodeAgentInputError) throw error;
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "settings_request_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

// A blank reason is a wasted log line. The one that mattered here — a filter on a column that does
// not exist — printed as "[settings] counts unavailable:" with nothing after it, so the failure was
// both visible and useless.
function describe(error) {
  return error?.message || error?.details || error?.hint || error?.code || String(error) || "unknown";
}
