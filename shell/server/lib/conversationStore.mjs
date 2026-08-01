// Durable store for the conversation platform: conversations, turns, the monotonic event
// stream (same semantics as ca_run_events so resumable SSE ports directly), and the memory
// system (owner profile, products, episodic memories — encrypted at rest).

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";
import { encryptSecret, decryptSecret } from "./secretCrypto.mjs";

const now = () => new Date().toISOString();

const EVENT_WRITE_ATTEMPTS = 5;

// Postgres 23505 / PostgREST duplicate-key on the (conversation_id, sequence) unique index.
export function isSequenceCollision(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code === "23505" || /duplicate key value violates unique constraint/i.test(message);
}
const newId = () => crypto.randomUUID();

export class MemoryConversationStore {
  async deleteConversation(owner, conversationId) {
    const conversation = await this.getConversationIncludingDeleted(owner, conversationId);
    if (!conversation) throw new Error("not found");
    this.events.delete(conversationId);
    this.turns?.delete?.(conversationId);
    this.conversations.delete(conversationId);
    return { deleted: true };
  }

  constructor() {
    this.conversations = new Map();
    this.turns = new Map();      // conversationId -> []
    this.events = new Map();     // conversationId -> []
    this.products = new Map();
    this.profiles = new Map();   // owner -> plaintext profile object
    this.memories = [];
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
  }

  async createConversation(owner, input = {}) {
    const row = {
      id: newId(), owner, title: input.title || null, product_id: input.product_id || null,
      state: "idle", last_activity_at: now(), created_at: now(), updated_at: now(),
    };
    this.conversations.set(row.id, row);
    return row;
  }

  async getConversation(owner, id) {
    const row = this.conversations.get(id);
    return row?.owner === owner && !row.deleted_at ? row : null; // deleted = unreachable
  }

  async getConversationIncludingDeleted(owner, id) {
    const row = this.conversations.get(id);
    return row?.owner === owner ? row : null;
  }

  async listConversations(owner, limit = 20) {
    return [...this.conversations.values()].filter((x) => x.owner === owner && !x.deleted_at)
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at)).slice(0, limit);
  }

  async listDeletedConversations(owner) {
    return [...this.conversations.values()].filter((x) => x.owner === owner && x.deleted_at)
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  }

  async softDeleteConversation(owner, id) {
    const row = await this.getConversation(owner, id);
    if (!row) return null;
    row.deleted_at = now();
    return row;
  }

  async restoreConversation(owner, id) {
    const row = await this.getConversationIncludingDeleted(owner, id);
    if (!row || !row.deleted_at) return null;
    row.deleted_at = null;
    return row;
  }

  async listExpiredDeleted(cutoffIso) {
    return [...this.conversations.values()].filter((x) => x.deleted_at && x.deleted_at < cutoffIso);
  }

  async updateConversation(conversation, patch) {
    const row = this.conversations.get(conversation.id);
    if (!row) throw new Error("conversation disappeared");
    Object.assign(row, patch, { updated_at: now() });
    return row;
  }

  async claimConversationThinking(conversation) {
    const row = this.conversations.get(conversation.id);
    if (!row || row.state === "thinking") return null;
    Object.assign(row, { state: "thinking", last_activity_at: now(), updated_at: now() });
    return row;
  }

  async recoverStaleThinking(staleBefore) {
    const rows = [...this.conversations.values()]
      .filter((x) => x.state === "thinking" && x.updated_at < staleBefore);
    for (const row of rows) Object.assign(row, { state: "idle", updated_at: now() });
    return rows;
  }

  async appendTurn(conversation, input) {
    const list = this.turns.get(conversation.id) || [];
    const row = {
      id: newId(), owner: conversation.owner, conversation_id: conversation.id,
      sequence: list.length + 1, payload: {}, specialist: null, content: null,
      created_at: now(), ...input,
    };
    list.push(row);
    this.turns.set(conversation.id, list);
    return row;
  }

  async listTurns(owner, conversationId, { limit = 60 } = {}) {
    const conversation = await this.getConversation(owner, conversationId);
    if (!conversation) return null;
    return (this.turns.get(conversationId) || []).slice(-limit);
  }

  async appendEvent(conversation, type, payload = {}) {
    const list = this.events.get(conversation.id) || [];
    const event = {
      id: list.length + 1, sequence: list.length + 1,
      conversation_id: conversation.id, owner: conversation.owner,
      type, payload, created_at: now(),
    };
    list.push(event);
    this.events.set(conversation.id, list);
    this.bus.emit(`conversation:${conversation.id}`, event);
    return event;
  }

  async listEvents(owner, conversationId, after = 0) {
    const conversation = await this.getConversation(owner, conversationId);
    if (!conversation) return null;
    return (this.events.get(conversationId) || []).filter((x) => x.sequence > after);
  }

  // Internal (cascade/purge): reaches events of soft-deleted conversations too.
  async listEventsIncludingDeleted(owner, conversationId) {
    const conversation = await this.getConversationIncludingDeleted(owner, conversationId);
    if (!conversation) return null;
    return this.events.get(conversationId) || [];
  }

  subscribe(conversationId, listener) {
    const key = `conversation:${conversationId}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }

  async upsertProduct(owner, name, patch = {}) {
    const existing = [...this.products.values()]
      .find((x) => x.owner === owner && x.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      Object.assign(existing, patch, { updated_at: now() });
      return existing;
    }
    const row = {
      id: newId(), owner, name, summary: null, branding: {}, state: {},
      repository_id: null, created_at: now(), updated_at: now(), ...patch,
    };
    this.products.set(row.id, row);
    return row;
  }

  async listProducts(owner) {
    return [...this.products.values()].filter((x) => x.owner === owner)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getOwnerProfile(owner) {
    return this.profiles.get(owner) || null;
  }

  async setOwnerProfile(owner, profile) {
    this.profiles.set(owner, profile);
    return profile;
  }

  async addMemory(owner, { kind = "fact", content, product_id = null }) {
    const row = { id: newId(), owner, product_id, kind, content, created_at: now() };
    this.memories.push(row);
    return row;
  }

  async listMemories(owner, { productId = null, limit = 12 } = {}) {
    return this.memories
      .filter((x) => x.owner === owner && (!productId || x.product_id === productId || !x.product_id))
      .slice(-limit);
  }
}

export class SupabaseConversationStore {
  async deleteConversation(owner, conversationId) {
    const kill = async (table, column) => {
      const { error } = await this.client.from(table).delete().eq(column, conversationId);
      if (error) throw new Error(`${table}: ${error.message}`);
    };
    await kill("ca_conversation_events", "conversation_id");
    await kill("ca_conversation_turns", "conversation_id");
    const { error } = await this.client.from("ca_conversations").delete().eq("id", conversationId).eq("owner", owner);
    if (error) throw new Error(`ca_conversations: ${error.message}`);
    return { deleted: true };
  }

  constructor(client = serviceClient()) {
    this.client = client;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
  }

  async createConversation(owner, input = {}) {
    const { data, error } = await this.client.from("ca_conversations")
      .insert({ owner, title: input.title || null, product_id: input.product_id || null })
      .select("*").single();
    return one(data, error);
  }

  async getConversation(owner, id) {
    return maybe(await this.client.from("ca_conversations").select("*")
      .eq("owner", owner).eq("id", id).is("deleted_at", null).maybeSingle());
  }

  async getConversationIncludingDeleted(owner, id) {
    return maybe(await this.client.from("ca_conversations").select("*")
      .eq("owner", owner).eq("id", id).maybeSingle());
  }

  async listConversations(owner, limit = 20) {
    return all(await this.client.from("ca_conversations").select("*")
      .eq("owner", owner).neq("state", "archived").is("deleted_at", null)
      .order("last_activity_at", { ascending: false }).limit(limit));
  }

  async listDeletedConversations(owner) {
    return all(await this.client.from("ca_conversations").select("*")
      .eq("owner", owner).not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }));
  }

  async softDeleteConversation(owner, id) {
    const { data } = await this.client.from("ca_conversations")
      .update({ deleted_at: now(), updated_at: now() })
      .eq("id", id).eq("owner", owner).is("deleted_at", null).select("*").maybeSingle();
    return data || null;
  }

  async restoreConversation(owner, id) {
    const { data } = await this.client.from("ca_conversations")
      .update({ deleted_at: null, updated_at: now() })
      .eq("id", id).eq("owner", owner).not("deleted_at", "is", null).select("*").maybeSingle();
    return data || null;
  }

  async listExpiredDeleted(cutoffIso) {
    return all(await this.client.from("ca_conversations").select("*")
      .not("deleted_at", "is", null).lt("deleted_at", cutoffIso));
  }

  async updateConversation(conversation, patch) {
    const { data, error } = await this.client.from("ca_conversations")
      .update({ ...patch, updated_at: now() })
      .eq("id", conversation.id).eq("owner", conversation.owner).select("*").single();
    return one(data, error);
  }

  // Optimistic claim so two shell instances can't both run the Lead Agent loop.
  async claimConversationThinking(conversation) {
    const { data, error } = await this.client.from("ca_conversations")
      .update({ state: "thinking", last_activity_at: now(), updated_at: now() })
      .eq("id", conversation.id).neq("state", "thinking").select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async recoverStaleThinking(staleBefore) {
    const { data, error } = await this.client.from("ca_conversations")
      .update({ state: "idle", updated_at: now() })
      .eq("state", "thinking").lt("updated_at", staleBefore).select("*");
    return one(data || [], error);
  }

  async appendTurn(conversation, input) {
    const sequence = await this.nextSequence("ca_conversation_turns", conversation.id);
    const { data, error } = await this.client.from("ca_conversation_turns").insert({
      owner: conversation.owner, conversation_id: conversation.id, sequence, ...input,
    }).select("*").single();
    return one(data, error);
  }

  async listTurns(owner, conversationId, { limit = 60 } = {}) {
    const conversation = await this.getConversation(owner, conversationId);
    if (!conversation) return null;
    const rows = all(await this.client.from("ca_conversation_turns").select("*")
      .eq("conversation_id", conversationId)
      .order("sequence", { ascending: false }).limit(limit));
    return rows.reverse();
  }

  // Concurrency-safe append: read-max-then-insert races when two writers (relay + lead
  // loop) append at once, which surfaced as a raw unique-constraint error. The write now
  // retries on that specific collision with a freshly read sequence — the event lands, the
  // build continues, and nothing technical ever reaches the conversation.
  async appendEvent(conversation, type, payload = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < EVENT_WRITE_ATTEMPTS; attempt += 1) {
      const sequence = await this.nextSequence("ca_conversation_events", conversation.id);
      const { data, error } = await this.client.from("ca_conversation_events").insert({
        owner: conversation.owner, conversation_id: conversation.id, sequence, type, payload,
      }).select("*").single();
      if (!error) {
        const event = one(data, error);
        this.bus.emit(`conversation:${conversation.id}`, event);
        return event;
      }
      lastError = error;
      if (!isSequenceCollision(error)) break;
      // Jittered backoff so simultaneous writers don't re-collide on the same retry tick.
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(attempt * 40)));
    }
    const failure = new Error(lastError?.message || "conversation event write failed");
    failure.code = lastError?.code || "event_write_failed";
    failure.service = "conversation_events";
    throw failure;
  }

  async listEvents(owner, conversationId, after = 0) {
    const conversation = await this.getConversation(owner, conversationId);
    if (!conversation) return null;
    return all(await this.client.from("ca_conversation_events").select("*")
      .eq("conversation_id", conversationId).gt("sequence", after).order("sequence"));
  }

  // Internal (cascade/purge): reaches events of soft-deleted conversations too.
  async listEventsIncludingDeleted(owner, conversationId) {
    const conversation = await this.getConversationIncludingDeleted(owner, conversationId);
    if (!conversation) return null;
    return all(await this.client.from("ca_conversation_events").select("*")
      .eq("conversation_id", conversationId).order("sequence"));
  }

  subscribe(conversationId, listener) {
    const key = `conversation:${conversationId}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }

  async upsertProduct(owner, name, patch = {}) {
    const { data, error } = await this.client.from("ca_products")
      .upsert({ owner, name, ...patch, updated_at: now() }, { onConflict: "owner,name" })
      .select("*").single();
    return one(data, error);
  }

  async listProducts(owner) {
    return all(await this.client.from("ca_products").select("*")
      .eq("owner", owner).order("updated_at", { ascending: false }).limit(50));
  }

  async getOwnerProfile(owner) {
    const row = maybe(await this.client.from("ca_owner_profile").select("*")
      .eq("owner", owner).maybeSingle());
    if (!row?.profile_encrypted) return null;
    try { return JSON.parse(decryptSecret(row.profile_encrypted)); } catch { return null; }
  }

  async setOwnerProfile(owner, profile) {
    const { error } = await this.client.from("ca_owner_profile").upsert({
      owner, profile_encrypted: encryptSecret(JSON.stringify(profile)), updated_at: now(),
    }, { onConflict: "owner" });
    if (error) throw new Error(error.message);
    return profile;
  }

  async addMemory(owner, { kind = "fact", content, product_id = null }) {
    const { data, error } = await this.client.from("ca_memories").insert({
      owner, kind, product_id, content_encrypted: encryptSecret(String(content)),
    }).select("id,owner,product_id,kind,created_at").single();
    return one(data, error);
  }

  async listMemories(owner, { productId = null, limit = 12 } = {}) {
    let query = this.client.from("ca_memories").select("*")
      .eq("owner", owner).order("created_at", { ascending: false }).limit(limit);
    if (productId) query = query.or(`product_id.eq.${productId},product_id.is.null`);
    const rows = all(await query);
    return rows.reverse().map((row) => ({
      id: row.id, owner: row.owner, product_id: row.product_id, kind: row.kind,
      content: safeDecrypt(row.content_encrypted), created_at: row.created_at,
    })).filter((row) => row.content !== null);
  }

  async nextSequence(table, conversationId) {
    const { data, error } = await this.client.from(table).select("sequence")
      .eq("conversation_id", conversationId).order("sequence", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return Number(data?.[0]?.sequence || 0) + 1;
  }
}

function safeDecrypt(value) {
  try { return decryptSecret(value); } catch { return null; }
}

function all({ data, error }) {
  if (error) throw new Error(error.message);
  return data || [];
}

function one(data, error) {
  if (error) throw new Error(error.message);
  return data;
}

function maybe({ data, error }) {
  if (error) throw new Error(error.message);
  return data || null;
}

let singleton;
export function conversationStore() {
  if (singleton) return singleton;
  singleton = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase() === "supabase"
    ? new SupabaseConversationStore()
    : new MemoryConversationStore();
  return singleton;
}

export function resetConversationStoreForTests() {
  singleton = null;
}
