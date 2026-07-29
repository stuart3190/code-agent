import { EventEmitter } from "node:events";
import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";
import { newId, TERMINAL_RUN_STATES } from "./codeAgentContracts.mjs";

const now = () => new Date().toISOString();

export class MemoryCodeAgentStore {
  constructor() {
    this.repositories = new Map();
    this.agents = new Map();
    this.runs = new Map();
    this.events = new Map();
    this.installations = new Map();
    this.artifacts = new Map();
    this.usageRecords = new Map();
    this.checkpoints = new Map();
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
  }

  async listRepositories(owner) {
    return [...this.repositories.values()].filter((x) => x.owner === owner).sort(byNewest);
  }

  async createRepository(owner, input) {
    const duplicate = [...this.repositories.values()]
      .find((x) => x.owner === owner && x.full_name.toLowerCase() === input.full_name.toLowerCase());
    if (duplicate) return duplicate;
    const row = { id: newId(), owner, status: "ready", last_error: null, permissions: {},
      external_id: null, installation_id: null, created_at: now(), updated_at: now(), ...input };
    this.repositories.set(row.id, row);
    return row;
  }

  async getRepository(owner, id) {
    const row = this.repositories.get(id);
    return row?.owner === owner ? row : null;
  }

  async listGithubInstallations(owner) {
    return [...this.installations.values()].filter((x) => x.owner === owner).sort(byNewest);
  }

  async upsertGithubInstallation(owner, input) {
    const existing = [...this.installations.values()]
      .find((x) => x.installation_id === input.installation_id);
    if (existing && existing.owner !== owner) throw installationClaimed();
    const row = existing || { id: newId(), owner, created_at: now() };
    Object.assign(row, input, { owner, updated_at: now() });
    this.installations.set(row.id, row);
    return row;
  }

  async getGithubInstallation(owner, installationId) {
    return [...this.installations.values()]
      .find((x) => x.owner === owner && x.installation_id === Number(installationId)) || null;
  }

  async listAgents(owner) {
    return [...this.agents.values()].filter((x) => x.owner === owner && !x.archived_at).sort(byNewest);
  }

  async createAgent(owner, input) {
    const row = { id: newId(), owner, archived_at: null, created_at: now(), updated_at: now(), ...input };
    this.agents.set(row.id, row);
    return row;
  }

  async getAgent(owner, id) {
    const row = this.agents.get(id);
    return row?.owner === owner ? row : null;
  }

  async createRun(owner, agent, repository, input) {
    const row = {
      id: newId(), owner, agent_id: agent.id, repository_id: repository.id, ...input,
      base_branch: repository.default_branch, work_branch: null, state: "queued",
      sandbox_id: null, snapshot_id: null, result: null, usage: {}, error_code: null, error: null,
      cancel_requested_at: null, started_at: null, finished_at: null, created_at: now(), updated_at: now(),
    };
    this.runs.set(row.id, row);
    await this.appendEvent(row, "run.queued", { message: "Run queued" });
    return row;
  }

  async getRun(owner, id) {
    const row = this.runs.get(id);
    return row?.owner === owner ? row : null;
  }

  async getLatestRun(owner, agentId) {
    return [...this.runs.values()].reverse()
      .find((x) => x.owner === owner && x.agent_id === agentId) || null;
  }

  async claimRuns(limit = 1) {
    const rows = [...this.runs.values()]
      .filter((x) => x.state === "queued")
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit);
    for (const row of rows) {
      Object.assign(row, { state: "provisioning", started_at: row.started_at || now(), updated_at: now() });
    }
    return rows;
  }

  async interruptStaleRuns(staleBefore) {
    const rows = [...this.runs.values()].filter((run) =>
      ["provisioning", "indexing", "running"].includes(run.state) && run.updated_at < staleBefore);
    for (const run of rows) {
      Object.assign(run, {
        state: "interrupted",
        error_code: "worker_interrupted",
        error: "The worker stopped before this run completed. Retry the run to continue.",
        finished_at: now(),
        updated_at: now(),
      });
      await this.appendEvent(run, "run.interrupted", { message: run.error });
    }
    return rows;
  }

  async updateRun(run, patch) {
    const current = this.runs.get(run.id);
    if (!current) throw new Error("run disappeared");
    Object.assign(current, patch, { updated_at: now() });
    return current;
  }

  async appendEvent(run, type, payload = {}) {
    const list = this.events.get(run.id) || [];
    const event = { id: list.length + 1, sequence: list.length + 1, run_id: run.id,
      type, payload, created_at: now() };
    list.push(event);
    this.events.set(run.id, list);
    this.bus.emit(`run:${run.id}`, event);
    return event;
  }

  async listEvents(owner, runId, after = 0) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    return (this.events.get(runId) || []).filter((x) => x.sequence > after);
  }

  subscribe(runId, listener) {
    const key = `run:${runId}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }

  async requestCancel(owner, id) {
    const run = await this.getRun(owner, id);
    if (!run) return null;
    if (TERMINAL_RUN_STATES.has(run.state)) return run;
    run.cancel_requested_at = now();
    if (["queued", "waiting_for_approval"].includes(run.state)) {
      const declinedPublication = run.state === "waiting_for_approval";
      Object.assign(run, { state: "cancelled", finished_at: now(), updated_at: now() });
      await this.appendEvent(run, "run.cancelled", {
        message: declinedPublication
          ? "Publication declined and workspace discarded"
          : "Run cancelled before execution",
      });
    } else {
      await this.appendEvent(run, "run.cancel_requested", { message: "Cancellation requested" });
    }
    return run;
  }

  async isCancellationRequested(runId) {
    return !!this.runs.get(runId)?.cancel_requested_at;
  }

  async createArtifact(run, input) {
    const row = { id: newId(), owner: run.owner, run_id: run.id, storage_key: null, url: null,
      created_at: now(), metadata: {}, ...input };
    this.artifacts.set(row.id, row);
    return row;
  }

  async listArtifacts(owner, runId) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    return [...this.artifacts.values()].filter((x) => x.run_id === runId).sort(byCreated);
  }

  async createCheckpoint(run, input) {
    const rows = [...this.checkpoints.values()].filter((x) => x.run_id === run.id);
    const row = { id: newId(), owner: run.owner, run_id: run.id, sequence: rows.length + 1,
      created_at: now(), metadata: {}, git_sha: null, snapshot_id: null, ...input };
    this.checkpoints.set(row.id, row);
    return row;
  }

  async recordUsage(run, input) {
    const row = { id: newId(), owner: run.owner, run_id: run.id, created_at: now(),
      amount_gbp: 0, compute_seconds: 0, metadata: {}, ...input };
    this.usageRecords.set(row.id, row);
    return row;
  }

  async usageSummary(owner) {
    return summarizeUsage([...this.usageRecords.values()].filter((x) => x.owner === owner));
  }
}

export class SupabaseCodeAgentStore {
  constructor(client = serviceClient()) {
    this.client = client;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
  }

  query(table, owner) {
    return this.client.from(table).select("*").eq("owner", owner);
  }

  async listRepositories(owner) {
    return unwrap(await this.query("ca_repositories", owner).order("updated_at", { ascending: false }));
  }

  async createRepository(owner, input) {
    const { data, error } = await this.client.from("ca_repositories")
      .upsert({ owner, ...input }, { onConflict: "owner,provider,full_name" }).select("*").single();
    return unwrapOne(data, error);
  }

  async getRepository(owner, id) {
    return unwrapMaybe(await this.query("ca_repositories", owner).eq("id", id).maybeSingle());
  }

  async listGithubInstallations(owner) {
    return unwrap(await this.query("ca_github_installations", owner).order("updated_at", { ascending: false }));
  }

  async upsertGithubInstallation(owner, input) {
    const { data: existing, error: lookupError } = await this.client.from("ca_github_installations")
      .select("owner").eq("installation_id", input.installation_id).maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (existing && existing.owner !== owner) throw installationClaimed();
    const { data, error } = await this.client.from("ca_github_installations")
      .upsert({ owner, ...input }, { onConflict: "installation_id" }).select("*").single();
    return unwrapOne(data, error);
  }

  async getGithubInstallation(owner, installationId) {
    return unwrapMaybe(await this.query("ca_github_installations", owner)
      .eq("installation_id", Number(installationId)).maybeSingle());
  }

  async listAgents(owner) {
    return unwrap(await this.query("ca_agents", owner).is("archived_at", null).order("updated_at", { ascending: false }));
  }

  async createAgent(owner, input) {
    const { data, error } = await this.client.from("ca_agents").insert({ owner, ...input }).select("*").single();
    return unwrapOne(data, error);
  }

  async getAgent(owner, id) {
    return unwrapMaybe(await this.query("ca_agents", owner).eq("id", id).maybeSingle());
  }

  async createRun(owner, agent, repository, input) {
    const { data, error } = await this.client.from("ca_runs").insert({
      owner, agent_id: agent.id, repository_id: repository.id, base_branch: repository.default_branch, ...input,
    }).select("*").single();
    const run = unwrapOne(data, error);
    await this.appendEvent(run, "run.queued", { message: "Run queued" });
    return run;
  }

  async getRun(owner, id) {
    return unwrapMaybe(await this.query("ca_runs", owner).eq("id", id).maybeSingle());
  }

  async getLatestRun(owner, agentId) {
    return unwrapMaybe(await this.query("ca_runs", owner).eq("agent_id", agentId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle());
  }

  async claimRuns(limit = 1) {
    const { data, error } = await this.client.rpc("claim_code_agent_runs", { p_limit: limit });
    return unwrapOne(data || [], error);
  }

  async interruptStaleRuns(staleBefore) {
    const { data, error } = await this.client.from("ca_runs").update({
      state: "interrupted",
      error_code: "worker_interrupted",
      error: "The worker stopped before this run completed. Retry the run to continue.",
      finished_at: now(),
    }).in("state", ["provisioning", "indexing", "running"]).lt("updated_at", staleBefore).select("*");
    const rows = unwrapOne(data || [], error);
    for (const run of rows) {
      await this.appendEvent(run, "run.interrupted", { message: run.error });
    }
    return rows;
  }

  async updateRun(run, patch) {
    const { data, error } = await this.client.from("ca_runs")
      .update(patch).eq("id", run.id).eq("owner", run.owner).select("*").single();
    return unwrapOne(data, error);
  }

  async appendEvent(run, type, payload = {}) {
    const { data: latest, error: latestError } = await this.client.from("ca_run_events")
      .select("sequence").eq("run_id", run.id).order("sequence", { ascending: false }).limit(1);
    if (latestError) throw new Error(latestError.message);
    const sequence = Number(latest?.[0]?.sequence || 0) + 1;
    const { data, error } = await this.client.from("ca_run_events")
      .insert({ owner: run.owner, run_id: run.id, sequence, type, payload }).select("*").single();
    const event = unwrapOne(data, error);
    this.bus.emit(`run:${run.id}`, event);
    return event;
  }

  async listEvents(owner, runId, after = 0) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    return unwrap(await this.client.from("ca_run_events").select("*").eq("run_id", runId)
      .gt("sequence", after).order("sequence"));
  }

  subscribe(runId, listener) {
    const key = `run:${runId}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }

  async requestCancel(owner, id) {
    const run = await this.getRun(owner, id);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return run;
    const timestamp = now();
    const immediatelyCancelled = ["queued", "waiting_for_approval"].includes(run.state);
    const patch = immediatelyCancelled
      ? { cancel_requested_at: timestamp, state: "cancelled", finished_at: timestamp }
      : { cancel_requested_at: timestamp };
    const updated = await this.updateRun(run, patch);
    await this.appendEvent(updated, immediatelyCancelled ? "run.cancelled" : "run.cancel_requested",
      { message: run.state === "waiting_for_approval"
        ? "Publication declined and workspace discarded"
        : run.state === "queued" ? "Run cancelled before execution" : "Cancellation requested" });
    return updated;
  }

  async isCancellationRequested(runId) {
    const { data, error } = await this.client.from("ca_runs").select("cancel_requested_at").eq("id", runId).single();
    if (error) throw new Error(error.message);
    return !!data.cancel_requested_at;
  }

  async createArtifact(run, input) {
    const { data, error } = await this.client.from("ca_artifacts")
      .insert({ owner: run.owner, run_id: run.id, ...input }).select("*").single();
    return unwrapOne(data, error);
  }

  async listArtifacts(owner, runId) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    return unwrap(await this.client.from("ca_artifacts").select("*").eq("owner", owner)
      .eq("run_id", runId).order("created_at"));
  }

  async createCheckpoint(run, input) {
    const { data: latest, error: latestError } = await this.client.from("ca_checkpoints")
      .select("sequence").eq("run_id", run.id).order("sequence", { ascending: false }).limit(1);
    if (latestError) throw new Error(latestError.message);
    const { data, error } = await this.client.from("ca_checkpoints").insert({
      owner: run.owner, run_id: run.id, sequence: Number(latest?.[0]?.sequence || 0) + 1, ...input,
    }).select("*").single();
    return unwrapOne(data, error);
  }

  async recordUsage(run, input) {
    const { data, error } = await this.client.from("ca_usage_records")
      .insert({ owner: run.owner, run_id: run.id, ...input }).select("*").single();
    return unwrapOne(data, error);
  }

  async usageSummary(owner) {
    const rows = unwrap(await this.client.from("ca_usage_records").select("*")
      .eq("owner", owner).order("created_at", { ascending: false }).limit(500));
    return summarizeUsage(rows);
  }
}

function byNewest(a, b) {
  return b.updated_at.localeCompare(a.updated_at);
}

function byCreated(a, b) {
  return a.created_at.localeCompare(b.created_at);
}

function summarizeUsage(rows) {
  const totals = rows.reduce((sum, row) => ({
    inputTokens: sum.inputTokens + Number(row.input_tokens || 0),
    cachedTokens: sum.cachedTokens + Number(row.cached_tokens || 0),
    outputTokens: sum.outputTokens + Number(row.output_tokens || 0),
    reasoningTokens: sum.reasoningTokens + Number(row.reasoning_tokens || 0),
    computeSeconds: sum.computeSeconds + Number(row.compute_seconds || 0),
    amountGbp: sum.amountGbp + Number(row.amount_gbp || 0),
  }), { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, computeSeconds: 0, amountGbp: 0 });
  return { totals, records: rows.slice(0, 50) };
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

function installationClaimed() {
  const error = new Error("This GitHub installation is already connected to another Thrallo account.");
  error.code = "github_installation_claimed";
  error.status = 409;
  return error;
}

let singleton;
export function codeAgentStore() {
  if (singleton) return singleton;
  const mode = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase();
  singleton = mode === "supabase" ? new SupabaseCodeAgentStore() : new MemoryCodeAgentStore();
  return singleton;
}

export function resetCodeAgentStoreForTests() {
  singleton = null;
}
