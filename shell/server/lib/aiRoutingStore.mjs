import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

export class MemoryAiRoutingStore {
  constructor() {
    this.attempts = [];
    this.evaluations = new Map();
    this.results = [];
  }

  async recordAttempt(owner, input) {
    const row = { id: newId(), owner, created_at: now(), ...input };
    this.attempts.push(row);
    return row;
  }

  async listRecentAttempts(owner, limit = 200) {
    return this.attempts.filter((row) => row.owner === owner).slice(-limit).reverse();
  }

  async listAttemptsSince(sinceIso, limit = 5_000) {
    return this.attempts.filter((row) => row.created_at >= sinceIso).slice(-limit).reverse();
  }

  async createEvaluation(owner, input) {
    const row = { id: newId(), owner, status: "running", created_at: now(), completed_at: null, ...input };
    this.evaluations.set(row.id, row);
    return row;
  }

  async updateEvaluation(owner, id, patch) {
    const row = this.evaluations.get(id);
    if (!row || row.owner !== owner) return null;
    Object.assign(row, patch);
    return row;
  }

  async addEvaluationResult(owner, input) {
    const row = { id: newId(), owner, created_at: now(), ...input };
    this.results.push(row);
    return row;
  }

  async listEvaluations(owner, limit = 10) {
    return [...this.evaluations.values()]
      .filter((row) => row.owner === owner)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async listEvaluationResults(owner, evaluationIds) {
    const ids = new Set(evaluationIds);
    return this.results.filter((row) => row.owner === owner && ids.has(row.evaluation_id));
  }
}

export class SupabaseAiRoutingStore {
  constructor(client = serviceClient()) {
    this.client = client;
  }

  async recordAttempt(owner, input) {
    return unwrapOne(await this.client.from("ca_model_attempts").insert({ owner, ...input }).select("*").single());
  }

  async listRecentAttempts(owner, limit = 200) {
    return unwrap(await this.client.from("ca_model_attempts").select("*")
      .eq("owner", owner).order("created_at", { ascending: false }).limit(limit));
  }

  async listAttemptsSince(sinceIso, limit = 5_000) {
    return unwrap(await this.client.from("ca_model_attempts")
      .select("provider,model,status,latency_ms,retryable,created_at")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit));
  }

  async createEvaluation(owner, input) {
    return unwrapOne(await this.client.from("ca_model_evaluations")
      .insert({ owner, ...input }).select("*").single());
  }

  async updateEvaluation(owner, id, patch) {
    return unwrapMaybe(await this.client.from("ca_model_evaluations")
      .update(patch).eq("owner", owner).eq("id", id).select("*").maybeSingle());
  }

  async addEvaluationResult(owner, input) {
    return unwrapOne(await this.client.from("ca_model_evaluation_results")
      .insert({ owner, ...input }).select("*").single());
  }

  async listEvaluations(owner, limit = 10) {
    return unwrap(await this.client.from("ca_model_evaluations").select("*")
      .eq("owner", owner).order("created_at", { ascending: false }).limit(limit));
  }

  async listEvaluationResults(owner, evaluationIds) {
    if (!evaluationIds.length) return [];
    return unwrap(await this.client.from("ca_model_evaluation_results").select("*")
      .eq("owner", owner).in("evaluation_id", evaluationIds).order("created_at"));
  }
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data || [];
}

function unwrapOne({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

function unwrapMaybe({ data, error }) {
  if (error) throw new Error(error.message);
  return data || null;
}

let singleton;
export function aiRoutingStore() {
  if (singleton) return singleton;
  singleton = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase() === "supabase"
    ? new SupabaseAiRoutingStore()
    : new MemoryAiRoutingStore();
  return singleton;
}

export function resetAiRoutingStoreForTests() {
  singleton = null;
}
