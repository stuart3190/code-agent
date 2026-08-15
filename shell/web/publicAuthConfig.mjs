import crypto from "node:crypto";

const URL_SOURCES = ["VITE_SUPABASE_URL", "SUPABASE_URL"];
const KEY_SOURCES = [
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
];
const PRIVILEGED_SOURCES = [
  "VITE_SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE",
  "SUPABASE_SECRET_KEY",
];

function firstValue(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: null, value: "" };
}

function jwtRole(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role || null;
  } catch {
    return null;
  }
}

export function publicKeyKind(value) {
  const key = String(value || "").trim();
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  const role = jwtRole(key);
  if (role === "anon") return "legacy_anon";
  if (role === "service_role") return "legacy_service_role";
  return key ? "unknown" : "missing";
}

export function resolvePublicAuthConfig(env = {}, { required = false } = {}) {
  const urlEntry = firstValue(env, URL_SOURCES);
  const keyEntry = firstValue(env, KEY_SOURCES);
  const privilegedEntry = firstValue(env, PRIVILEGED_SOURCES);

  if (!urlEntry.value || !keyEntry.value) {
    if (required) {
      throw new Error(
        "Public Supabase auth configuration is required: set SUPABASE_URL and "
        + "SUPABASE_PUBLISHABLE_KEY (SUPABASE_ANON_KEY remains a legacy fallback).",
      );
    }
    return {
      configured: false,
      url: urlEntry.value,
      key: keyEntry.value,
      urlSource: urlEntry.name,
      keySource: keyEntry.name,
      keyKind: publicKeyKind(keyEntry.value),
      privilegedValues: privilegedEntry.value ? [privilegedEntry.value] : [],
    };
  }

  let parsed;
  try {
    parsed = new URL(urlEntry.value);
  } catch {
    throw new Error(`Public Supabase URL from ${urlEntry.name} is not a valid URL.`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Public Supabase URL from ${urlEntry.name} must use HTTP or HTTPS.`);
  }

  const keyKind = publicKeyKind(keyEntry.value);
  if (!new Set(["publishable", "legacy_anon"]).has(keyKind)) {
    throw new Error(
      `Public Supabase key from ${keyEntry.name} is not a publishable or legacy anon key (${keyKind}).`,
    );
  }

  return {
    configured: true,
    url: parsed.toString().replace(/\/$/, ""),
    key: keyEntry.value,
    urlSource: urlEntry.name,
    keySource: keyEntry.name,
    keyKind,
    keyFingerprint: crypto.createHash("sha256").update(keyEntry.value).digest("hex").slice(0, 12),
    privilegedValues: PRIVILEGED_SOURCES
      .map((name) => String(env[name] || "").trim())
      .filter(Boolean),
  };
}

export function containsPrivilegedSupabaseCredential(text, privilegedValues = []) {
  const value = String(text || "");
  if (/sb_secret_[A-Za-z0-9_-]+/.test(value)) return true;
  for (const match of value.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    if (jwtRole(match[0]) === "service_role") return true;
  }
  return privilegedValues.some((secret) => secret.length >= 16 && value.includes(secret));
}
