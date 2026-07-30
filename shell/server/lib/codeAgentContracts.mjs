import crypto from "node:crypto";

export const RUN_STATES = Object.freeze([
  "queued", "provisioning", "indexing", "running", "waiting_for_approval",
  "waiting_for_user", "succeeded", "failed", "cancelled", "interrupted",
]);

export const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
export const AGENT_MODES = new Set(["ask", "plan", "agent", "review"]);

export class CodeAgentInputError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.name = "CodeAgentInputError";
    this.status = status;
    this.code = code;
  }
}
export function newId() {
  return crypto.randomUUID();
}

export function requiredString(value, name, { max = 10_000 } = {}) {
  const out = String(value ?? "").trim();
  if (!out) throw new CodeAgentInputError(`${name} is required`);
  if (out.length > max) throw new CodeAgentInputError(`${name} is too long`);
  return out;
}

export function optionalString(value, { max = 2_000 } = {}) {
  const out = String(value ?? "").trim();
  if (out.length > max) throw new CodeAgentInputError("value is too long");
  return out || null;
}

export function parseRepositoryInput(body = {}) {
  const fullName = requiredString(body.fullName, "fullName", { max: 255 });
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw new CodeAgentInputError("fullName must look like owner/repository");
  }
  const cloneUrl = optionalString(body.cloneUrl, { max: 2_000 })
    || `https://github.com/${fullName}.git`;
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(cloneUrl)) {
    throw new CodeAgentInputError("Only HTTPS GitHub clone URLs are supported in v1");
  }
  return {
    full_name: fullName,
    clone_url: cloneUrl,
    default_branch: optionalString(body.defaultBranch, { max: 255 }) || "main",
    private: body.private !== false,
    provider: "github",
  };
}

export const PUBLISH_MODES = new Set(["require_approval", "auto_publish"]);
export const NETWORK_POLICIES = new Set(["full", "offline"]);
export const COMMAND_POLICIES = new Set(["standard", "restricted"]);

export function parseAgentInput(body = {}) {
  const mode = String(body.mode || "agent").toLowerCase();
  if (!AGENT_MODES.has(mode)) throw new CodeAgentInputError("Unsupported agent mode");
  return {
    repository_id: requiredString(body.repositoryId, "repositoryId", { max: 64 }),
    name: optionalString(body.name, { max: 120 }) || "New agent",
    mode,
    ...parseAgentPolicy(body, { defaults: true }),
  };
}

// Partial policy update for PATCH /agents/:id — only the provided fields change.
export function parseAgentPatch(body = {}) {
  const patch = {};
  if (body.name !== undefined) {
    patch.name = requiredString(body.name, "name", { max: 120 });
  }
  Object.assign(patch, parseAgentPolicy(body, { defaults: false }));
  if (!Object.keys(patch).length) {
    throw new CodeAgentInputError("Provide name, publishMode, or protectedPaths");
  }
  return patch;
}

function parseAgentPolicy(body, { defaults }) {
  const policy = {};
  if (body.publishMode !== undefined || defaults) {
    const mode = String(body.publishMode || "require_approval").toLowerCase();
    if (!PUBLISH_MODES.has(mode)) {
      throw new CodeAgentInputError("publishMode must be require_approval or auto_publish");
    }
    policy.publish_mode = mode;
  }
  if (body.protectedPaths !== undefined || defaults) {
    const raw = body.protectedPaths ?? [];
    if (!Array.isArray(raw) || raw.length > 50) {
      throw new CodeAgentInputError("protectedPaths must be an array of at most 50 glob patterns");
    }
    policy.protected_paths = raw.map((entry) => {
      const pattern = String(entry ?? "").trim();
      if (!pattern || pattern.length > 200) {
        throw new CodeAgentInputError("Each protected path must be a non-empty glob of at most 200 characters");
      }
      return pattern;
    });
  }
  if (body.networkPolicy !== undefined || defaults) {
    const value = String(body.networkPolicy || "full").toLowerCase();
    if (!NETWORK_POLICIES.has(value)) {
      throw new CodeAgentInputError("networkPolicy must be full or offline");
    }
    policy.network_policy = value;
  }
  if (body.commandPolicy !== undefined || defaults) {
    const value = String(body.commandPolicy || "standard").toLowerCase();
    if (!COMMAND_POLICIES.has(value)) {
      throw new CodeAgentInputError("commandPolicy must be standard or restricted");
    }
    policy.command_policy = value;
  }
  return policy;
}

export function parseRunInput(body = {}, agent) {
  const mode = String(body.mode || agent.mode || "agent").toLowerCase();
  if (!AGENT_MODES.has(mode)) throw new CodeAgentInputError("Unsupported run mode");
  const input = {
    prompt: requiredString(body.prompt, "prompt", { max: 50_000 }),
    mode,
    model: optionalString(body.model, { max: 120 }) || "auto",
  };
  if (body.pullRequestNumber !== undefined && body.pullRequestNumber !== null) {
    const number = Math.floor(Number(body.pullRequestNumber));
    if (!Number.isFinite(number) || number <= 0) {
      throw new CodeAgentInputError("pullRequestNumber must be a positive integer");
    }
    if (mode !== "review") {
      throw new CodeAgentInputError("pullRequestNumber is only valid for review runs");
    }
    input.pull_request = number;
  }
  return input;
}

export function publicRun(run) {
  if (!run) return null;
  const {
    id, agent_id, repository_id, prompt, mode, model, base_branch, work_branch, state,
    result, usage, error_code, error, cancel_requested_at, started_at, finished_at,
    created_at, updated_at,
  } = run;
  return {
    id, agentId: agent_id, repositoryId: repository_id, prompt, mode, model,
    baseBranch: base_branch, workBranch: work_branch, state, result, usage,
    errorCode: error_code, error, cancelRequestedAt: cancel_requested_at,
    startedAt: started_at, finishedAt: finished_at, createdAt: created_at, updatedAt: updated_at,
    resumedFromRunId: run.resumed_from_run_id || null,
    resumable: isRunResumable(run),
    pullRequest: run.pull_request ? Number(run.pull_request) : null,
    automationId: run.automation_id || null,
  };
}

export function isRunResumable(run) {
  return !!(run?.sandbox_id
    && ["failed", "interrupted"].includes(run.state)
    && run.sandbox_state !== "discarded");
}

export function publicRepository(row) {
  return {
    id: row.id, provider: row.provider, fullName: row.full_name, cloneUrl: row.clone_url,
    defaultBranch: row.default_branch, private: row.private, status: row.status,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function publicAgent(row) {
  return {
    id: row.id, repositoryId: row.repository_id, name: row.name, mode: row.mode,
    publishMode: row.publish_mode || "require_approval",
    protectedPaths: Array.isArray(row.protected_paths) ? row.protected_paths : [],
    networkPolicy: row.network_policy || "full",
    commandPolicy: row.command_policy || "standard",
    archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
