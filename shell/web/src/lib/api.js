// Fetch wrappers to the shell server. Every authenticated call attaches the Supabase access token
// so the server resolves owner = auth.uid() (it never trusts an owner id from the body).

import { accessToken } from "./backend.js";

async function authHeaders(extra = {}) {
  const token = await accessToken();
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export async function getConfig() {
  const r = await fetch("/api/config");
  return r.json();
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

export async function startPreview({ projectId, tree }) {
  const r = await fetch("/api/preview", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, tree }),
  });
  if (!r.ok) throw new Error((await r.json()).error || `preview ${r.status}`);
  return r.json();
}

// POST /api/generate and consume the SSE stream via streaming fetch (EventSource can't send the
// Authorization header). onEvent(name, data) fires per event; resolves with the final "done" payload.
export async function generate({ projectId, prompt, mode, tree }, onEvent) {
  const res = await fetch("/api/generate", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, prompt, mode, tree }),
  });
  if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
    const err = await res.json();
    throw Object.assign(new Error(err.error || `generate ${res.status}`), { payload: err, status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = null;
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const frame of frames) {
      const evLine = frame.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!evLine || !dataLine) continue;
      const name = evLine.slice(6).trim();
      let data = {};
      try { data = JSON.parse(dataLine.slice(5).trim()); } catch {}
      onEvent?.(name, data);
      if (name === "done") done = data;
      if (name === "error") throw new Error(data.message || "generation error");
    }
  }
  return done;
}
