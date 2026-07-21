import { assembleExportTree, assertNoPlatformSecrets } from "./exportProject.mjs";
import { requireFeature } from "./features.mjs";
import { getProjectSecret, setProjectSecret, deleteProjectSecret } from "./projectSecrets.mjs";
import { auditEvent } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const PROVIDER = "github";
const TOKEN_NAME = "GITHUB_TOKEN";
const API_VERSION = "2026-03-10";

export function githubRepoName(value) {
  const name = String(value || "buildr101-app").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 100);
  return name || "buildr101-app";
}

export function githubTreeEntries(files, previousExportPaths = []) {
  const entries = Object.entries(files).map(([filePath, content]) => ({ path: filePath, mode: "100644", type: "blob", content }));
  const local = new Set(Object.keys(files));
  for (const filePath of previousExportPaths) if (!local.has(filePath)) entries.push({ path: filePath, mode: "100644", type: "blob", sha: null });
  return entries;
}

async function githubRequest(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "Buildr101",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(out.message || `GitHub request failed (${response.status}).`);
    error.code = response.status === 401 ? "github_auth" : response.status === 422 ? "github_conflict" : "github_error";
    error.status = response.status;
    throw error;
  }
  return out;
}

async function integration(owner, projectId, client) {
  const { data, error } = await client.from("project_integrations").select("id,status,config,last_error,updated_at")
    .eq("owner", owner).eq("project_id", projectId).eq("provider", PROVIDER).eq("environment", "live").maybeSingle();
  if (error) throw new Error(`github integration: ${error.message}`);
  return data;
}

export async function githubOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "github_export");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const linked = await integration(owner.id, projectId, client);
  return {
    connected: !!linked && linked.status === "connected",
    login: linked?.config?.login || null,
    repository: linked?.config?.repo_full_name || null,
    repositoryUrl: linked?.config?.repo_url || null,
    branch: linked?.config?.branch || "main",
    lastCommitAt: linked?.config?.last_commit_at || null,
  };
}

export async function connectGithub(owner, projectId, token, client = serviceClient()) {
  await requireFeature(owner, "github_export");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  if (typeof token !== "string" || !/^(gh[opusr]_|github_pat_)[A-Za-z0-9_]+$/.test(token.trim())) {
    throw Object.assign(new Error("Enter a valid GitHub access token."), { code: "github_auth" });
  }
  const user = await githubRequest(token.trim(), "/user");
  const existing = await integration(owner.id, projectId, client);
  await setProjectSecret(owner.id, projectId, "live", TOKEN_NAME, token.trim(), client);
  const { error } = await client.from("project_integrations").upsert({
    owner: owner.id, project_id: projectId, provider: PROVIDER, environment: "live", status: "connected",
    config: { ...(existing?.config || {}), login: user.login }, last_error: null, updated_at: new Date().toISOString(),
  }, { onConflict: "project_id,environment,provider" });
  if (error) throw new Error(`github connection: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "github.connected", target: user.login }, client).catch(() => {});
  return { connected: true, login: user.login };
}

async function commitFiles({ token, fullName, branch, files, previousExportPaths, message, initial }) {
  let baseTree;
  let parent;
  if (!initial) {
    const ref = await githubRequest(token, `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
    parent = ref.object.sha;
    const commit = await githubRequest(token, `/repos/${fullName}/git/commits/${parent}`);
    baseTree = commit.tree.sha;
  }
  const tree = await githubRequest(token, `/repos/${fullName}/git/trees`, {
    method: "POST", body: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree: githubTreeEntries(files, previousExportPaths) }),
  });
  const commit = await githubRequest(token, `/repos/${fullName}/git/commits`, {
    method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: parent ? [parent] : [] }),
  });
  if (initial) {
    await githubRequest(token, `/repos/${fullName}/git/refs`, {
      method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } else {
    await githubRequest(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  }
  return commit;
}

export async function exportGithub(owner, projectId, options = {}, client = serviceClient()) {
  await requireFeature(owner, "github_export");
  const project = await ownedProject(owner.id, projectId, "id,name,tree", client);
  if (!project) return null;
  const linked = await integration(owner.id, projectId, client);
  if (!linked || linked.status !== "connected") throw Object.assign(new Error("Connect GitHub first."), { code: "github_auth" });
  const token = await getProjectSecret(owner.id, projectId, "live", TOKEN_NAME, client);
  if (!token) throw Object.assign(new Error("Reconnect GitHub to continue."), { code: "github_auth" });
  const { files: exportFiles } = assembleExportTree(project);
  assertNoPlatformSecrets(exportFiles);
  let fullName = linked.config?.repo_full_name;
  let repoUrl = linked.config?.repo_url;
  const branch = linked.config?.branch || "main";
  const initial = !fullName;
  if (initial) {
    const repo = await githubRequest(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name: githubRepoName(options.repoName || project.name), private: options.private !== false, auto_init: false,
        description: "Built with Buildr101" }),
    });
    fullName = repo.full_name;
    repoUrl = repo.html_url;
  } else {
    await requireFeature(owner, "github_sync");
  }
  const commit = await commitFiles({
    token, fullName, branch, files: exportFiles, previousExportPaths: linked.config?.export_paths || [],
    message: initial ? "Initial export from Buildr101" : String(options.message || "Sync from Buildr101").slice(0, 200),
    initial,
  });
  const now = new Date().toISOString();
  const config = { ...linked.config, repo_full_name: fullName, repo_url: repoUrl, branch, last_commit_at: now, last_commit_sha: commit.sha,
    export_paths: Object.keys(exportFiles) };
  const { error } = await client.from("project_integrations").update({ config, last_error: null, updated_at: now }).eq("id", linked.id);
  if (error) throw new Error(`github integration update: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: initial ? "github.exported" : "github.synced", target: fullName, metadata: { commit: commit.sha } }, client).catch(() => {});
  return { repository: fullName, repositoryUrl: repoUrl, branch, commit: commit.sha, initial };
}

export async function disconnectGithub(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "github_export");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  await deleteProjectSecret(owner.id, projectId, "live", TOKEN_NAME, client);
  const { error } = await client.from("project_integrations").delete()
    .eq("owner", owner.id).eq("project_id", projectId).eq("provider", PROVIDER).eq("environment", "live");
  if (error) throw new Error(`github disconnect: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "github.disconnected" }, client).catch(() => {});
  return { disconnected: true };
}
