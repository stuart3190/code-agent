// Permanent project deletion (Home workspace X): one server-side cascade, owner-scoped at
// every step. Order matters — the conversation row goes LAST, so any failure leaves the
// project visible and reports the failing step instead of faking success. Shared account
// data, other projects, and global settings are never touched.

import { conversationStore } from "./conversationStore.mjs";

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

export async function deleteConversationCascade(ownerId, conversationId, {
  store = conversationStore(),
  client = null,           // Supabase service client (null in memory-store tests without projects)
  provisiond = null,       // async (route, body) => void — preview/publish teardown; null = skip
} = {}) {
  const conversation = await store.getConversation(ownerId, conversationId);
  if (!conversation || conversation.owner !== ownerId) {
    const e = new Error("Project not found.");
    e.status = 404;
    return Promise.reject(e);
  }
  const events = await store.listEvents(ownerId, conversationId, 0);
  const projectIds = projectIdsFromEvents(events);

  if (client) {
    for (const projectId of projectIds) {
      // Ownership check per project — never delete a project this owner doesn't hold.
      const { data: project, error: projErr } = await client.from("projects")
        .select("id, owner").eq("id", projectId).maybeSingle();
      if (projErr) throw step("project lookup", projErr);
      if (!project || project.owner !== ownerId) continue;

      if (provisiond) {
        await provisiond("/stop", { projectId }).catch(() => {});      // preview container
        await provisiond("/unpublish", { projectId }).catch(() => {}); // published files
      }
      // Per-app backend data: entities + end-user pool (+ their synthetic auth users).
      const del = async (name, q) => { const { error } = await q; if (error) throw step(name, error); };
      await del("app data", client.from("entities").delete().eq("app_id", projectId));
      const { data: appUsers } = await client.from("app_users").select("auth_user_id").eq("app_id", projectId);
      for (const u of appUsers || []) {
        await client.auth.admin.deleteUser(u.auth_user_id).catch(() => {});
      }
      await del("app users", client.from("app_users").delete().eq("app_id", projectId));
      await del("auth events", client.from("app_auth_events").delete().eq("app_id", projectId));
      await del("reset codes", client.from("app_password_resets").delete().eq("app_id", projectId));
      await del("custom domains", client.from("custom_domains").delete().eq("project_id", projectId).eq("owner", ownerId));
      await del("published site", client.from("published_sites").delete().eq("project_id", projectId).eq("owner", ownerId));
      await del("build history", client.from("build_jobs").delete().eq("project_id", projectId).eq("owner", ownerId));
      await del("project", client.from("projects").delete().eq("id", projectId).eq("owner", ownerId));
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
  return { deleted: true, projects: projectIds.length };
}
