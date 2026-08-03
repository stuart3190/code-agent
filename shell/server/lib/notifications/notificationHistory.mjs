// Thrallo account notification history.
//
// Every platform notification already funnels through `notifyOwner`, so recording happens there
// and nowhere else — a second call site would be a second source of truth, and the one that got
// forgotten would be the one whose notifications silently never appeared in the centre.
//
// This is the Thrallo ACCOUNT's stream: publishes, domains, health, billing. Notifications that
// customers' generated apps raise for their own end users live in `app_notifications` and are a
// different table for a different audience.

import { serviceClient } from "../supabase.mjs";

// Which part of the product raised it, inferred from the tag `notifyOwner` was already given.
// Inferred rather than passed as a new argument so the eight existing call sites keep working
// exactly as they are — a source that has to be remembered is a source that will be wrong.
const SOURCE_BY_PREFIX = Object.freeze([
  ["publish-", "publish"], ["rollback-", "publish"],
  ["domain-", "domain"],
  ["health-", "health"],
  ["billing-", "billing"],
]);

export function sourceForTag(tag) {
  const value = String(tag || "");
  for (const [prefix, source] of SOURCE_BY_PREFIX) if (value.startsWith(prefix)) return source;
  return "thrallo";
}

/**
 * Record one notification.
 *
 * A repeat of an unread alert REFRESHES it rather than stacking: a domain that fails four sweeps
 * in a row is one thing that is wrong, not four things. The partial unique index on (owner, tag)
 * where read_at is null is what makes that atomic — and it is scoped to unread, so an alert that
 * was acknowledged and then recurs is genuinely new again.
 */
export async function recordNotification(owner, { title, body = "", url = null, tag = "thrallo" }, {
  client = serviceClient(), now = new Date(),
} = {}) {
  const row = {
    owner,
    source: sourceForTag(tag),
    title: String(title || "").slice(0, 200),
    body: String(body || "").slice(0, 2000),
    url: url || null,
    tag: String(tag || "thrallo"),
    created_at: now.toISOString(),
  };
  if (!row.title) return null;
  const { data, error } = await client.from("ca_notifications")
    .upsert(row, { onConflict: "owner,tag", ignoreDuplicates: false })
    .select("*").maybeSingle();
  if (error) {
    // The upsert's conflict target is a PARTIAL index, which PostgREST cannot always infer. Fall
    // back to an explicit update-then-insert rather than losing the notification.
    return manualUpsert(client, row);
  }
  return data;
}

async function manualUpsert(client, row) {
  const { data: updated } = await client.from("ca_notifications")
    .update({ title: row.title, body: row.body, url: row.url, created_at: row.created_at })
    .eq("owner", row.owner).eq("tag", row.tag).is("read_at", null)
    .select("*").maybeSingle();
  if (updated) return updated;
  const { data, error } = await client.from("ca_notifications").insert(row).select("*").maybeSingle();
  if (error) {
    console.error(`[notifications] could not record "${row.title}": ${error.message}`);
    return null;
  }
  return data;
}

export async function listNotifications(owner, { client = serviceClient(), limit = 50, before = null } = {}) {
  let query = client.from("ca_notifications").select("*")
    .eq("owner", owner).order("created_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map(publicNotification);
}

export async function unreadCount(owner, { client = serviceClient() } = {}) {
  const { count, error } = await client.from("ca_notifications")
    .select("id", { count: "exact", head: true })
    .eq("owner", owner).is("read_at", null);
  if (error) throw new Error(error.message);
  return count || 0;
}

/**
 * Mark one notification read, or every unread one.
 *
 * Owner scoping is in the statement rather than a check above it, so an id belonging to someone
 * else simply matches nothing.
 */
export async function markRead(owner, { id = null, all = false, client = serviceClient(), now = new Date() } = {}) {
  if (!id && !all) return { changed: 0 };
  let query = client.from("ca_notifications")
    .update({ read_at: now.toISOString() })
    .eq("owner", owner).is("read_at", null);
  if (!all) query = query.eq("id", id);
  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  return { changed: (data || []).length };
}

function publicNotification(row) {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    body: row.body || "",
    url: row.url || null,
    read: !!row.read_at,
    readAt: row.read_at || null,
    createdAt: row.created_at,
  };
}
