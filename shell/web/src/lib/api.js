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

// POST /api/generate and consume the SSE stream via streaming fetch (EventSource can't send the
// Authorization header). onEvent(name, data) fires per event; resolves with the final "done" payload.
export async function generate({ projectId, prompt, mode, tree, plan }, onEvent) {
  const res = await fetch("/api/generate", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ projectId, prompt, mode, tree, plan }),
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
