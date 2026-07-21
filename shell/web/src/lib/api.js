// Fetch wrappers to the shell server. Every authenticated call attaches the Supabase access token
// so the server resolves owner = auth.uid() (it never trusts an owner id from the body).

import { accessToken } from "./backend.js";

async function authHeaders(extra = {}) {
  const token = await accessToken();
  if (!token) throw new Error("Your session expired. Sign out, sign back in, and try again.");
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export async function getConfig() {
  const r = await fetch("/api/config");
  return r.json();
}

export async function getFeatures() {
  const r = await fetch("/api/features", { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `features ${r.status}`);
  return out;
}

export async function listProjectSecrets(projectId, environment = "test") {
  const params = new URLSearchParams({ projectId, environment });
  const r = await fetch(`/api/projects/secrets?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `secrets ${r.status}`);
  return out.secrets;
}

export async function saveProjectSecret(projectId, environment, name, value) {
  const r = await fetch("/api/projects/secrets", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, environment, name, value }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `secret save ${r.status}`);
  return out;
}

export async function removeProjectSecret(projectId, environment, name) {
  const r = await fetch("/api/projects/secrets", {
    method: "DELETE", headers: await authHeaders(), body: JSON.stringify({ projectId, environment, name }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `secret delete ${r.status}`);
  return out;
}

export async function listProjectReleases(projectId, limit = 25) {
  const params = new URLSearchParams({ projectId, limit: String(limit) });
  const r = await fetch(`/api/projects/releases?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `releases ${r.status}`);
  return out.releases;
}

export async function listProjectEnvironments(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/environments?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `environments ${r.status}`);
  return out.environments;
}

export async function startQaRun(projectId) {
  const r = await fetch("/api/projects/test-runs", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `test run ${r.status}`);
  return out;
}

export async function getQaRun(runId) {
  const r = await fetch(`/api/test-runs/${encodeURIComponent(runId)}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `test run ${r.status}`);
  return out;
}

export async function waitForQaRun(runId, onUpdate, { timeoutMs = 8 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getQaRun(runId);
    onUpdate?.(run);
    if (["passed", "issues_found", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Testing is still running. You can close this message and check again shortly.");
}

export async function openQaArtifact(runId, filename) {
  const artifactWindow = window.open("", "_blank");
  const r = await fetch(`/api/test-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(filename)}`, { headers: await authHeaders() });
  if (!r.ok) {
    artifactWindow?.close();
    throw new Error((await r.json().catch(() => ({}))).error || `artifact ${r.status}`);
  }
  const objectUrl = URL.createObjectURL(await r.blob());
  if (artifactWindow) artifactWindow.location.replace(objectUrl);
  else window.location.assign(objectUrl);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function getPaymentOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/payments?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `payments ${r.status}`);
  return out;
}

export async function beginStripeOnboarding(projectId) {
  const onboardingWindow = window.open("", "_blank");
  const r = await fetch("/api/projects/payments/onboard", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId }),
  });
  const out = await r.json();
  if (!r.ok) {
    onboardingWindow?.close();
    throw new Error(out.error || `Stripe onboarding ${r.status}`);
  }
  if (onboardingWindow) onboardingWindow.location.replace(out.url);
  else window.location.assign(out.url);
  return out;
}

export async function savePaymentProduct(projectId, product) {
  const r = await fetch("/api/projects/payments/products", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...product }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `payment product ${r.status}`);
  return out.product;
}

export async function deletePaymentProduct(projectId, productId) {
  return savePaymentProduct(projectId, { productId, delete: true });
}

export async function getBrandOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/brand?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `brand settings ${r.status}`);
  return out;
}

export async function applyProjectBrand(projectId, config, options = {}) {
  const r = await fetch("/api/projects/brand", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, config, ...options }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `brand apply ${r.status}`);
  return out;
}

export async function deleteBrandKit(kitId) {
  const r = await fetch("/api/brand-kits/delete", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ kitId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `brand delete ${r.status}`);
  return out;
}

export async function getOwnerConsole(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/owner-console?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `owner console ${r.status}`);
  return out;
}

export async function setConsoleUserStatus(projectId, userId, status) {
  const r = await fetch("/api/projects/owner-console/user", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, userId, status }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `app user ${r.status}`);
  return out.user;
}

export async function deleteConsoleRecord(projectId, recordId) {
  const r = await fetch("/api/projects/owner-console/record", {
    method: "DELETE", headers: await authHeaders(), body: JSON.stringify({ projectId, recordId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `app record ${r.status}`);
  return out;
}

export async function getGithubOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/github?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `GitHub ${r.status}`);
  return out;
}

export async function connectGithub(projectId, token) {
  const r = await fetch("/api/projects/github/connect", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, token }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `GitHub connection ${r.status}`);
  return out;
}

export async function exportGithub(projectId, options = {}) {
  const r = await fetch("/api/projects/github/export", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...options }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `GitHub export ${r.status}`);
  return out;
}

export async function disconnectGithub(projectId) {
  const r = await fetch("/api/projects/github/disconnect", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `GitHub disconnect ${r.status}`);
  return out;
}

export async function getIntegrationOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/integrations?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `integrations ${r.status}`);
  return out;
}

export async function saveIntegrationSettings(projectId, settings) {
  const r = await fetch("/api/projects/integrations", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...settings }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `integrations ${r.status}`);
  return out;
}

export async function getConnectorOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/connectors?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `connectors ${r.status}`);
  return out;
}

export async function getCapabilityOverview(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/capabilities?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `capabilities ${r.status}`);
  return out;
}

export async function saveCapability(projectId, settings) {
  const r = await fetch("/api/projects/capabilities", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...settings }) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `capability ${r.status}`);
  return out.action;
}

export async function deleteCapability(projectId, actionId) {
  const r = await fetch("/api/projects/capabilities", { method: "DELETE", headers: await authHeaders(), body: JSON.stringify({ projectId, actionId }) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `capability delete ${r.status}`);
  return out;
}

export async function saveKnowledgeBase(projectId, input) {
  const r = await fetch("/api/projects/knowledge-bases", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...input }) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `knowledge base ${r.status}`);
  return out.knowledgeBase;
}

export async function saveActionSchedule(projectId, input) {
  const r = await fetch("/api/projects/action-schedules", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...input }) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `action schedule ${r.status}`);
  return out.schedule;
}

export async function saveConnector(projectId, settings) {
  const r = await fetch("/api/projects/connectors", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...settings }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `connector ${r.status}`);
  return out;
}

export async function testConnector(projectId, provider) {
  const r = await fetch("/api/projects/connectors/test", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, provider }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `connector test ${r.status}`);
  return out;
}

export async function disconnectConnector(projectId, provider) {
  const r = await fetch("/api/projects/connectors/disconnect", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, provider }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `connector disconnect ${r.status}`);
  return out;
}

export async function startConnectorOAuth(projectId, provider) {
  const r = await fetch("/api/projects/connectors/oauth/start", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, provider }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `connector authorization ${r.status}`);
  return out;
}

export async function getConnectorWorkflows(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/connector-workflows?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `workflows ${r.status}`);
  return out.workflows || [];
}

export async function saveConnectorWorkflow(projectId, workflow) {
  const r = await fetch("/api/projects/connector-workflows", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...workflow }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `workflow ${r.status}`);
  return out.workflow;
}

export async function deleteConnectorWorkflow(projectId, workflowId) {
  const r = await fetch("/api/projects/connector-workflows", {
    method: "DELETE", headers: await authHeaders(), body: JSON.stringify({ projectId, workflowId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `workflow delete ${r.status}`);
  return out;
}

export async function getProjectAnalytics(projectId, days = 14) {
  const params = new URLSearchParams({ projectId, days: String(days) });
  const r = await fetch(`/api/projects/analytics?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `analytics ${r.status}`);
  return out;
}

export async function getEnvironmentControl(projectId) {
  const params = new URLSearchParams({ projectId });
  const r = await fetch(`/api/projects/environment-control?${params}`, { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `environments ${r.status}`);
  return out;
}

export async function deployTestEnvironment(projectId) {
  const r = await fetch("/api/projects/environment-control/test", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `test deploy ${r.status}`);
  return out;
}

export async function runReleaseAction(projectId, releaseId, action) {
  const r = await fetch("/api/projects/environment-control/release", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, releaseId, action }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `release ${action} ${r.status}`);
  return out;
}

export async function listTemplates() {
  const r = await fetch("/api/templates", { headers: await authHeaders() });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `templates ${r.status}`);
  return out.templates;
}

export async function createTemplate(projectId, template) {
  const r = await fetch("/api/templates", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ projectId, ...template }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `template ${r.status}`);
  return out.template;
}

export async function remixTemplate(templateId, name) {
  const r = await fetch("/api/templates/remix", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ templateId, name }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `template remix ${r.status}`);
  return out.project;
}

export async function deleteTemplate(templateId) {
  const r = await fetch("/api/templates/delete", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ templateId }),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `template delete ${r.status}`);
  return out;
}

export async function getBalance() {
  const r = await fetch("/api/billing/balance", { headers: await authHeaders() });
  if (!r.ok) throw new Error((await r.json()).error || `balance ${r.status}`);
  return r.json();
}

export async function checkout({ tierId, credits }) {
  const r = await fetch("/api/billing/checkout", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ tierId, credits, appUrl: window.location.origin }),
  });
  if (!r.ok) throw new Error((await r.json()).error || `checkout ${r.status}`);
  return r.json();
}

// BYOK settings. The server never returns the raw key — get/save resolve to { set, provider?, hint? }.
export async function getByok() {
  const r = await fetch("/api/settings/byok", { headers: await authHeaders() });
  if (!r.ok) throw new Error((await r.json()).error || `byok ${r.status}`);
  return r.json();
}

export async function saveByok(key) {
  const r = await fetch("/api/settings/byok", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error((await r.json()).error || `byok save ${r.status}`);
  return r.json();
}

export async function clearByok() {
  const r = await fetch("/api/settings/byok", { method: "DELETE", headers: await authHeaders() });
  if (!r.ok) throw new Error((await r.json()).error || `byok clear ${r.status}`);
  return r.json();
}

export async function startPreview({ projectId, tree }) {
  const r = await fetch("/api/preview", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, tree }),
  });
  if (!r.ok) throw new Error((await r.json()).error || `preview ${r.status}`);
  return r.json();
}

function filenameFromDisposition(header) {
  const quoted = /filename="([^"]+)"/i.exec(header || "");
  if (quoted?.[1]) return quoted[1];
  const bare = /filename=([^;]+)/i.exec(header || "");
  if (bare?.[1]) return bare[1].trim();
  return "buildr101-app.zip";
}

export async function downloadProject(projectId) {
  if (!projectId) throw new Error("Save or generate an app before downloading.");
  const r = await fetch("/api/export", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId }),
  });
  if (!r.ok) {
    let message = `export ${r.status}`;
    try { message = (await r.json()).error || message; } catch {}
    throw new Error(message);
  }

  const blob = await r.blob();
  const filename = filenameFromDisposition(r.headers.get("Content-Disposition"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename };
}

// POST /api/android — wrap the published PWA into a signed Android app (APK+AAB) and download the
// zip. Slow (a couple of minutes) — the caller shows a spinner. Same blob→anchor as downloadProject.
export async function downloadAndroid(projectId, tree) {
  const r = await fetch("/api/android", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, tree }),
  });
  if (!r.ok) {
    let message = `android ${r.status}`;
    try { message = (await r.json()).error || message; } catch {}
    throw new Error(message);
  }
  const blob = await r.blob();
  const filename = filenameFromDisposition(r.headers.get("Content-Disposition"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename };
}

// POST /api/publish — build the tree server-side and ship the static dist to the VPS.
// `name` (first publish / rename) becomes the site's subdomain: <name>.app.buildr101.com.
export async function publishProject(projectId, tree, name) {
  const r = await fetch("/api/publish", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, tree, name: name || undefined }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `publish ${r.status}`);
  return out; // { url, files, bytes, slug }
}

// POST /api/projects/delete — delete a project WITH infra cleanup (published site, name claim,
// custom domains, preview container, per-app users/data). Permanent.
export async function deleteProjectFull(projectId) {
  const r = await fetch("/api/projects/delete", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `delete ${r.status}`);
  return out;
}

// POST /api/account/delete — delete the signed-in account and everything it owns: cancels any
// active subscription immediately, tears down every project (published sites, domains, previews,
// per-app users/data), wipes billing rows + BYOK key, then removes the login. Permanent.
export async function deleteAccount() {
  const r = await fetch("/api/account/delete", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ confirm: true }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `account delete ${r.status}`);
  return out;
}

// Server-side balance read — also materializes the one-time welcome grant for new accounts
// (the client-side RLS read can't write ledger rows). Fire once after login.
export async function serverBalance() {
  const r = await fetch("/api/billing/balance", { headers: await authHeaders() });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `balance ${r.status}`);
  return out;
}

// Subscription lifecycle — status, in-place plan switch, cancel/resume at period end.
export async function getSubscription() {
  const r = await fetch("/api/billing/subscription", { headers: await authHeaders() });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `subscription ${r.status}`);
  return out; // { active, tier, cancelAtPeriodEnd, periodEnd }
}

export async function switchPlan(tierId) {
  const r = await fetch("/api/billing/switch", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ tierId }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `switch ${r.status}`);
  return out;
}

export async function cancelPlan(resume = false) {
  const r = await fetch("/api/billing/cancel", {
    method: "POST", headers: await authHeaders(), body: JSON.stringify({ resume }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `cancel ${r.status}`);
  return out;
}

// Custom domains — connect/list/remove a user-owned domain on a published app.
export async function listDomains(projectId) {
  const r = await fetch(`/api/domains?projectId=${encodeURIComponent(projectId)}`, { headers: await authHeaders() });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `domains ${r.status}`);
  return out; // { domains: [{ domain, verified_at }], ip }
}

export async function connectDomain(projectId, domain) {
  const r = await fetch("/api/domains", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, domain }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `connect ${r.status}`);
  return out; // { domain, status: "live"|"pending-dns", ip, hint }
}

export async function removeDomain(projectId, domain) {
  const r = await fetch("/api/domains/remove", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, domain }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `remove ${r.status}`);
  return out;
}

// POST /api/unpublish — remove the published static site (its URL then 404s).
export async function unpublishProject(projectId) {
  const r = await fetch("/api/unpublish", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `unpublish ${r.status}`);
  return out; // { unpublished }
}

// ── background build jobs ───────────────────────────────────────────────────────────────────────
// POST /api/generate creates a detached server-side job and returns immediately — the build no
// longer lives or dies with this tab. The client is a passive observer via watchBuild.

const TERMINAL_STATUSES = ["complete", "failed", "interrupted"];

export async function createBuild({ projectId, prompt, mode, tree, plan, knowledge, fixBuild, style, designProfile, redesign }) {
  const res = await fetch("/api/generate", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, prompt, mode, tree, plan, knowledge, fixBuild, style, designProfile, redesign }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `generate ${res.status}`), { payload: out, status: res.status });
  return out; // { jobId, existing, status, phase }
}

// Observe a job's coarse phase stream (streaming fetch — EventSource can't send the Authorization
// header) until it ends. onPhase(phase) fires per transition; resolves with the terminal job
// { status, phase, error, result }. Reconnects on dropped sockets: the server's snapshot frame
// replays current state, and the build itself never depends on this connection existing.
export async function watchBuild(jobId, onPhase) {
  let failedAttempts = 0;
  for (;;) {
    let sawFrame = false;
    try {
      const res = await fetch(`/api/builds/${encodeURIComponent(jobId)}/events`, { headers: await authHeaders() });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        throw Object.assign(new Error(out.error || `events ${res.status}`), { status: res.status, hard: true });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const frame of frames) {
          const evLine = frame.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!evLine || !dataLine) continue;
          sawFrame = true;
          let data = {};
          try { data = JSON.parse(dataLine.slice(5).trim()); } catch {}
          if (TERMINAL_STATUSES.includes(data.status)) return data;
          if (data.phase) onPhase?.(data.phase, data);
        }
      }
    } catch (e) {
      if (e.hard) throw e; // 404/401 — retrying won't help
    }
    // Stream ended without a terminal frame (network blip / proxy timeout) — reattach. Frames
    // flowing resets the failure count; only repeated dead connections give up.
    failedAttempts = sawFrame ? 0 : failedAttempts + 1;
    if (failedAttempts >= 6) {
      throw new Error("Lost contact with the build — it keeps running; reopen the project to check on it.");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// The running (or most recent) build for a project — reattach-on-open.
export async function activeBuild(projectId) {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/active-build`, { headers: await authHeaders() });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `active-build ${r.status}`);
  return (await r.json()).job; // whitelisted job or null
}

export async function cancelBuild(jobId) {
  const r = await fetch(`/api/builds/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST", headers: await authHeaders(),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `cancel ${r.status}`);
  return out;
}
