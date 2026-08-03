// Permanent project deletion (Home workspace X): one server-side cascade, owner-scoped at
// every step. Order matters — the conversation row goes LAST, so any failure leaves the
// project visible and reports the failing step instead of faking success. Shared account
// data, other projects, and global settings are never touched.

import { conversationStore } from "./conversationStore.mjs";
import { purgeProjectResources } from "./projectTeardown.mjs";

function step(name, error) {
  const e = new Error(`Deletion failed at ${name}: ${error?.message || error}`);
  e.step = name;
  e.status = 500;
  return e;
}

// Project ids owned by this conversation come from its own durable events — the same truth
// the thread shows (build_started / preview_ready / published payloads).
export function projectIdsFromEvents(events) {
  const ids = new Set();
  for (const event of events || []) {
    const id = event?.payload?.projectId;
    if (id && ["build_started", "preview_ready", "published", "verification"].includes(event.type)) ids.add(String(id));
  }
  return [...ids];
}

export const RECOVERY_DAYS = 7;

export async function deleteConversationCascade(ownerId, conversationId, {
  store = conversationStore(),
  client = null,           // Supabase service client (null in memory-store tests without projects)
  provisiond = null,       // async (route, body) => void — preview/publish teardown; null = skip
  reason = "delete_now",   // audit trail: delete_now | expired
} = {}) {
  // Cascade must reach soft-deleted conversations (purge runs after they are hidden).
  const conversation = await store.getConversationIncludingDeleted(ownerId, conversationId);
  if (!conversation || conversation.owner !== ownerId) {
    const e = new Error("Project not found.");
    e.status = 404;
    return Promise.reject(e);
  }
  const events = await store.listEventsIncludingDeleted(ownerId, conversationId);
  const projectIds = projectIdsFromEvents(events);

  if (client) {
    for (const projectId of projectIds) {
      // Ownership check per project — never delete a project this owner doesn't hold.
      const { data: project, error: projErr } = await client.from("projects")
        .select("id, owner").eq("id", projectId).maybeSingle();
      if (projErr) throw step("project lookup", projErr);
      if (!project || project.owner !== ownerId) continue;

      // One authoritative teardown. This used to be a hand-written list here that covered seven
      // tables and left ten, and unpublished without the slug — which removed nothing and left the
      // site serving forever.
      const report = await purgeProjectResources(ownerId, projectId, { client, provisiond });
      if (report.site?.attempted && report.site.slug && !report.site.removed) {
        // The record is about to be deleted, taking the slug with it. If the files are still
        // there, stopping now keeps the project visible and recoverable instead of stranding a
        // live site nobody can reach the controls for.
        throw step("taking the site offline", new Error(`${report.site.slug} is still being served`));
      }
    }

    // Product memory: only when no OTHER conversation still uses this product.
    if (conversation.product_id) {
      const { data: siblings } = await client.from("ca_conversations")
        .select("id").eq("product_id", conversation.product_id).neq("id", conversationId).limit(1);
      if (!siblings?.length) {
        await client.from("ca_memories").delete().eq("owner", ownerId).eq("product_id", conversation.product_id);
        await client.from("ca_products").delete().eq("id", conversation.product_id).eq("owner", ownerId);
      }
    }
  }

  // Chat history last — events, turns, then the conversation row itself.
  try {
    await store.deleteConversation(ownerId, conversationId);
  } catch (error) {
    throw step("conversation history", error);
  }
  console.log(JSON.stringify({
    audit: "project_permanent_delete", owner: ownerId, conversation: conversationId,
    title: conversation.title || null, projects: projectIds, reason, at: new Date().toISOString(),
  }));
  return { deleted: true, projects: projectIds.length };
}

// Background cleanup: permanently delete anything past its recovery window. Failures on one
// conversation never block the rest; each purge is the same audited cascade as Delete Now.
export async function purgeExpiredDeletedConversations({
  store = conversationStore(), client = null, provisiond = null, days = RECOVERY_DAYS,
} = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const expired = await store.listExpiredDeleted(cutoff);
  const results = { purged: 0, failed: 0 };
  for (const row of expired) {
    try {
      await deleteConversationCascade(row.owner, row.id, { store, client, provisiond, reason: "expired" });
      results.purged += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`[cleanup] purge failed for ${row.id}: ${error.message}`);
    }
  }
  return results;
}
