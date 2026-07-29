import {
  CodeAgentInputError, parseAgentInput, parseRepositoryInput, parseRunInput,
  publicAgent, publicRepository, publicRun, TERMINAL_RUN_STATES,
} from "../lib/codeAgentContracts.mjs";
import { codeAgentStore } from "../lib/codeAgentStore.mjs";
import {
  approveRunPublication, codeAgentCapabilities, discardRunSandbox,
} from "../lib/codeAgentService.mjs";

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

export async function handleRunCreate(req, res, { owner, agentId, body }) {
  const store = codeAgentStore();
  const agent = await store.getAgent(owner.id, agentId);
  if (!agent) throw new CodeAgentInputError("Agent not found", 404, "agent_not_found");
  const repository = await store.getRepository(owner.id, agent.repository_id);
  if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
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
  const run = await codeAgentStore().requestCancel(owner.id, runId);
  if (!run) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  if (run.state === "cancelled" && run.sandbox_id) await discardRunSandbox(run);
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
  const run = await store.createRun(owner.id, agent, repository, {
    prompt: previous.prompt,
    mode: previous.mode,
    model: previous.model,
  });
  return sendJson(res, 202, { run: publicRun(run), retriedFrom: previous.id });
}

export async function handleRunArtifacts(_req, res, { owner, runId }) {
  const rows = await codeAgentStore().listArtifacts(owner.id, runId);
  if (!rows) throw new CodeAgentInputError("Run not found", 404, "run_not_found");
  return sendJson(res, 200, { artifacts: rows.map(publicArtifact) });
}

export async function handleUsage(_req, res, owner) {
  const summary = await codeAgentStore().usageSummary(owner.id);
  return sendJson(res, 200, {
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
