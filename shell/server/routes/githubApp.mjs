import { optionalEnv } from "../lib/env.mjs";
import { CodeAgentInputError, publicRepository } from "../lib/codeAgentContracts.mjs";
import { codeAgentStore } from "../lib/codeAgentStore.mjs";
import { acceptGithubWebhook } from "../lib/githubWebhookService.mjs";
import {
  getInstallation, githubAppConfigured, installationRow, installationUrl,
  githubWebhookConfigured, listInstallationRepositories, publicInstallation,
  verifyGithubWebhook, verifyInstallationState,
} from "../lib/githubApp.mjs";

export async function handleGithubAppStart(_req, res, owner) {
  if (!githubAppConfigured()) throw setupRequired();
  sendJson(res, 200, { url: installationUrl(owner.id) });
}

export async function handleGithubAppCallback(_req, res, url) {
  if (!githubAppConfigured()) throw setupRequired();
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  if (!installationId || !state) {
    throw new CodeAgentInputError("GitHub did not return an installation and state", 400, "invalid_github_callback");
  }
  const { ownerId } = verifyInstallationState(state);
  const installation = await getInstallation(installationId);
  try {
    await codeAgentStore().upsertGithubInstallation(ownerId, installationRow(ownerId, installation));
  } catch (error) {
    if (error.code === "github_installation_claimed") {
      throw new CodeAgentInputError(error.message, 409, error.code);
    }
    throw error;
  }
  const appUrl = optionalEnv("APP_URL", "http://localhost:5173").replace(/\/+$/, "");
  res.writeHead(302, { Location: `${appUrl}/?github=connected`, "Cache-Control": "no-store" });
  res.end();
}

export async function handleGithubInstallations(_req, res, owner) {
  const rows = await codeAgentStore().listGithubInstallations(owner.id);
  sendJson(res, 200, {
    configured: githubAppConfigured(),
    installations: rows.map(publicInstallation),
  });
}

export async function handleGithubInstallationRepositories(_req, res, owner, installationId) {
  if (!githubAppConfigured()) throw setupRequired();
  const installation = await codeAgentStore().getGithubInstallation(owner.id, installationId);
  if (!installation) throw new CodeAgentInputError("GitHub installation not found", 404, "github_installation_not_found");
  const repositories = await listInstallationRepositories(installation.installation_id);
  sendJson(res, 200, { repositories });
}

export async function handleGithubRepositoryConnect(_req, res, owner, body = {}) {
  if (!githubAppConfigured()) throw setupRequired();
  const installationId = Number(body.installationId);
  const repositoryId = Number(body.repositoryId);
  const installation = await codeAgentStore().getGithubInstallation(owner.id, installationId);
  if (!installation) throw new CodeAgentInputError("GitHub installation not found", 404, "github_installation_not_found");
  const accessible = await listInstallationRepositories(installationId);
  const selected = accessible.find((repo) => repo.id === repositoryId);
  if (!selected) throw new CodeAgentInputError("Repository is not available to this installation", 404, "github_repository_not_found");
  const repository = await codeAgentStore().createRepository(owner.id, {
    provider: "github",
    external_id: selected.id,
    installation_id: installationId,
    full_name: selected.fullName,
    clone_url: selected.cloneUrl,
    default_branch: selected.defaultBranch,
    private: selected.private,
    permissions: selected.permissions,
  });
  sendJson(res, 201, { repository: publicRepository(repository) });
}

export async function handleGithubWebhook(req, res, rawBody) {
  if (!githubWebhookConfigured()) throw setupRequired();
  try {
    verifyGithubWebhook(rawBody, req.headers["x-hub-signature-256"]);
  } catch (error) {
    throw new CodeAgentInputError(error.message, error.status || 401, error.code || "invalid_github_webhook");
  }
  const deliveryId = String(req.headers["x-github-delivery"] || "").trim();
  const event = String(req.headers["x-github-event"] || "").trim();
  if (!deliveryId || deliveryId.length > 100 || !event || event.length > 100) {
    throw new CodeAgentInputError("GitHub webhook metadata is missing", 400, "invalid_github_webhook");
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch {
    throw new CodeAgentInputError("GitHub webhook body is invalid JSON", 400, "invalid_github_webhook");
  }
  let accepted;
  try {
    accepted = await acceptGithubWebhook({ deliveryId, event, payload, rawBody });
  } catch (error) {
    if (error.status) throw new CodeAgentInputError(error.message, error.status, error.code);
    throw error;
  }
  sendJson(res, 202, {
    accepted: true,
    duplicate: !accepted.isNew,
    deliveryId,
    event,
    action: payload.action || null,
    installationId: payload.installation?.id ? Number(payload.installation.id) : null,
  });
}

function setupRequired() {
  return new CodeAgentInputError("GitHub App is not configured on the server", 503, "github_setup_required");
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
