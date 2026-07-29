import { previewProvider } from "../preview/index.mjs";
import { requireFeature } from "./features.mjs";
import { auditEvent, ensureProjectEnvironments, listProjectEnvironments, listReleases, recordRelease } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";
import { materializeAndPublish } from "../routes/publish.mjs";
import { withRuntimeEnv } from "./runtimeEnv.mjs";

export function isDeployableRelease(release, environment) {
  return !!(release && release.environment === environment && release.status === "ready"
    && release.source_tree && typeof release.source_tree === "object");
}

export async function environmentOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "environments");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const environments = await listProjectEnvironments(owner.id, projectId, client);
  const releases = await listReleases(owner.id, projectId, 50, client);
  return { environments, releases };
}

export async function deployTestEnvironment(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "environments");
  const project = await ownedProject(owner.id, projectId, "id,tree", client);
  if (!project) return null;
  if (!project.tree || typeof project.tree !== "object") throw Object.assign(new Error("Build the app before deploying it."), { code: "no_app" });
  const preview = await previewProvider().start(projectId, withRuntimeEnv(project.tree, projectId));
  const release = await recordRelease({ owner: owner.id, projectId, environment: "test", tree: project.tree,
    config: { url: preview.url, previewId: preview.id }, status: "ready" }, client);
  const environments = await ensureProjectEnvironments(owner.id, projectId, client);
  const current = environments?.find((row) => row.environment === "test");
  await client.from("project_environments").update({
    config: { ...(current?.config || {}), current_release_id: release.id, url: preview.url }, updated_at: new Date().toISOString(),
  }).eq("project_id", projectId).eq("environment", "test");
  await auditEvent({ owner: owner.id, projectId, action: "environment.test.deployed", target: release.id }, client).catch(() => {});
  return { release, url: preview.url };
}

async function releaseSource(owner, projectId, releaseId, expectedEnvironment, client) {
  const { data, error } = await client.from("project_releases").select("id,environment,source_tree,status,created_at")
    .eq("id", releaseId).eq("project_id", projectId).eq("owner", owner).maybeSingle();
  if (error) throw new Error(`release lookup: ${error.message}`);
  if (!isDeployableRelease(data, expectedEnvironment)) return null;
  return data;
}

export async function promoteTestRelease(owner, projectId, releaseId, client = serviceClient()) {
  await requireFeature(owner, "environments");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const release = await releaseSource(owner.id, projectId, releaseId, "test", client);
  if (!release) return false;
  const out = await materializeAndPublish({ owner, projectId, tree: release.source_tree });
  await auditEvent({ owner: owner.id, projectId, action: "environment.test.promoted", target: releaseId,
    metadata: { liveReleaseId: out.releaseId } }, client).catch(() => {});
  return out;
}

export async function rollbackLiveRelease(owner, projectId, releaseId, client = serviceClient()) {
  await requireFeature(owner, "environments");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const release = await releaseSource(owner.id, projectId, releaseId, "live", client);
  if (!release) return false;
  const { data: environment } = await client.from("project_environments").select("config")
    .eq("project_id", projectId).eq("environment", "live").maybeSingle();
  const displacedId = environment?.config?.current_release_id;
  const out = await materializeAndPublish({ owner, projectId, tree: release.source_tree });
  if (displacedId && displacedId !== out.releaseId) {
    await client.from("project_releases").update({ status: "rolled_back" }).eq("id", displacedId).eq("owner", owner.id);
  }
  await auditEvent({ owner: owner.id, projectId, action: "environment.live.rolled_back", target: releaseId,
    metadata: { replacementReleaseId: out.releaseId } }, client).catch(() => {});
  return out;
}
