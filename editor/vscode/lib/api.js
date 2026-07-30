// Thrallo API client for editor integrations. Deliberately free of any vscode dependency so
// the control-plane wiring is unit-testable in the repository's node test suite.

"use strict";

class ThralloClient {
  constructor({ serverUrl, token, fetchImpl = fetch }) {
    this.base = String(serverUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    if (!/^https?:\/\//.test(this.base)) throw new Error("Server URL must start with http(s)://");
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.base}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${this.token}`,
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Thrallo request failed (${response.status})`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  capabilities() { return this.request("/api/v1/capabilities"); }
  listRepositories() { return this.request("/api/v1/repositories"); }
  listAgents() { return this.request("/api/v1/agents"); }
  latestRun(agentId) { return this.request(`/api/v1/agents/${agentId}/runs/latest`); }
  getRun(runId) { return this.request(`/api/v1/runs/${runId}`); }
  runArtifacts(runId) { return this.request(`/api/v1/runs/${runId}/artifacts`); }
  cancelRun(runId) { return this.request(`/api/v1/runs/${runId}/cancel`, { method: "POST" }); }
  resumeRun(runId) { return this.request(`/api/v1/runs/${runId}/resume`, { method: "POST", body: "{}" }); }

  createRun(agentId, prompt, mode = "agent") {
    return this.request(`/api/v1/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt, mode, model: "auto" }),
    });
  }

  publishRun(runId, title) {
    return this.request(`/api/v1/runs/${runId}/publish`, {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
  }

  // Streams run events; onEvent receives each parsed event. Resolves with the last sequence
  // when the server closes the stream (terminal state or waiting for approval).
  async streamRunEvents(runId, onEvent, { signal, after = 0 } = {}) {
    const response = await this.fetch(`${this.base}/api/v1/runs/${runId}/events?after=${after}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Event stream failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last = after;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(block);
        if (!event) continue;
        last = Math.max(last, Number(event.sequence || 0));
        onEvent(event);
      }
    }
    return last;
  }
}

function parseEventBlock(block) {
  const data = block.split("\n").find((line) => line.startsWith("data: "));
  if (!data) return null;
  try { return JSON.parse(data.slice(6)); } catch { return null; }
}

function describeEvent(event) {
  const payload = event.payload || {};
  const text = payload.message || payload.error || payload.text || payload.name || "";
  return `[${event.type}] ${text}`.trim();
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

module.exports = { ThralloClient, parseEventBlock, describeEvent, TERMINAL_STATES };
