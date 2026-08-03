// Personal access tokens for editor and CLI clients.
//
// Format: thrallo_pat_<40 hex chars>. Only the SHA-256 hash is persisted; the plaintext is
// returned exactly once at creation. Tokens authenticate the same owner-scoped v1 API as a
// Supabase session but never carry a verified email, so they can never pass the ADMIN_EMAILS
// operator gate.

import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";

export const TOKEN_PREFIX = "thrallo_pat_";
const MAX_TOKENS_PER_OWNER = 10;

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

export class MemoryApiTokenStore {
  constructor() {
    this.tokens = new Map();
  }

  async insert(row) {
    this.tokens.set(row.id, row);
    return row;
  }

  async listByOwner(owner) {
    return [...this.tokens.values()].filter((x) => x.owner === owner)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async findByHash(tokenHash) {
    return [...this.tokens.values()].find((x) => x.token_hash === tokenHash) || null;
  }

  async revoke(owner, id) {
    const row = this.tokens.get(id);
    if (!row || row.owner !== owner || row.revoked_at) return null;
    row.revoked_at = now();
    return row;
  }

  async rename(owner, id, name) {
    const row = this.tokens.get(id);
    if (!row || row.owner !== owner || row.revoked_at) return null;
    row.name = name;
    return row;
  }

  async touch(id) {
    const row = this.tokens.get(id);
    if (row) row.last_used_at = now();
  }
}

export class SupabaseApiTokenStore {
  constructor(client = serviceClient()) {
    this.client = client;
  }

  async insert(row) {
    const { data, error } = await this.client.from("ca_api_tokens").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async listByOwner(owner) {
    const { data, error } = await this.client.from("ca_api_tokens").select("*")
      .eq("owner", owner).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  async findByHash(tokenHash) {
    const { data, error } = await this.client.from("ca_api_tokens").select("*")
      .eq("token_hash", tokenHash).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async revoke(owner, id) {
    const { data, error } = await this.client.from("ca_api_tokens")
      .update({ revoked_at: now() }).eq("owner", owner).eq("id", id).is("revoked_at", null)
      .select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  // Owner and not-revoked are both in the statement: renaming a revoked token would suggest it
  // still does something, and an id belonging to someone else must simply match nothing.
  async rename(owner, id, name) {
    const { data, error } = await this.client.from("ca_api_tokens")
      .update({ name }).eq("owner", owner).eq("id", id).is("revoked_at", null)
      .select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async touch(id) {
    await this.client.from("ca_api_tokens").update({ last_used_at: now() }).eq("id", id);
  }
}

let singleton;
export function apiTokenStore() {
  if (singleton) return singleton;
  singleton = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase() === "supabase"
    ? new SupabaseApiTokenStore()
    : new MemoryApiTokenStore();
  return singleton;
}

export function resetApiTokenStoreForTests() {
  singleton = null;
}

export async function createApiToken(owner, name, { store = apiTokenStore() } = {}) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length > 120) throw inputError("Token name must be 1-120 characters");
  const existing = (await store.listByOwner(owner)).filter((row) => !row.revoked_at);
  if (existing.length >= MAX_TOKENS_PER_OWNER) {
    throw inputError(`You already have ${existing.length} active tokens; revoke one first.`, 409, "token_limit");
  }
  const secret = crypto.randomBytes(20).toString("hex");
  const token = `${TOKEN_PREFIX}${secret}`;
  const row = await store.insert({
    id: crypto.randomUUID(),
    owner,
    name: trimmed,
    token_hash: hash(token),
    token_prefix: token.slice(0, 20),
    scopes: ["runs"],
    last_used_at: null,
    revoked_at: null,
    created_at: now(),
  });
  return { token, record: publicToken(row) };
}

export async function listApiTokens(owner, { store = apiTokenStore() } = {}) {
  return (await store.listByOwner(owner)).map(publicToken);
}

export async function renameApiToken(owner, id, name, { store = apiTokenStore() } = {}) {
  const trimmed = String(name || "").trim();
  // The same rule creation uses, from the same place — a name the database would reject must be
  // rejected here too, or a rename fails with a constraint error instead of a sentence.
  if (!trimmed || trimmed.length > 120) throw inputError("Token name must be 1-120 characters");
  const row = await store.rename(owner, id, trimmed);
  if (!row) throw inputError("Token not found", 404, "token_not_found");
  return publicToken(row);
}

export async function revokeApiToken(owner, id, { store = apiTokenStore() } = {}) {
  const row = await store.revoke(owner, id);
  if (!row) throw inputError("Token not found", 404, "token_not_found");
  return publicToken(row);
}

// Resolves a bearer value that looks like a PAT to its owner, or null. Constant-shape
// lookup by hash; the last_used timestamp update is fire-and-forget.
export async function ownerFromApiToken(bearerValue, { store = apiTokenStore() } = {}) {
  if (!bearerValue?.startsWith(TOKEN_PREFIX)) return null;
  const row = await store.findByHash(hash(bearerValue));
  if (!row || row.revoked_at) return null;
  Promise.resolve(store.touch(row.id)).catch(() => {});
  return { id: row.owner, email: null, viaToken: row.id };
}

export function isApiTokenBearer(bearerValue) {
  return !!bearerValue?.startsWith(TOKEN_PREFIX);
}

function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    // What the token can do. Every token today is created with ["runs"] and there is no way to
    // ask for more — surfaced so the screen states the real scope rather than implying a token is
    // unlimited by saying nothing about it.
    scopes: Array.isArray(row.scopes) ? row.scopes : ["runs"],
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function inputError(message, status = 400, code = "invalid_token_request") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
