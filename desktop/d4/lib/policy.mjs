import crypto from "node:crypto";

export const D4_RESOURCE_PREFIX = "thrallo-d4-";
export const D4_LABELS = Object.freeze({
  "thrallo.spike": "d4",
  "thrallo.data": "synthetic-only",
  "thrallo.production": "false",
});

const FORBIDDEN_IDENTIFIERS = [
  /app\.thrallo\.com/i,
  /api\.thrallo\.com/i,
  /\/api\/v\d+\//i,
  /builder[-_]?v2/i,
  /package[-_]?14r/i,
  /package[-_]?15/i,
  /\bprod(?:uction)?\b/i,
  /\bcustomer\b/i,
  /\bowner[_-]?id\b/i,
];

export function createRunId({ now = new Date(), randomBytes = crypto.randomBytes } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  const entropy = randomBytes(4).toString("hex");
  return `${stamp}-${entropy}`;
}

export function resourceName(runId, suffix) {
  const name = `${D4_RESOURCE_PREFIX}${String(runId)}-${String(suffix)}`.toLowerCase();
  assertSyntheticResourceName(name);
  return name;
}

export function assertSyntheticResourceName(name) {
  const value = String(name || "");
  if (!value.startsWith(D4_RESOURCE_PREFIX) || !/^[a-z0-9-]{12,80}$/.test(value)) {
    throw new Error("D4 resources require the isolated synthetic naming prefix");
  }
  if (FORBIDDEN_IDENTIFIERS.some((pattern) => pattern.test(value))) {
    throw new Error("D4 resource name contains a forbidden production identifier");
  }
  return value;
}

export function assertSyntheticPayload(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const pattern of FORBIDDEN_IDENTIFIERS) {
    if (pattern.test(serialized)) throw new Error(`D4 payload rejected by synthetic-only policy: ${pattern}`);
  }
  if (/sk-[a-z0-9_-]{12,}/i.test(serialized) || /bearer\s+[a-z0-9._-]{12,}/i.test(serialized)) {
    throw new Error("D4 payload appears to contain credential material");
  }
  return value;
}

export function assertLiveSpikeConfiguration({ confirmed, apiUrl, target }) {
  if (!confirmed) throw new Error("Live D4 execution requires --confirm-synthetic");
  const parsed = new URL(String(apiUrl || ""));
  if (parsed.protocol !== "https:" || !/(^|\.)daytona\.io$/i.test(parsed.hostname)) {
    throw new Error("D4 only permits the configured Daytona control API");
  }
  if (!/^[a-z0-9-]{2,24}$/i.test(String(target || ""))) throw new Error("D4 requires an explicit Daytona target");
  return { apiOrigin: parsed.origin, target: String(target) };
}

export function redactedError(error) {
  const raw = String(error?.message || error || "unknown error");
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[url-redacted]")
    .replace(/(?:token|key|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/sk-[a-z0-9_-]+/gi, "[credential-redacted]")
    .slice(0, 600);
}
