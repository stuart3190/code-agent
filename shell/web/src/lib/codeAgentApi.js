import { accessToken, apiBase } from "./backend.js";

async function request(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export async function capabilities() {
  const response = await fetch("/api/v1/capabilities");
  if (!response.ok) throw new Error("Control plane is unavailable");
  return response.json();
}

export const listRepositories = () => request("/api/v1/repositories");
export const addRepository = (body) => request("/api/v1/repositories", { method: "POST", body: JSON.stringify(body) });
export const repositoryIndex = (repositoryId) => request(`/api/v1/repositories/${repositoryId}/index`);
export const refreshRepositoryIndex = (repositoryId) => request(`/api/v1/repositories/${repositoryId}/index/refresh`, {
  method: "POST",
});
export const searchRepository = (repositoryId, query) => request(`/api/v1/repositories/${repositoryId}/search`, {
  method: "POST", body: JSON.stringify({ query }),
});
export const searchRepositorySymbols = (repositoryId, query) =>
  request(`/api/v1/repositories/${repositoryId}/symbols/search`, {
    method: "POST", body: JSON.stringify({ query }),
  });
export const repositoryPulls = (repositoryId) => request(`/api/v1/repositories/${repositoryId}/pulls`);
export const repositoryFileGraph = (repositoryId, path) =>
  request(`/api/v1/repositories/${repositoryId}/graph`, {
    method: "POST", body: JSON.stringify({ path }),
  });
export const listAgents = () => request("/api/v1/agents");
export const addAgent = (body) => request("/api/v1/agents", { method: "POST", body: JSON.stringify(body) });
export const createRun = (agentId, body) => request(`/api/v1/agents/${agentId}/runs`, {
  method: "POST", body: JSON.stringify(body),
});
export const getLatestRun = (agentId) => request(`/api/v1/agents/${agentId}/runs/latest`);
export const getRun = (runId) => request(`/api/v1/runs/${runId}`);
export const cancelRun = (runId) => request(`/api/v1/runs/${runId}/cancel`, { method: "POST" });
export const publishRun = (runId, body = {}) => request(`/api/v1/runs/${runId}/publish`, {
  method: "POST", body: JSON.stringify(body),
});
export const runArtifacts = (runId) => request(`/api/v1/runs/${runId}/artifacts`);
export const retryRun = (runId) => request(`/api/v1/runs/${runId}/retry`, { method: "POST" });
export const resumeRun = (runId, body = {}) => request(`/api/v1/runs/${runId}/resume`, {
  method: "POST", body: JSON.stringify(body),
});
export const updateAgent = (agentId, body) => request(`/api/v1/agents/${agentId}`, {
  method: "PATCH", body: JSON.stringify(body),
});
export async function artifactContent(runId, artifactId) {
  const token = await accessToken();
  const response = await fetch(`/api/v1/runs/${runId}/artifacts/${artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Artifact content failed (${response.status})`);
  return response.text();
}
export const usageSummary = () => request("/api/v1/usage");
export const billingOverview = () => request("/api/v1/billing");
export const selectPlan = (plan) => request("/api/v1/billing/plan", {
  method: "POST", body: JSON.stringify({ plan }),
});
export const updateBudgets = (body) => request("/api/v1/billing/budgets", {
  method: "POST", body: JSON.stringify(body),
});
export const billingPortal = () => request("/api/v1/billing/portal", { method: "POST" });
export const opsTelemetry = () => request("/api/v1/ops/telemetry");
export const usageInsights = () => request("/api/v1/usage/insights");
export const buildCostSummary = (buildId) => request(`/api/v1/usage/builds/${buildId}`);
export const adminAnalytics = () => request("/api/v1/admin/analytics");
export const adminIntelligence = () => request("/api/v1/admin/intelligence");
export const listDiagnostics = (projectId = null) =>
  request(`/api/v1/diagnostics${projectId ? `?project=${projectId}` : ""}`);
export const getDiagnostics = (runId) => request(`/api/v1/diagnostics/${runId}`);
export const getDiagnosticsStep = (runId, seq) => request(`/api/v1/diagnostics/${runId}/step/${seq}`);
export const explainDiagnostics = (runId) => request(`/api/v1/diagnostics/${runId}/explain`, { method: "POST" });
export const diagnosticsRequests = (runId) => request(`/api/v1/diagnostics/${runId}/requests`);
export const listIncidents = (conversationId = null) =>
  request(`/api/v1/diagnostics/incidents${conversationId ? `?conversation=${conversationId}` : ""}`);
export const incidentDetails = (reference) => request(`/api/v1/diagnostics/incidents/${reference}`);
export const diagnosticsPrefs = () => request("/api/v1/diagnostics/prefs");
export const setDiagnosticsPrefs = (retentionDays) => request("/api/v1/diagnostics/prefs", {
  method: "POST", body: JSON.stringify({ retentionDays }),
});
// Filtering and paging are server-side: the client only ever holds one page, so filtering here
// would silently hide everything after it and a tab count would describe the page rather than the
// account.
export const listConversations = ({ tab = null, q = "", offset = 0, limit = 0 } = {}) => {
  const query = new URLSearchParams();
  if (tab && tab !== "all") query.set("tab", tab);
  if (q) query.set("q", q);
  if (offset) query.set("offset", String(offset));
  if (limit) query.set("limit", String(limit));
  const suffix = query.toString();
  return request(`/api/v1/conversations${suffix ? `?${suffix}` : ""}`);
};
export const startConversation = (text, workspaceContext = null, modelPref = null) => request("/api/v1/conversations", {
  method: "POST", body: JSON.stringify({ text, workspaceContext, modelPref }),
});
export const getConversation = (conversationId) => request(`/api/v1/conversations/${conversationId}`);
export const deleteConversation = (conversationId, { permanent = false } = {}) =>
  request(`/api/v1/conversations/${conversationId}${permanent ? "?permanent=1" : ""}`, { method: "DELETE" });
export const listDeletedConversations = () => request("/api/v1/conversations/deleted");
export const restoreConversation = (conversationId) =>
  request(`/api/v1/conversations/${conversationId}/restore`, { method: "POST" });
export const sendConversationMessage = (conversationId, text, workspaceContext = null) =>
  request(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST", body: JSON.stringify({ text, workspaceContext }),
  });
export const listModels = () => request("/api/v1/models");
export const setConversationModel = (conversationId, value) =>
  request(`/api/v1/conversations/${conversationId}/model`, { method: "POST", body: JSON.stringify({ value }) });
export const setPreviewPlan = (plan) => request("/api/v1/owner/preview-plan", {
  method: "POST", body: JSON.stringify({ plan }),
});
export const notificationsConfig = () => request("/api/v1/notifications/config");
export const subscribeNotifications = (subscription) => request("/api/v1/notifications/subscribe", {
  method: "POST", body: JSON.stringify({ subscription }),
});
export async function streamConversationEvents(conversationId, onEvent, { signal, after = 0 } = {}) {
  const token = await accessToken();
  const response = await fetch(`${apiBase()}/api/v1/conversations/${conversationId}/events?after=${after}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) throw new Error(`Conversation stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      after = Math.max(after, Number(event.sequence || 0));
      onEvent(event);
    }
  }
  return after;
}
export const listAutomations = () => request("/api/v1/automations");
export const createAutomation = (body) => request("/api/v1/automations", {
  method: "POST", body: JSON.stringify(body),
});
export const updateAutomation = (automationId, body) => request(`/api/v1/automations/${automationId}`, {
  method: "PATCH", body: JSON.stringify(body),
});
export const deleteAutomation = (automationId) => request(`/api/v1/automations/${automationId}`, {
  method: "DELETE",
});
export const listApiTokens = () => request("/api/v1/tokens");
export const createApiToken = (name) => request("/api/v1/tokens", {
  method: "POST", body: JSON.stringify({ name }),
});
export const revokeApiToken = (tokenId) => request(`/api/v1/tokens/${tokenId}`, { method: "DELETE" });
export const githubInstallations = () => request("/api/v1/github/installations");
export const startGithubInstallation = () => request("/api/v1/github/installations/start", { method: "POST" });
export const githubInstallationRepositories = (installationId) =>
  request(`/api/v1/github/installations/${installationId}/repositories`);
export const connectGithubRepository = (installationId, repositoryId) =>
  request("/api/v1/github/repositories/connect", {
    method: "POST", body: JSON.stringify({ installationId, repositoryId }),
  });
export const aiConnections = () => request("/api/v1/ai/connections");
export const connectAiKey = (provider, key) => request("/api/v1/ai/byok", {
  method: "POST", body: JSON.stringify({ provider, key }),
});
export const selectAiProvider = (provider) => request("/api/v1/ai/provider", {
  method: "POST", body: JSON.stringify({ provider }),
});
export const disconnectAiProvider = (provider) => request("/api/v1/ai/disconnect", {
  method: "POST", body: JSON.stringify({ provider }),
});
export const updateAiRouting = (body) => request("/api/v1/ai/routing", {
  method: "POST", body: JSON.stringify(body),
});
// Optional BYOK spending safeguards. Numbers and nulls only — no key material is ever sent
// or returned by this endpoint.
export const saveByokSafety = (body) => request("/api/v1/ai/byok-safety", {
  method: "POST", body: JSON.stringify(body),
});

// Stop a running build. The server flags the job; the runner aborts between engine turns and
// the relay classifies it as `cancelled`, so nothing further is dispatched or charged.
// A build that finished first answers "already finished" — that is a normal outcome, not an
// error, and the caller treats it as success.
export const cancelBuild = (jobId) => request(`/api/builds/${encodeURIComponent(jobId)}/cancel`, {
  method: "POST",
});
export const aiEvaluations = () => request("/api/v1/ai/evaluations");
export const runAiEvaluation = (body) => request("/api/v1/ai/evaluations", {
  method: "POST", body: JSON.stringify(body),
});
export const startCodexLogin = () => request("/api/v1/ai/codex/login/start", { method: "POST" });
export const codexLoginStatus = (sessionId) => request(`/api/v1/ai/codex/login/${sessionId}`);
export const cancelCodexLogin = (sessionId) => request(`/api/v1/ai/codex/login/${sessionId}`, {
  method: "DELETE",
});

export async function streamRunEvents(runId, onEvent, { signal, after = 0 } = {}) {
  const token = await accessToken();
  const response = await fetch(`${apiBase()}/api/v1/runs/${runId}/events?after=${after}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Event stream failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      after = Math.max(after, Number(event.sequence || 0));
      onEvent(event);
    }
  }
  return after;
}

export const publishState = () => request("/api/v1/publish-state");

// The export route answers with a ZIP, not JSON, so it cannot go through request(). Returns a
// blob for the caller to save; errors still arrive as JSON and are surfaced normally.
export async function exportProjectZip(projectId) {
  const token = await accessToken();
  const response = await fetch(`${apiBase()}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Export failed (${response.status})`);
  }
  const disposition = response.headers.get("Content-Disposition") || "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "thrallo-app.zip";
  return { blob: await response.blob(), filename: name };
}

export const unpublishProject = (projectId) =>
  request(`/api/v1/projects/${projectId}/unpublish`, { method: "POST" });

// Custom domains. Every call answers with the full list plus the plan allowance, so the panel
// settles from one response instead of re-reading after each change.
export const listDomains = (projectId) => request(`/api/v1/projects/${projectId}/domains`);
export const addDomain = (projectId, domain) =>
  request(`/api/v1/projects/${projectId}/domains`, { method: "POST", body: JSON.stringify({ domain }) });
export const verifyDomain = (projectId, domain) =>
  request(`/api/v1/projects/${projectId}/domains/verify`, { method: "POST", body: JSON.stringify({ domain }) });
export const retryDomain = (projectId, domain) =>
  request(`/api/v1/projects/${projectId}/domains/retry`, { method: "POST", body: JSON.stringify({ domain }) });
export const removeDomain = (projectId, domain) =>
  request(`/api/v1/projects/${projectId}/domains/remove`, { method: "POST", body: JSON.stringify({ domain }) });

// Thrallo Analytics (owner-scoped reads; the public beacon is posted by published sites).
export const projectAnalytics = (projectId, days = 30) =>
  request(`/api/v1/projects/${projectId}/analytics?days=${days}`);
export const projectAnalyticsLive = (projectId) =>
  request(`/api/v1/projects/${projectId}/analytics/live`);
export const projectDeployments = (projectId) =>
  request(`/api/v1/projects/${projectId}/deployments`);
export const projectHealth = (projectId) => request(`/api/v1/projects/${projectId}/health`);

// Project logs. The stream and export are plain URLs because EventSource and <a download> take
// URLs, not fetch options — both still go through the same owner-scoped routes.
export const projectLogs = (projectId, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return request(`/api/v1/projects/${projectId}/logs?${query}`);
};
export const projectBuildRuns = (projectId) => request(`/api/v1/projects/${projectId}/logs/runs`);
export const logStreamUrl = (projectId, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `${apiBase()}/api/v1/projects/${projectId}/logs/stream?${query}`;
};
export const logExportUrl = (projectId, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `${apiBase()}/api/v1/projects/${projectId}/logs/export?${query}`;
};
