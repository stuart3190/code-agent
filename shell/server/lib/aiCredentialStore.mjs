import { optionalEnv } from "./env.mjs";
import { decryptSecret, encryptedStorageConfigured, encryptSecret, secretHint } from "./secretCrypto.mjs";
import { serviceClient } from "./supabase.mjs";

const API_KEY_PROVIDERS = new Set(["openai", "anthropic", "gemini"]);
const ACTIVE_PROVIDERS = new Set(["managed", "codex", ...API_KEY_PROVIDERS]);
const ROUTING_MODES = new Set(["balanced", "quality", "fast", "economy", "manual"]);
const now = () => new Date().toISOString();

export function aiCredentialStorageConfigured() {
  return encryptedStorageConfigured();
}

export async function aiConnectionSummary(owner, { store = aiCredentialStore() } = {}) {
  const [credentials, preference] = await Promise.all([
    store.listCredentials(owner),
    store.getPreference(owner),
  ]);
  return {
    configured: aiCredentialStorageConfigured(),
    activeProvider: preference?.active_provider || "managed",
    routing: publicRoutingPreference(preference),
    connections: credentials.map(publicCredential),
  };
}

export async function connectApiKey(owner, provider, rawKey, {
  store = aiCredentialStore(),
  fetchImpl = fetch,
} = {}) {
  const normalized = String(provider || "").toLowerCase();
  if (!API_KEY_PROVIDERS.has(normalized)) throw inputError("Unsupported API-key provider.");
  const key = String(rawKey || "").trim();
  validateApiKey(normalized, key);
  if (!aiCredentialStorageConfigured()) throw setupError();
  await verifyApiKey(normalized, key, fetchImpl);
  const timestamp = now();
  const credential = await store.setCredential(owner, {
    provider: normalized,
    auth_mode: "api_key",
    secret_encrypted: encryptSecret(key),
    secret_hint: secretHint(key),
    status: "connected",
    metadata: {},
    last_error: null,
    last_verified_at: timestamp,
    updated_at: timestamp,
  });
  await store.setPreference(owner, normalized);
  return publicCredential(credential);
}

export async function connectCodexAuth(owner, authJson, account = {}, {
  store = aiCredentialStore(),
} = {}) {
  if (!aiCredentialStorageConfigured()) throw setupError();
  const serialized = normalizedAuthJson(authJson);
  const timestamp = now();
  const email = safeString(account.email, 320);
  const planType = safeString(account.planType, 80);
  const credential = await store.setCredential(owner, {
    provider: "codex",
    auth_mode: "chatgpt",
    secret_encrypted: encryptSecret(serialized),
    secret_hint: email || (planType ? `ChatGPT ${planType}` : "ChatGPT account"),
    status: "connected",
    metadata: { email, planType },
    last_error: null,
    last_verified_at: timestamp,
    updated_at: timestamp,
  });
  await store.setPreference(owner, "codex");
  return publicCredential(credential);
}

export async function refreshCodexAuth(owner, authJson, account = {}, {
  store = aiCredentialStore(),
} = {}) {
  const current = await store.getCredential(owner, "codex");
  if (!current) throw inputError("Codex is not connected.", 409, "codex_not_connected");
  const serialized = normalizedAuthJson(authJson);
  const email = safeString(account.email, 320) || current.metadata?.email || null;
  const planType = safeString(account.planType, 80) || current.metadata?.planType || null;
  const credential = await store.setCredential(owner, {
    ...current,
    secret_encrypted: encryptSecret(serialized),
    secret_hint: email || current.secret_hint,
    status: "connected",
    metadata: { email, planType },
    last_error: null,
    last_used_at: now(),
    updated_at: now(),
  });
  return publicCredential(credential);
}

export async function selectAiProvider(owner, provider, { store = aiCredentialStore() } = {}) {
  const normalized = String(provider || "").toLowerCase();
  if (!ACTIVE_PROVIDERS.has(normalized)) throw inputError("Unsupported AI provider.");
  if (normalized !== "managed") {
    const credential = await store.getCredential(owner, normalized);
    if (!credential || credential.status !== "connected") {
      throw inputError(`Connect ${providerLabel(normalized)} before selecting it.`, 409, "provider_not_connected");
    }
  }
  await store.setPreference(owner, normalized);
  return aiConnectionSummary(owner, { store });
}

export async function disconnectAiProvider(owner, provider, { store = aiCredentialStore() } = {}) {
  const normalized = String(provider || "").toLowerCase();
  if (!ACTIVE_PROVIDERS.has(normalized) || normalized === "managed") {
    throw inputError("Unsupported AI provider.");
  }
  await store.deleteCredential(owner, normalized);
  if ((await store.getPreference(owner))?.active_provider === normalized) {
    await store.setPreference(owner, "managed");
  }
  return aiConnectionSummary(owner, { store });
}

export async function activeAiCredential(owner, { store = aiCredentialStore() } = {}) {
  const preference = await store.getPreference(owner);
  const provider = preference?.active_provider || "managed";
  const routing = publicRoutingPreference(preference);
  if (provider === "managed") return { provider, authMode: "managed", secret: null, routing };
  const credential = await store.getCredential(owner, provider);
  if (!credential || credential.status !== "connected") {
    const error = new Error(`The selected ${providerLabel(provider)} connection is unavailable.`);
    error.code = "provider_not_connected";
    throw error;
  }
  return {
    provider,
    authMode: credential.auth_mode,
    secret: decryptSecret(credential.secret_encrypted),
    metadata: credential.metadata || {},
    routing,
  };
}

export async function updateAiRoutingPolicy(owner, input = {}, { store = aiCredentialStore() } = {}) {
  const routingMode = String(input.routingMode || "").toLowerCase();
  if (!ROUTING_MODES.has(routingMode)) throw inputError("Choose a valid routing mode.");
  const preferredModel = safeString(input.preferredModel, 200);
  if (routingMode === "manual" && !preferredModel) {
    throw inputError("Choose a preferred model for manual routing.");
  }
  await store.setPreference(owner, {
    routing_mode: routingMode,
    preferred_model: routingMode === "manual" ? preferredModel : null,
    allow_fallback: input.allowFallback !== false,
  });
  return aiConnectionSummary(owner, { store });
}

export class MemoryAiCredentialStore {
  constructor() {
    this.credentials = new Map();
    this.preferences = new Map();
  }

  key(owner, provider) {
    return `${owner}:${provider}`;
  }

  async listCredentials(owner) {
    return [...this.credentials.values()].filter((row) => row.owner === owner);
  }

  async getCredential(owner, provider) {
    return this.credentials.get(this.key(owner, provider)) || null;
  }

  async setCredential(owner, input) {
    const key = this.key(owner, input.provider);
    const existing = this.credentials.get(key);
    const row = {
      owner,
      created_at: existing?.created_at || now(),
      last_used_at: existing?.last_used_at || null,
      ...existing,
      ...input,
      updated_at: now(),
    };
    this.credentials.set(key, row);
    return row;
  }

  async deleteCredential(owner, provider) {
    this.credentials.delete(this.key(owner, provider));
  }

  async getPreference(owner) {
    return this.preferences.get(owner) || null;
  }

  async setPreference(owner, input) {
    const existing = this.preferences.get(owner);
    const patch = typeof input === "string" ? { active_provider: input } : input;
    const row = {
      owner,
      active_provider: existing?.active_provider || "managed",
      routing_mode: existing?.routing_mode || "balanced",
      preferred_model: existing?.preferred_model || null,
      allow_fallback: existing?.allow_fallback ?? true,
      created_at: existing?.created_at || now(),
      ...patch,
      updated_at: now(),
    };
    this.preferences.set(owner, row);
    return row;
  }
}

export class SupabaseAiCredentialStore {
  constructor(client = serviceClient()) {
    this.client = client;
  }

  async listCredentials(owner) {
    return unwrap(await this.client.from("ca_ai_credentials").select("*")
      .eq("owner", owner).order("updated_at", { ascending: false }));
  }

  async getCredential(owner, provider) {
    return unwrapMaybe(await this.client.from("ca_ai_credentials").select("*")
      .eq("owner", owner).eq("provider", provider).maybeSingle());
  }

  async setCredential(owner, input) {
    const { data, error } = await this.client.from("ca_ai_credentials")
      .upsert({ owner, ...input }, { onConflict: "owner,provider" }).select("*").single();
    return unwrapOne(data, error);
  }

  async deleteCredential(owner, provider) {
    const { error } = await this.client.from("ca_ai_credentials")
      .delete().eq("owner", owner).eq("provider", provider);
    if (error) throw new Error(error.message);
  }

  async getPreference(owner) {
    return unwrapMaybe(await this.client.from("ca_ai_preferences").select("*")
      .eq("owner", owner).maybeSingle());
  }

  async setPreference(owner, input) {
    const patch = typeof input === "string" ? { active_provider: input } : input;
    const { data, error } = await this.client.from("ca_ai_preferences")
      .upsert({ owner, ...patch, updated_at: now() }, { onConflict: "owner" })
      .select("*").single();
    return unwrapOne(data, error);
  }
}

async function verifyApiKey(provider, key, fetchImpl) {
  const request = provider === "openai"
    ? {
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${key}` },
    }
    : provider === "anthropic" ? {
      url: "https://api.anthropic.com/v1/models?limit=1",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    } : {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      headers: { "x-goog-api-key": key },
    };
  const response = await fetchImpl(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`${providerLabel(provider)} rejected this API key.`);
    error.code = "provider_key_rejected";
    error.status = 400;
    throw error;
  }
}

function validateApiKey(provider, key) {
  if (key.length < 20 || key.length > 500 || /\s/.test(key)) {
    throw inputError("Enter a valid API key.");
  }
  if (provider === "openai" && !key.startsWith("sk-")) {
    throw inputError("OpenAI API keys should start with sk-.");
  }
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    throw inputError("Anthropic API keys should start with sk-ant-.");
  }
  if (provider === "gemini" && !key.startsWith("AIza")) {
    throw inputError("Gemini API keys should start with AIza.");
  }
}

function normalizedAuthJson(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Codex returned invalid authentication state."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || text.length < 20) {
    throw new Error("Codex returned incomplete authentication state.");
  }
  return JSON.stringify(parsed);
}

function publicCredential(row) {
  return {
    provider: row.provider,
    authMode: row.auth_mode,
    hint: row.secret_hint,
    status: row.status,
    metadata: {
      email: row.metadata?.email || null,
      planType: row.metadata?.planType || null,
    },
    lastVerifiedAt: row.last_verified_at || null,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerLabel(provider) {
  return ({ codex: "Codex", openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini" })[provider] || "provider";
}

function publicRoutingPreference(preference) {
  return {
    routingMode: preference?.routing_mode || "balanced",
    preferredModel: preference?.preferred_model || null,
    allowFallback: preference?.allow_fallback ?? true,
  };
}

function safeString(value, max) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function inputError(message, status = 400, code = "invalid_ai_connection") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function setupError() {
  const error = new Error("Encrypted credential storage is not configured on the server.");
  error.status = 503;
  error.code = "credential_storage_unavailable";
  return error;
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data || [];
}

function unwrapOne(data, error) {
  if (error) throw new Error(error.message);
  return data;
}

function unwrapMaybe({ data, error }) {
  if (error) throw new Error(error.message);
  return data || null;
}

let singleton;
export function aiCredentialStore() {
  if (singleton) return singleton;
  const mode = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase();
  singleton = mode === "supabase" ? new SupabaseAiCredentialStore() : new MemoryAiCredentialStore();
  return singleton;
}

export function resetAiCredentialStoreForTests() {
  singleton = null;
}
