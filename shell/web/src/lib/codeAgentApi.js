import { accessToken } from "./backend.js";

async function request(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(path, {
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
  const response = await fetch(`/api/v1/runs/${runId}/events?after=${after}`, {
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
