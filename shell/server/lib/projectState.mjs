import { ownedProject, serviceClient } from "./supabase.mjs";

export async function ensureProjectEnvironments(owner, projectId, client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const rows = ["test", "live"].map((environment) => ({ owner, project_id: projectId, environment }));
  const { data, error } = await client.from("project_environments")
    .upsert(rows, { onConflict: "project_id,environment", ignoreDuplicates: true })
    .select("project_id,environment,config,schema_version,created_at,updated_at");
  if (error) throw new Error(`project environments: ${error.message}`);
  return data || [];
}

export async function listProjectEnvironments(owner, projectId, client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  await ensureProjectEnvironments(owner, projectId, client);
  const { data, error } = await client.from("project_environments")
    .select("project_id,environment,config,schema_version,created_at,updated_at")
    .eq("owner", owner).eq("project_id", projectId).order("environment");
  if (error) throw new Error(`project environments: ${error.message}`);
  return data || [];
}

export async function recordRelease({ owner, projectId, environment = "live", tree, config = {}, status = "ready" }, client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  await ensureProjectEnvironments(owner, projectId, client);
  const { data: env, error: envError } = await client.from("project_environments")
    .select("schema_version").eq("project_id", projectId).eq("environment", environment).single();
  if (envError) throw new Error(`release environment: ${envError.message}`);
  const { data, error } = await client.from("project_releases").insert({
    owner, project_id: projectId, environment, source_tree: tree,
    release_config: config, schema_version: env.schema_version, status,
  }).select("id,project_id,environment,release_config,schema_version,status,created_at").single();
  if (error) throw new Error(`release record: ${error.message}`);
  return data;
}

export async function listReleases(owner, projectId, limit = 25, client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { data, error } = await client.from("project_releases")
    .select("id,project_id,environment,release_config,schema_version,status,created_at")
    .eq("owner", owner).eq("project_id", projectId).order("created_at", { ascending: false }).limit(safeLimit);
  if (error) throw new Error(`release list: ${error.message}`);
  return data || [];
}

export async function auditEvent({ owner, projectId = null, actorId = owner, action, target = null, metadata = {} }, client = serviceClient()) {
  const { error } = await client.from("audit_events").insert({
    owner, project_id: projectId, actor_id: actorId, action, target, metadata,
  });
  if (error) throw new Error(`audit event: ${error.message}`);
}
