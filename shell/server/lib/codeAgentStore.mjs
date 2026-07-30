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
    this.webhookDeliveries = new Map();
    this.artifacts = new Map();
    this.usageRecords = new Map();
    this.checkpoints = new Map();
    this.subscriptions = new Map();
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

  async findRepositoryByExternalId(installationId, externalId) {
    return [...this.repositories.values()].find((row) =>
      Number(row.installation_id) === Number(installationId)
      && Number(row.external_id) === Number(externalId)) || null;
  }

  async listGithubInstallations(owner) {
    return [...this.installations.values()]
      .filter((x) => x.owner === owner && (x.status || "active") === "active")
      .sort(byNewest);
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
      .find((x) => x.owner === owner
        && x.installation_id === Number(installationId)
        && (x.status || "active") === "active") || null;
  }

  async findGithubInstallation(installationId) {
    return [...this.installations.values()]
      .find((x) => x.installation_id === Number(installationId)) || null;
  }

  async updateGithubInstallationLifecycle(installationId, patch) {
    const row = await this.findGithubInstallation(installationId);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: now() });
    return row;
  }

  async syncGithubRepositoryAccess(installationId, accessibleRepositoryIds, reason) {
    const accessible = accessibleRepositoryIds === null
      ? null
      : new Set(accessibleRepositoryIds.map(Number));
    const rows = [...this.repositories.values()]
      .filter((x) => x.installation_id === Number(installationId));
    let ready = 0;
    let disconnected = 0;
    for (const row of rows) {
      const allowed = accessible?.has(Number(row.external_id)) || false;
      Object.assign(row, {
        status: allowed ? "ready" : "disconnected",
        last_error: allowed ? null : reason,
        updated_at: now(),
      });
      if (allowed) ready += 1;
      else disconnected += 1;
    }
    return { ready, disconnected, total: rows.length };
  }

  async recordGithubWebhookDelivery(input) {
    const existing = this.webhookDeliveries.get(input.delivery_id);
    if (existing) return { delivery: existing, isNew: false };
    const row = {
      status: "received",
      attempts: 0,
      next_attempt_at: null,
      error: null,
      result: {},
      received_at: now(),
      processed_at: null,
      updated_at: now(),
      ...input,
    };
    this.webhookDeliveries.set(row.delivery_id, row);
    return { delivery: row, isNew: true };
  }

  async claimGithubWebhookDeliveries(limit = 10) {
    const timestamp = now();
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    const rows = [...this.webhookDeliveries.values()]
      .filter((x) => x.status === "received"
        || (x.status === "failed" && x.attempts < 10
          && (!x.next_attempt_at || x.next_attempt_at <= timestamp))
        || (x.status === "processing" && x.attempts < 10 && x.updated_at <= staleBefore))
      .sort((a, b) => a.received_at.localeCompare(b.received_at))
      .slice(0, Math.min(Math.max(Number(limit) || 10, 1), 100));
    for (const row of rows) {
      Object.assign(row, {
        status: "processing",
        attempts: row.attempts + 1,
        next_attempt_at: null,
        error: null,
        processed_at: null,
        updated_at: now(),
      });
    }
    return rows;
  }

  async completeGithubWebhookDelivery(deliveryId, patch) {
    const row = this.webhookDeliveries.get(deliveryId);
    if (!row) throw new Error("GitHub webhook delivery disappeared");
    Object.assign(row, patch, { updated_at: now() });
    return row;
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

  async updateAgent(owner, id, patch) {
    const row = await this.getAgent(owner, id);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: now() });
    return row;
  }

  async createRun(owner, agent, repository, input) {
    const row = {
      id: newId(), owner, agent_id: agent.id, repository_id: repository.id,
      resumed_from_run_id: null, sandbox_state: null, pruned_at: null, ...input,
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

  async getArtifactContent(owner, runId, artifactId) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    const row = this.artifacts.get(artifactId);
    if (!row || row.run_id !== runId) return null;
    return { content: row.content || "", contentType: row.content_type || "text/plain" };
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

  async getSubscription(owner) {
    return this.subscriptions.get(owner) || null;
  }

  async upsertSubscription(owner, patch) {
    const row = this.subscriptions.get(owner)
      || { owner, plan: "free", status: "active", metadata: {}, created_at: now() };
    Object.assign(row, patch, { owner, updated_at: now() });
    this.subscriptions.set(owner, row);
    return row;
  }

  async findSubscriptionByStripeCustomer(customerId) {
    return [...this.subscriptions.values()]
      .find((x) => x.stripe_customer_id === customerId) || null;
  }

  async usageTotalsSince(owner, sinceIso) {
    const rows = [...this.usageRecords.values()]
      .filter((x) => x.owner === owner && x.created_at >= sinceIso);
    return sumBudgetUsage(rows);
  }

  async countRunsSince(owner, sinceIso) {
    return [...this.runs.values()].filter((run) => run.owner === owner
      && run.created_at >= sinceIso
      && (run.started_at || run.state !== "cancelled")).length;
  }

  async countActiveRuns(owner) {
    return [...this.runs.values()].filter((run) => run.owner === owner
      && ["queued", "provisioning", "indexing", "running"].includes(run.state)).length;
  }

  async listPrunableRuns(cutoffIso, limit = 50) {
    return [...this.runs.values()]
      .filter((run) => run.finished_at && run.finished_at < cutoffIso && !run.pruned_at)
      .sort((a, b) => a.finished_at.localeCompare(b.finished_at))
      .slice(0, limit);
  }

  async pruneRun(run) {
    this.events.delete(run.id);
    for (const [id, artifact] of this.artifacts) {
      if (artifact.run_id === run.id) this.artifacts.delete(id);
    }
    const current = this.runs.get(run.id);
    if (current) Object.assign(current, { pruned_at: now(), updated_at: now() });
    return current || run;
  }

  async opsRunRows(sinceIso) {
    return [...this.runs.values()]
      .filter((run) => run.created_at >= sinceIso || !TERMINAL_RUN_STATES.has(run.state))
      .map(({ state, created_at, started_at, finished_at }) =>
        ({ state, created_at, started_at, finished_at }));
  }

  async opsWebhookStatusCounts() {
    return countBy([...this.webhookDeliveries.values()], (row) => row.status);
  }

  async opsUsageRows(sinceIso) {
    return [...this.usageRecords.values()]
      .filter((row) => row.created_at >= sinceIso)
      .map(({ billing_source, input_tokens, output_tokens, compute_seconds, created_at }) =>
        ({ billing_source, input_tokens, output_tokens, compute_seconds, created_at }));
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

  async findRepositoryByExternalId(installationId, externalId) {
    return unwrapMaybe(await this.client.from("ca_repositories").select("*")
      .eq("installation_id", Number(installationId))
      .eq("external_id", Number(externalId))
      .maybeSingle());
  }

  async listGithubInstallations(owner) {
    return unwrap(await this.query("ca_github_installations", owner).eq("status", "active")
      .order("updated_at", { ascending: false }));
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
      .eq("installation_id", Number(installationId)).eq("status", "active").maybeSingle());
  }

  async findGithubInstallation(installationId) {
    return unwrapMaybe(await this.client.from("ca_github_installations").select("*")
      .eq("installation_id", Number(installationId)).maybeSingle());
  }

  async updateGithubInstallationLifecycle(installationId, patch) {
    const { data, error } = await this.client.from("ca_github_installations")
      .update({ ...patch, updated_at: now() })
      .eq("installation_id", Number(installationId)).select("*").maybeSingle();
    return unwrapMaybe({ data, error });
  }

  async syncGithubRepositoryAccess(installationId, accessibleRepositoryIds, reason) {
    const rows = unwrap(await this.client.from("ca_repositories").select("id,external_id")
      .eq("installation_id", Number(installationId)));
    const accessible = accessibleRepositoryIds === null
      ? null
      : new Set(accessibleRepositoryIds.map(Number));
    const readyIds = [];
    const disconnectedIds = [];
    for (const row of rows) {
      if (accessible?.has(Number(row.external_id))) readyIds.push(row.id);
      else disconnectedIds.push(row.id);
    }
    if (readyIds.length) {
      const { error } = await this.client.from("ca_repositories")
        .update({ status: "ready", last_error: null, updated_at: now() }).in("id", readyIds);
      if (error) throw new Error(error.message);
    }
    if (disconnectedIds.length) {
      const { error } = await this.client.from("ca_repositories")
        .update({ status: "disconnected", last_error: reason, updated_at: now() }).in("id", disconnectedIds);
      if (error) throw new Error(error.message);
    }
    return { ready: readyIds.length, disconnected: disconnectedIds.length, total: rows.length };
  }

  async recordGithubWebhookDelivery(input) {
    const { data, error } = await this.client.from("ca_github_webhook_deliveries")
      .insert(input).select("*").single();
    if (!error) return { delivery: data, isNew: true };
    if (error.code !== "23505") throw new Error(error.message);
    const delivery = unwrapMaybe(await this.client.from("ca_github_webhook_deliveries")
      .select("*").eq("delivery_id", input.delivery_id).maybeSingle());
    return { delivery, isNew: false };
  }

  async claimGithubWebhookDeliveries(limit = 10) {
    const { data, error } = await this.client.rpc("claim_github_webhook_deliveries", {
      p_limit: limit,
    });
    return unwrapOne(data || [], error);
  }

  async completeGithubWebhookDelivery(deliveryId, patch) {
    const { data, error } = await this.client.from("ca_github_webhook_deliveries")
      .update(patch).eq("delivery_id", deliveryId).select("*").single();
    return unwrapOne(data, error);
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

  async updateAgent(owner, id, patch) {
    return unwrapMaybe(await this.client.from("ca_agents")
      .update({ ...patch, updated_at: now() })
      .eq("owner", owner).eq("id", id).select("*").maybeSingle());
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

  // Content beyond the inline threshold is offloaded to the private artifact bucket so large
  // diffs and logs never bloat Postgres rows; the row keeps only the storage key.
  async createArtifact(run, input) {
    const record = { owner: run.owner, run_id: run.id, ...input };
    const content = String(record.content ?? "");
    if (Buffer.byteLength(content) > artifactInlineLimit()) {
      const storageKey = `${run.owner}/${run.id}/${newId()}-${String(record.name || "artifact").replace(/[^\w.-]/g, "_")}`;
      const { error: uploadError } = await this.client.storage.from(artifactBucket())
        .upload(storageKey, Buffer.from(content, "utf8"), {
          contentType: record.content_type || "text/plain",
          upsert: true,
        });
      if (uploadError) throw new Error(`artifact upload failed: ${uploadError.message}`);
      record.storage_key = storageKey;
      record.content = null;
    }
    const { data, error } = await this.client.from("ca_artifacts")
      .insert(record).select("*").single();
    return unwrapOne(data, error);
  }

  async listArtifacts(owner, runId) {
    const run = await this.getRun(owner, runId);
    if (!run) return null;
    return unwrap(await this.client.from("ca_artifacts").select("*").eq("owner", owner)
      .eq("run_id", runId).order("created_at"));
  }

  async getArtifactContent(owner, runId, artifactId) {
    const row = unwrapMaybe(await this.client.from("ca_artifacts").select("*")
      .eq("owner", owner).eq("run_id", runId).eq("id", artifactId).maybeSingle());
    if (!row) return null;
    if (row.content != null || !row.storage_key) {
      return { content: row.content || "", contentType: row.content_type || "text/plain" };
    }
    const { data, error } = await this.client.storage.from(artifactBucket()).download(row.storage_key);
    if (error) throw new Error(`artifact download failed: ${error.message}`);
    return {
      content: Buffer.from(await data.arrayBuffer()).toString("utf8"),
      contentType: row.content_type || "text/plain",
    };
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

  async getSubscription(owner) {
    return unwrapMaybe(await this.client.from("ca_subscriptions").select("*")
      .eq("owner", owner).maybeSingle());
  }

  async upsertSubscription(owner, patch) {
    const { data, error } = await this.client.from("ca_subscriptions")
      .upsert({ owner, ...patch, updated_at: now() }, { onConflict: "owner" }).select("*").single();
    return unwrapOne(data, error);
  }

  async findSubscriptionByStripeCustomer(customerId) {
    return unwrapMaybe(await this.client.from("ca_subscriptions").select("*")
      .eq("stripe_customer_id", customerId).maybeSingle());
  }

  async usageTotalsSince(owner, sinceIso) {
    const rows = unwrap(await this.client.from("ca_usage_records")
      .select("billing_source,input_tokens,cached_tokens,output_tokens,reasoning_tokens,compute_seconds")
      .eq("owner", owner).gte("created_at", sinceIso).limit(5_000));
    return sumBudgetUsage(rows);
  }

  async countRunsSince(owner, sinceIso) {
    const { count, error } = await this.client.from("ca_runs")
      .select("id", { count: "exact", head: true })
      .eq("owner", owner).gte("created_at", sinceIso)
      .or("started_at.not.is.null,state.neq.cancelled");
    if (error) throw new Error(error.message);
    return Number(count || 0);
  }

  async countActiveRuns(owner) {
    const { count, error } = await this.client.from("ca_runs")
      .select("id", { count: "exact", head: true })
      .eq("owner", owner).in("state", ["queued", "provisioning", "indexing", "running"]);
    if (error) throw new Error(error.message);
    return Number(count || 0);
  }

  async listPrunableRuns(cutoffIso, limit = 50) {
    return unwrap(await this.client.from("ca_runs").select("id,owner,finished_at")
      .is("pruned_at", null).not("finished_at", "is", null).lt("finished_at", cutoffIso)
      .order("finished_at").limit(limit));
  }

  async pruneRun(run) {
    const artifacts = unwrap(await this.client.from("ca_artifacts")
      .select("storage_key").eq("run_id", run.id).not("storage_key", "is", null));
    const keys = artifacts.map((row) => row.storage_key).filter(Boolean);
    if (keys.length) {
      const { error } = await this.client.storage.from(artifactBucket()).remove(keys);
      if (error) throw new Error(`artifact storage cleanup failed: ${error.message}`);
    }
    const { error: artifactError } = await this.client.from("ca_artifacts").delete().eq("run_id", run.id);
    if (artifactError) throw new Error(artifactError.message);
    const { error: eventError } = await this.client.from("ca_run_events").delete().eq("run_id", run.id);
    if (eventError) throw new Error(eventError.message);
    const { data, error } = await this.client.from("ca_runs")
      .update({ pruned_at: now() }).eq("id", run.id).select("*").single();
    return unwrapOne(data, error);
  }

  async opsRunRows(sinceIso) {
    return unwrap(await this.client.from("ca_runs")
      .select("state,created_at,started_at,finished_at")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(5_000));
  }

  async opsWebhookStatusCounts() {
    const rows = unwrap(await this.client.from("ca_github_webhook_deliveries")
      .select("status").order("received_at", { ascending: false }).limit(5_000));
    return countBy(rows, (row) => row.status);
  }

  async opsUsageRows(sinceIso) {
    return unwrap(await this.client.from("ca_usage_records")
      .select("billing_source,input_tokens,output_tokens,compute_seconds,created_at")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(5_000));
  }
}

function byNewest(a, b) {
  return b.updated_at.localeCompare(a.updated_at);
}

function byCreated(a, b) {
  return a.created_at.localeCompare(b.created_at);
}

function artifactInlineLimit() {
  const value = Number(optionalEnv("CODE_AGENT_ARTIFACT_INLINE_BYTES", "16384"));
  return Number.isFinite(value) && value > 0 ? value : 16_384;
}

function artifactBucket() {
  return optionalEnv("CODE_AGENT_ARTIFACT_BUCKET", "thrallo-artifacts");
}

function sumBudgetUsage(rows) {
  const totals = { managedTokens: 0, totalTokens: 0, computeSeconds: 0 };
  for (const row of rows) {
    const tokens = Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    totals.totalTokens += tokens;
    totals.computeSeconds += Number(row.compute_seconds || 0);
    if ((row.billing_source || "unknown") === "managed") totals.managedTokens += tokens;
  }
  return totals;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = key(row) || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
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
