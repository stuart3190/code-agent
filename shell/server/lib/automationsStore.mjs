import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";

const now = () => new Date().toISOString();

export class MemoryAutomationsStore {
  constructor() {
    this.automations = new Map();
  }

  async create(owner, input) {
    const row = {
      id: crypto.randomUUID(), owner, enabled: true, config: {}, interval_hours: null,
      next_run_at: null, last_run_id: null, last_triggered_at: null, last_error: null,
      created_at: now(), updated_at: now(), ...input,
    };
    this.automations.set(row.id, row);
    return row;
  }

  async list(owner) {
    return [...this.automations.values()].filter((x) => x.owner === owner)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(owner, id) {
    const row = this.automations.get(id);
    return row?.owner === owner ? row : null;
  }

  async getById(id) {
    return this.automations.get(id) || null;
  }

  async update(owner, id, patch) {
    const row = await this.get(owner, id);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: now() });
    return row;
  }

  async remove(owner, id) {
    const row = await this.get(owner, id);
    if (!row) return false;
    this.automations.delete(id);
    return true;
  }

  async findForRepository(repositoryId, kind) {
    return [...this.automations.values()]
      .filter((x) => x.repository_id === repositoryId && x.kind === kind && x.enabled);
  }

  // Optimistic claim: advances next_run_at so concurrent sweepers cannot double-fire.
  async claimDueScheduled(nowIso, limit = 10) {
    const due = [...this.automations.values()]
      .filter((x) => x.enabled && x.kind === "scheduled_task" && x.next_run_at && x.next_run_at <= nowIso)
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))
      .slice(0, limit);
    for (const row of due) {
      row.next_run_at = nextRunAt(row.interval_hours, nowIso);
      row.updated_at = now();
    }
    return due;
  }

  async recordTrigger(id, patch) {
    const row = this.automations.get(id);
    if (row) Object.assign(row, patch, { updated_at: now() });
    return row || null;
  }
}

export class SupabaseAutomationsStore {
  constructor(client = serviceClient()) {
    this.client = client;
  }

  async create(owner, input) {
    const { data, error } = await this.client.from("ca_automations")
      .insert({ owner, ...input }).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async list(owner) {
    const { data, error } = await this.client.from("ca_automations").select("*")
      .eq("owner", owner).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  async get(owner, id) {
    const { data, error } = await this.client.from("ca_automations").select("*")
      .eq("owner", owner).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async getById(id) {
    const { data, error } = await this.client.from("ca_automations").select("*")
      .eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async update(owner, id, patch) {
    const { data, error } = await this.client.from("ca_automations")
      .update({ ...patch, updated_at: now() })
      .eq("owner", owner).eq("id", id).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async remove(owner, id) {
    const { data, error } = await this.client.from("ca_automations")
      .delete().eq("owner", owner).eq("id", id).select("id");
    if (error) throw new Error(error.message);
    return (data || []).length > 0;
  }

  async findForRepository(repositoryId, kind) {
    const { data, error } = await this.client.from("ca_automations").select("*")
      .eq("repository_id", repositoryId).eq("kind", kind).eq("enabled", true);
    if (error) throw new Error(error.message);
    return data || [];
  }

  async claimDueScheduled(nowIso, limit = 10) {
    const { data, error } = await this.client.from("ca_automations").select("*")
      .eq("enabled", true).eq("kind", "scheduled_task")
      .not("next_run_at", "is", null).lte("next_run_at", nowIso)
      .order("next_run_at").limit(limit);
    if (error) throw new Error(error.message);
    const claimed = [];
    for (const row of data || []) {
      const { data: updated, error: claimError } = await this.client.from("ca_automations")
        .update({ next_run_at: nextRunAt(row.interval_hours, nowIso), updated_at: now() })
        .eq("id", row.id).eq("next_run_at", row.next_run_at)
        .select("*").maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  async recordTrigger(id, patch) {
    const { data, error } = await this.client.from("ca_automations")
      .update({ ...patch, updated_at: now() }).eq("id", id).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }
}

export function nextRunAt(intervalHours, fromIso = now()) {
  const hours = Math.min(Math.max(Math.floor(Number(intervalHours) || 24), 1), 168);
  return new Date(new Date(fromIso).getTime() + hours * 60 * 60_000).toISOString();
}

let singleton;
export function automationsStore() {
  if (singleton) return singleton;
  singleton = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase() === "supabase"
    ? new SupabaseAutomationsStore()
    : new MemoryAutomationsStore();
  return singleton;
}

export function resetAutomationsStoreForTests() {
  singleton = null;
}
