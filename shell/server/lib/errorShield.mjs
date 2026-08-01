// The error shield. Normal users never see raw technical failure detail — every incident
// is captured PRIVATELY (full message, stack, provider/DB code, service, ids, logs, retry
// count, timestamp) into diag_incidents, and the conversation only ever receives a calm,
// sanitised sentence plus a short support reference (THR-XXXXXX).
//
// Nothing here hides that a failure happened: the user is told plainly, in their language,
// what is being done about it. The technical truth goes to the Lead Agent and Diagnostics.

import { randomUUID, createHash } from "node:crypto";
import { serviceClient } from "./supabase.mjs";

// ── Sanitisation ────────────────────────────────────────────────────────────────────────
// Anything resembling internals is scrubbed. Applied to EVERY user-facing failure string,
// including ones written by the model, so a leak needs two independent bugs.

// ORDER MATTERS: whole-phrase database errors are scrubbed BEFORE the narrower
// constraint-name rule, otherwise the name is removed and the surrounding SQL phrase
// ("duplicate key value violates unique …") survives as a fragment.
const SCRUB = [
  [/\b(?:duplicate key value violates unique constraint|violates foreign key constraint|violates check constraint|violates not-null constraint|null value in column)[^.\n]*/gi, "a record conflict"],
  [/\b(sk|xai|sk-ant|AIza)[-_][A-Za-z0-9_-]{6,}/g, "[key]"],              // api keys
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]"], // jwts
  [/(?:[A-Za-z]:\\|\/(?:home|usr|var|etc|root|tmp|opt)\/)[^\s"')]*/g, "[path]"], // fs paths
  [/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.|192\.168\.|[^\s"')]*\.(?:internal|supabase\.co))[^\s"')]*/g, "[internal service]"],
  [/\b(?:constraint|relation|column|table|index)\s+"[^"]+"/gi, "a database record"],
  [/\bca_[a-z_]+\b|\bdiag_[a-z_]+\b|\bapp_[a-z_]+\b|\bai_requests\b|\bbuild_jobs\b|\bpublished_sites\b/g, "a database record"],
  [/\b(?:at\s+(?:async\s+)?[\w.$<>[\]]+\s*\([^)]*\)|at\s+[^\s]+:\d+:\d+)/g, ""], // stack frames
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ""],      // raw uuids
  [/\b(?:PGRST\d+|SQLSTATE|ERRCODE|errno|ENOENT|ECONNREFUSED|ETIMEDOUT|HTTP\s*\d{3}|status\s*(?:code)?\s*\d{3})\b[^.\n]*/gi, ""],
];

// Phrases that mean the sentence is fundamentally technical — replaced wholesale.
const TECHNICAL_MARKERS = /\b(stack trace|traceback|exception|sql|postgres|psql|supabase|node_modules|undefined is not|cannot read propert|typeerror|referenceerror|syntaxerror|econn|enoent|duplicate key|violates|constraint|record conflict|database record|http \d{3}|status \d{3}|\d{3} error|\b5\d\d\b)\b/i;

export function sanitizeUserFacingText(text, fallback = "Something needed attention on our side.") {
  let out = String(text || "");
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
  // Only genuinely empty output falls back — short real replies ("OK", "Yes", "Done")
  // are legitimate answers and must survive untouched.
  if (!out) return fallback;
  if (TECHNICAL_MARKERS.test(out)) return fallback;
  // A long UNPUNCTUATED blob is machine output; long prose (a helpful explanation with
  // sentences) is exactly what we want to keep, so length alone must never disqualify it.
  const looksLikeProse = /[.!?]\s/.test(out) || out.includes("\n");
  if (out.length > 320 && !looksLikeProse) return fallback;
  return out;
}

// ── Classification ──────────────────────────────────────────────────────────────────────

const RETRYABLE = /(timeout|timed out|rate.?limit|overload|unavailable|temporarily|connection|econn|reset|conflict|duplicate key|serializ|deadlock|429|5\d\d)/i;
const USER_ACTIONABLE = /(allowance|budget|quota|not connected|sign in|unauthor|forbidden|payment|credential)/i;

export function classifyFailure(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  const status = Number(error?.status || 0);
  if (USER_ACTIONABLE.test(text)) return { kind: "needs_user", retryable: false };
  if (RETRYABLE.test(text) || status === 429 || status >= 500 || status === 409) {
    return { kind: "transient", retryable: true };
  }
  return { kind: "unexpected", retryable: false };
}

// Stable fingerprint so identical failures can be recognised and stopped.
export function fingerprintIncident(error, service = "") {
  const normalized = `${service}|${error?.code || ""}|${String(error?.message || "")
    .toLowerCase()
    .replace(/[0-9a-f-]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .slice(0, 200)}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function referenceFrom(id) {
  return `THR-${createHash("sha1").update(String(id)).digest("hex").slice(0, 6).toUpperCase()}`;
}

// ── Friendly copy (never technical; never blames the user) ─────────────────────────────

export const FRIENDLY = {
  saving: "I hit a temporary issue while saving progress. I'm fixing it now — you don't need to do anything.",
  check: "One of the checks found a problem. I'm repairing it and will continue automatically.",
  provider: "The model service was briefly unavailable. I'm retrying now — nothing for you to do.",
  recovered: "That issue is fixed and the build is continuing.",
  unresolved: "I couldn't resolve this automatically. Your work is safe and the technical details have been saved for support.",
};

export function friendlyFor(service, classification) {
  if (classification?.kind === "needs_user") return null; // caller supplies its own sanitised sentence
  if (service === "conversation_events" || service === "persistence") return FRIENDLY.saving;
  if (service === "model" || service === "provider") return FRIENDLY.provider;
  if (service === "verification" || service === "build") return FRIENDLY.check;
  return FRIENDLY.saving;
}

// ── Private capture ─────────────────────────────────────────────────────────────────────

export async function captureIncident({
  error,
  owner = null,
  conversationId = null,
  buildId = null,
  runId = null,
  service = "platform",
  agent = null,
  model = null,
  logs = null,
  retryCount = 0,
  client = null,
} = {}) {
  const id = randomUUID();
  const reference = referenceFrom(id);
  const classification = classifyFailure(error);
  const record = {
    id,
    reference,
    owner,
    conversation_id: conversationId,
    build_id: buildId,
    run_id: runId,
    service,
    agent,
    model,
    code: String(error?.code || error?.status || classification.kind).slice(0, 120),
    message: String(error?.message || error || "").slice(0, 4000),
    stack: String(error?.stack || "").slice(0, 8000),
    logs: logs ? String(logs).slice(0, 8000) : null,
    retry_count: retryCount,
    created_at: new Date().toISOString(),
  };
  // Fire-and-forget: capturing an incident must never itself break the caller.
  try {
    const db = client || serviceClient();
    await db.from("diag_incidents").insert(record);
  } catch (writeError) {
    console.error(`[incident ${reference}] capture failed:`, writeError.message);
  }
  // The operator log keeps the full truth; the conversation never sees it.
  console.error(`[incident ${reference}] ${service}: ${record.code} — ${record.message}`);
  return {
    id,
    reference,
    classification,
    fingerprint: fingerprintIncident(error, service),
    // What the USER may see — sanitised, calm, and never technical.
    friendly: friendlyFor(service, classification),
    unresolvedMessage: `${FRIENDLY.unresolved}\n\nError reference: ${reference}`,
    // What the LEAD AGENT may see privately (full detail, for classification + repair).
    privateBriefing: [
      `PRIVATE FAILURE REPORT (never repeat any of this to the user):`,
      `reference: ${reference}`,
      `service: ${service}${agent ? ` · agent: ${agent}` : ""}${model ? ` · model: ${model}` : ""}`,
      `code: ${record.code}`,
      `message: ${record.message}`,
      record.stack ? `stack: ${record.stack.slice(0, 1200)}` : null,
      `classification: ${classification.kind} (retry ${classification.retryable ? "is" : "is NOT"} safe)`,
      `retry count so far: ${retryCount}`,
    ].filter(Boolean).join("\n"),
  };
}

export async function markIncidentResolved(id, resolution, { client = null } = {}) {
  try {
    const db = client || serviceClient();
    await db.from("diag_incidents").update({ resolved: true, resolution: String(resolution || "recovered").slice(0, 300) }).eq("id", id);
  } catch { /* resolution bookkeeping is best-effort */ }
}

// ── Owner-scoped reads (Advanced Diagnostics) ──────────────────────────────────────────

export async function listIncidents(owner, { conversationId = null, limit = 50, client = null } = {}) {
  const db = client || serviceClient();
  let query = db.from("diag_incidents").select("*").eq("owner", owner)
    .order("created_at", { ascending: false }).limit(limit);
  if (conversationId) query = query.eq("conversation_id", conversationId);
  const { data } = await query;
  return (data || []).map(publicIncident);
}

export async function incidentByReference(owner, reference, { client = null } = {}) {
  const db = client || serviceClient();
  const { data } = await db.from("diag_incidents").select("*")
    .eq("reference", String(reference || "").toUpperCase()).eq("owner", owner).maybeSingle();
  return data ? publicIncident(data) : null;
}

// Even the owner's advanced view never receives another user's identifiers.
function publicIncident(row) {
  return {
    reference: row.reference,
    service: row.service,
    agent: row.agent,
    model: row.model,
    code: row.code,
    message: row.message,
    stack: row.stack,
    logs: row.logs,
    retryCount: row.retry_count,
    resolved: row.resolved,
    resolution: row.resolution,
    conversationId: row.conversation_id,
    buildId: row.build_id,
    runId: row.run_id,
    createdAt: row.created_at,
  };
}
