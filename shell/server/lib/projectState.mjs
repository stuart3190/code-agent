import { serviceClient } from "./supabase.mjs";

export async function auditEvent({ owner, projectId = null, actorId = owner, action, target = null, metadata = {} }, client = serviceClient()) {
  const { error } = await client.from("audit_events").insert({
    owner, project_id: projectId, actor_id: actorId, action, target, metadata,
  });
  if (error) throw new Error(`audit event: ${error.message}`);
}
