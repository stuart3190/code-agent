import {
  CodeAgentInputError, isRunResumable, optionalString, parseAgentInput, parseAgentPatch,
  parseRepositoryInput, parseRunInput, requiredString,
  publicAgent, publicRepository, publicRun, TERMINAL_RUN_STATES,
} from "../lib/codeAgentContracts.mjs";
import { codeAgentStore } from "../lib/codeAgentStore.mjs";
import {
  approveRunPublication, codeAgentCapabilities, discardRunSandbox,
} from "../lib/codeAgentService.mjs";
import {
  publicIndexStatus,
  repositoryIndexStore,
} from "../lib/repositoryIndexStore.mjs";
import {
  retrieveFileGraph,
  retrieveRepositoryContext,
  retrieveRepositoryMap,
} from "../lib/repositoryIndexer.mjs";
import { requestRepositoryRefresh } from "../lib/repositoryIndexService.mjs";
import { assertRunWithinBudget, assertWithinRateLimits, budgetOverview } from "../lib/usageBudgets.mjs";
import { activeAiProviderName } from "../lib/aiCredentialStore.mjs";
import { listPullRequests } from "../lib/githubApp.mjs";
import { completeCode, parseCompletionInput } from "../lib/completions.mjs";

async function assertBudgetAllowsRun(ownerId) {
  const credentialProvider = await activeAiProviderName(ownerId).catch(() => "managed");
  try {
    await assertWithinRateLimits(ownerId);
    await assertRunWithinBudget(ownerId, { credentialProvider });
  } catch (error) {
    throw new CodeAgentInputError(error.message, error.status || 402, error.code || "budget_exceeded");
  }
}

export function handleCodeAgentCapabilities(_req, res) {
  sendJson(res, 200, codeAgentCapabilities());
}

export async function handleRepositories(req, res, { owner, method, body }) {
  const store = codeAgentStore();
  if (method === "GET") {
    return sendJson(res, 200, { repositories: (await store.listRepositories(owner.id)).map(publicRepository) });
  }
  const repository = await store.createRepository(owner.id, parseRepositoryInput(body));
  return sendJson(res, 201, { repository: publicRepository(repository) });
}

export async function handleRepositoryIndexGet(_req, res, { owner, repositoryId }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  const index = await repositoryIndexStore().getIndex(owner.id, repositoryId);
  return sendJson(res, 200, { index: publicIndexStatus(index) });
}

export async function handleRepositoryIndexRefresh(_req, res, { owner, repositoryId }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  const current = await repositoryIndexStore().getIndex(owner.id, repositoryId);
  if (["queued", "indexing"].includes(current?.status)) {
    return sendJson(res, 202, { index: publicIndexStatus(current), alreadyQueued: true });
  }
  const index = await requestRepositoryRefresh(owner.id, repository, {
    reason: "manual",
    requestedBy: owner.id,
  });
  return sendJson(res, 202, { index: publicIndexStatus(index), alreadyQueued: false });
}

export async function handleRepositorySearch(_req, res, { owner, repositoryId, body }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  const index = await repositoryIndexStore().getIndex(owner.id, repositoryId);
  if (index?.status !== "ready") {
    throw new CodeAgentInputError(
      "Run this repository's agent once to build its code index.",
      409,
      "repository_index_not_ready",
    );
  }
  const query = requiredString(body?.query, "query", { max: 2_000 });
  const results = await retrieveRepositoryContext(owner.id, repositoryId, query, { limit: 20 });
  return sendJson(res, 200, {
    query,
    index: publicIndexStatus(index),
    results: results.map((result) => ({
      path: result.path,
      language: result.language,
      startLine: result.startLine,
      endLine: result.endLine,
      content: result.content,
      score: result.score,
    })),
  });
}

export async function handleRepositorySymbolSearch(_req, res, { owner, repositoryId, body }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  const index = await repositoryIndexStore().getIndex(owner.id, repositoryId);
  if (index?.status !== "ready") {
    throw new CodeAgentInputError("The repository intelligence index is not ready.", 409, "repository_index_not_ready");
  }
  const query = requiredString(body?.query, "query", { max: 500 });
  const symbols = await retrieveRepositoryMap(owner.id, repositoryId, query, { limit: 30 });
  return sendJson(res, 200, {
    query,
    index: publicIndexStatus(index),
    symbols,
  });
}

export async function handleRepositoryFileGraph(_req, res, { owner, repositoryId, body }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  const index = await repositoryIndexStore().getIndex(owner.id, repositoryId);
  if (index?.status !== "ready") {
    throw new CodeAgentInputError("The repository intelligence index is not ready.", 409, "repository_index_not_ready");
  }
  const path = requiredString(body?.path, "path", { max: 1_000 });
  const graph = await retrieveFileGraph(owner.id, repositoryId, path);
  if (!graph) throw new CodeAgentInputError("Indexed file not found", 404, "indexed_file_not_found");
  return sendJson(res, 200, { index: publicIndexStatus(index), graph });
}

export async function handleRepositoryPulls(_req, res, { owner, repositoryId }) {
  const repository = await codeAgentStore().getRepository(owner.id, repositoryId);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  if (!repository.installation_id) {
    throw new CodeAgentInputError(
      "Pull-request review requires a GitHub App repository connection",
      409,
      "github_installation_required",
    );
  }
  try {
    const pulls = await listPullRequests({
      installationId: repository.installation_id,
      repository: repository.full_name,
    });
    return sendJson(res, 200, { pulls });
  } catch (error) {
    throw new CodeAgentInputError(error.message, 502, "github_pulls_failed");
  }
}

export async function handleAgents(req, res, { owner, method, body }) {
  const store = codeAgentStore();
  if (method === "GET") {
    return sendJson(res, 200, { agents: (await store.listAgents(owner.id)).map(publicAgent) });
  }
  const input = parseAgentInput(body);
  if (!await store.getRepository(owner.id, input.repository_id)) {
    throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  }
  const agent = await store.createAgent(owner.id, input);
  return sendJson(res, 201, { agent: publicAgent(agent) });
}

export async function handleAgentUpdate(_req, res, { owner, agentId, body }) {
  const agent = await codeAgentStore().updateAgent(owner.id, agentId, parseAgentPatch(body));
  if (!agent) throw new CodeAgentInputError("Agent not found", 404, "agent_not_found");
  return sendJson(res, 200, { agent: publicAgent(agent) });
}

export async function handleRunCreate(req, res, { owner, agentId, body }) {
  const store = codeAgentStore();
  const agent = await store.getAgent(owner.id, agentId);
  if (!agent) throw new CodeAgentInputError("Agent not found", 404, "agent_not_found");
  const repository = await store.getRepository(owner.id, agent.repository_id);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
  if (repository.status !== "ready") {
    throw new CodeAgentInputError(
      repository.last_error || "Repository access is unavailable",
      409,
      "repository_unavailable",
    );
  }
  await assertBudgetAllowsRun(owner.id);
  const run = await store.createRun(owner.id, agent, repository, parseRunInput(body, agent));
  return sendJson(res, 202, { run: publicRun(run) });
}

export async function handleRunGet(_req, res, { owner, runId }) {
  const run = await codeAgentStore().getRun(owner.id, runId);
  if (!run) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  return sendJson(res, 200, { run: publicRun(run) });
}

export async function handleLatestRunGet(_req, res, { owner, agentId }) {
  const run = await codeAgentStore().getLatestRun(owner.id, agentId);
  return sendJson(res, 200, { run: publicRun(run) });
}

export async function handleRunCancel(_req, res, { owner, runId }) {
  const store = codeAgentStore();
  let run = await store.requestCancel(owner.id, runId);
  if (!run) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  if (run.state === "cancelled" && run.sandbox_id) {
    await discardRunSandbox(run);
    run = await store.updateRun(run, { sandbox_state: "discarded" });
  }
  return sendJson(res, 202, { run: publicRun(run) });
}

export async function handleRunPublish(_req, res, { owner, runId, body }) {
  try {
    const run = await approveRunPublication(owner.id, runId, {
      title: body?.title,
      body: body?.body,
    });
    return sendJson(res, 200, { run: publicRun(run) });
  } catch (error) {
    if (error.status) throw new CodeAgentInputError(error.message, error.status, error.code);
    throw error;
  }
}

export async function handleRunRetry(_req, res, { owner, runId }) {
  const store = codeAgentStore();
  const previous = await store.getRun(owner.id, runId);
  if (!previous) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  if (!TERMINAL_RUN_STATES.has(previous.state)) {
    throw new CodeAgentInputError("Only a finished run can be retried", 409, "run_not_finished");
  }
  const agent = await store.getAgent(owner.id, previous.agent_id);
  const repository = await store.getRepository(owner.id, previous.repository_id);
  if (!agent || !repository) {
    throw new CodeAgentInputError("The agent or repository is no longer available", 409, "retry_source_missing");
  }
  if (repository.status !== "ready") {
    throw new CodeAgentInputError(
      repository.last_error || "Repository access is unavailable",
      409,
      "repository_unavailable",
    );
  }
  await assertBudgetAllowsRun(owner.id);
  const run = await store.createRun(owner.id, agent, repository, {
    prompt: previous.prompt,
    mode: previous.mode,
    model: previous.model,
  });
  return sendJson(res, 202, { run: publicRun(run), retriedFrom: previous.id });
}

export async function handleRunResume(_req, res, { owner, runId, body }) {
  const store = codeAgentStore();
  const previous = await store.getRun(owner.id, runId);
  if (!previous) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  if (!isRunResumable(previous)) {
    throw new CodeAgentInputError(
      "Only a failed or interrupted run with a preserved workspace can be resumed",
      409,
      "run_not_resumable",
    );
  }
  const agent = await store.getAgent(owner.id, previous.agent_id);
  const repository = await store.getRepository(owner.id, previous.repository_id);
  if (!agent || !repository) {
    throw new CodeAgentInputError("The agent or repository is no longer available", 409, "resume_source_missing");
  }
  if (repository.status !== "ready") {
    throw new CodeAgentInputError(
      repository.last_error || "Repository access is unavailable",
      409,
      "repository_unavailable",
    );
  }
  await assertBudgetAllowsRun(owner.id);
  const run = await store.createRun(owner.id, agent, repository, {
    prompt: optionalString(body?.prompt, { max: 50_000 }) || previous.prompt,
    mode: previous.mode,
    model: previous.model,
    resumed_from_run_id: previous.id,
  });
  return sendJson(res, 202, { run: publicRun(run), resumedFrom: previous.id });
}

export async function handleRunArtifacts(_req, res, { owner, runId }) {
  const rows = await codeAgentStore().listArtifacts(owner.id, runId);
  if (!rows) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  return sendJson(res, 200, { artifacts: rows.map(publicArtifact) });
}

export async function handleRunArtifactContent(_req, res, { owner, runId, artifactId }) {
  const artifact = await codeAgentStore().getArtifactContent(owner.id, runId, artifactId);
  if (!artifact) throw new CodeAgentInputError("Artifact not found", 404, "artifact_not_found");
  res.writeHead(200, {
    "Content-Type": `${artifact.contentType || "text/plain"}; charset=utf-8`,
    "Cache-Control": "private, max-age=300",
  });
  return res.end(artifact.content);
}

export async function handleCompletion(_req, res, { owner, body }) {
  try {
    const result = await completeCode(owner.id, parseCompletionInput(body));
    return sendJson(res, 200, result);
  } catch (error) {
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "completion_failed");
    }
    throw error;
  }
}

export async function handleUsage(_req, res, owner) {
  const [summary, overview] = await Promise.all([
    codeAgentStore().usageSummary(owner.id),
    budgetOverview(owner.id),
  ]);
  return sendJson(res, 200, {
    plan: overview.plan,
    budgets: overview.budgets,
    ownerAccount: overview.ownerAccount,
    previewPlan: overview.previewPlan,
    unlimited: overview.unlimited,
    totals: summary.totals,
    records: summary.records.map((row) => ({
      id: row.id,
      runId: row.run_id,
      provider: row.provider,
      model: row.model,
      input_tokens: Number(row.input_tokens || 0),
      cached_tokens: Number(row.cached_tokens || 0),
      output_tokens: Number(row.output_tokens || 0),
      reasoning_tokens: Number(row.reasoning_tokens || 0),
      compute_seconds: Number(row.compute_seconds || 0),
      amount_gbp: Number(row.amount_gbp || 0),
      createdAt: row.created_at,
    })),
  });
}

export async function handleRunEvents(req, res, { owner, runId, url }) {
  const store = codeAgentStore();
  const run = await store.getRun(owner.id, runId);
  if (!run) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  const headerAfter = Number(req.headers["last-event-id"] || 0);
  const after = Math.max(Number(url.searchParams.get("after") || headerAfter || 0), 0);
  const existing = await store.listEvents(owner.id, runId, after);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  for (const event of existing || []) writeEvent(res, event);
  if (TERMINAL_RUN_STATES.has(run.state) || run.state === "waiting_for_approval") return res.end();

  const unsubscribe = store.subscribe(runId, (event) => {
    writeEvent(res, event);
    if (event.type === "run.waiting_for_approval"
      || (event.type.startsWith("run.") && /(?:succeeded|failed|cancelled|interrupted)$/.test(event.type))) {
      unsubscribe();
      res.end();
    }
  });
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref?.();
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
}

function writeEvent(res, event) {
  res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function publicArtifact(row) {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    name: row.name,
    url: row.url,
    content: row.content,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes || 0),
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}
