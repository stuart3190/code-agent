import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export function githubAppConfigured() {
  return !!(
    optionalEnv("GITHUB_APP_ID")
    && optionalEnv("GITHUB_APP_SLUG")
    && optionalEnv("GITHUB_APP_PRIVATE_KEY")
    && optionalEnv("GITHUB_APP_STATE_SECRET")
  );
}

export function githubWebhookConfigured() {
  return !!optionalEnv("GITHUB_WEBHOOK_SECRET");
}

export function verifyGithubWebhook(rawBody, suppliedSignature) {
  const secret = optionalEnv("GITHUB_WEBHOOK_SECRET");
  if (!secret) throw setupError("GitHub webhook verification is not configured.");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const value = String(suppliedSignature || "");
  if (!value.startsWith("sha256=")) throw invalidWebhook();
  let actual;
  try { actual = Buffer.from(value.slice(7), "hex"); } catch { throw invalidWebhook(); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw invalidWebhook();
  return true;
}

export function installationUrl(ownerId) {
  requireConfigured();
  const state = signInstallationState({ ownerId, exp: Date.now() + 10 * 60_000, nonce: crypto.randomUUID() });
  const slug = encodeURIComponent(optionalEnv("GITHUB_APP_SLUG"));
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

export function signInstallationState(payload) {
  const secret = optionalEnv("GITHUB_APP_STATE_SECRET");
  if (!secret) throw setupError("GitHub App state signing is not configured.");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyInstallationState(value) {
  const secret = optionalEnv("GITHUB_APP_STATE_SECRET");
  if (!secret) throw setupError("GitHub App state signing is not configured.");
  const [encoded, supplied] = String(value || "").split(".");
  if (!encoded || !supplied) throw invalidState();
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(supplied, "base64url"); } catch { throw invalidState(); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw invalidState();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalidState(); }
  if (!payload.ownerId || !payload.exp || payload.exp < Date.now()) throw invalidState();
  return payload;
}

export async function getInstallation(installationId, fetchImpl = fetch) {
  return githubRequest(`/app/installations/${numericId(installationId)}`, { auth: appJwt(), fetchImpl });
}

export async function createInstallationToken(installationId, fetchImpl = fetch) {
  const result = await githubRequest(`/app/installations/${numericId(installationId)}/access_tokens`, {
    method: "POST", auth: appJwt(), fetchImpl,
  });
  if (!result.token) throw new Error("GitHub did not return an installation token");
  return { token: result.token, expiresAt: result.expires_at, permissions: result.permissions || {} };
}

export async function listInstallationRepositories(installationId, fetchImpl = fetch) {
  const { token } = await createInstallationToken(installationId, fetchImpl);
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubRequest(`/installation/repositories?per_page=100&page=${page}`, {
      auth: token, fetchImpl,
    });
    repositories.push(...(result.repositories || []));
    if ((result.repositories || []).length < 100) break;
  }
  return repositories.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    private: !!repo.private,
    defaultBranch: repo.default_branch || "main",
    cloneUrl: repo.clone_url || `https://github.com/${repo.full_name}.git`,
    permissions: repo.permissions || {},
  }));
}

export async function createPullRequest({
  installationId, repository, head, base, title, body, fetchImpl = fetch,
}) {
  const fullName = String(repository || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Invalid GitHub repository name");
  }
  const { token } = await createInstallationToken(installationId, fetchImpl);
  const result = await githubRequest(`/repos/${fullName}/pulls`, {
    method: "POST",
    auth: token,
    fetchImpl,
    json: {
      title: String(title || "Thrallo changes").slice(0, 240),
      head: String(head || "").slice(0, 255),
      base: String(base || "").slice(0, 255),
      body: String(body || "").slice(0, 20_000),
    },
  });
  return {
    number: Number(result.number),
    url: result.html_url,
    state: result.state,
    title: result.title,
  };
}

export function publicInstallation(data) {
  return {
    id: data.id,
    installationId: Number(data.installation_id),
    accountId: data.account_id ? Number(data.account_id) : null,
    accountLogin: data.account_login,
    accountType: data.account_type,
    repositorySelection: data.repository_selection,
    permissions: data.permissions || {},
    status: data.status || (data.suspended_at ? "suspended" : "active"),
    suspendedAt: data.suspended_at,
    deletedAt: data.deleted_at || null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export function installationRow(owner, installation) {
  return {
    owner,
    installation_id: Number(installation.id),
    account_id: installation.account?.id ? Number(installation.account.id) : null,
    account_login: installation.account?.login || null,
    account_type: installation.account?.type || null,
    repository_selection: installation.repository_selection || null,
    permissions: installation.permissions || {},
    events: installation.events || [],
    suspended_at: installation.suspended_at || null,
    status: installation.suspended_at ? "suspended" : "active",
    deleted_at: null,
  };
}

function appJwt() {
  requireConfigured();
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: optionalEnv("GITHUB_APP_ID"),
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function githubRequest(path, { method = "GET", auth, fetchImpl = fetch, json } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${auth}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "code-agent-control-plane",
      ...(json ? { "Content-Type": "application/json" } : {}),
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub request failed (${response.status})`);
    error.code = "github_request_failed";
    error.status = response.status;
    throw error;
  }
  return body;
}

function numericId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid GitHub installation ID");
  return id;
}

function requireConfigured() {
  if (!githubAppConfigured()) throw setupError("GitHub App is not configured.");
}

function setupError(message) {
  const error = new Error(message);
  error.code = "github_setup_required";
  return error;
}

function invalidState() {
  const error = new Error("GitHub installation state is invalid or expired.");
  error.code = "invalid_github_state";
  error.status = 400;
  return error;
}

function invalidWebhook() {
  const error = new Error("GitHub webhook signature is invalid.");
  error.code = "invalid_github_webhook";
  error.status = 401;
  return error;
}
