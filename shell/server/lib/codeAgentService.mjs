import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import {
  createDaytonaRunner, daytonaConfigured, discardDaytonaSandbox, publishDaytonaRun,
} from "./daytonaRunner.mjs";
import { runCodingAgent } from "./codingAgent.mjs";
import { openAIConfigured } from "./openAIProvider.mjs";
import { anthropicConfigured } from "./anthropicCodingProvider.mjs";
import { haveSupabaseEnv } from "./supabase.mjs";
import { githubAppConfigured, githubWebhookConfigured } from "./githubApp.mjs";
import {
  activeAiCredential,
  aiCredentialStorageConfigured,
  refreshCodexAuth,
} from "./aiCredentialStore.mjs";
import { createCodingModelForCredential } from "./modelGateway.mjs";
import { embeddingsConfigured, embeddingModel } from "./embeddingProvider.mjs";
import {
  augmentPromptWithContext,
  indexRepository,
  retrieveRepositoryContext,
  retrieveRepositoryMap,
} from "./repositoryIndexer.mjs";

let timer = null;
let working = false;

export function codeAgentCapabilities() {
  const store = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase();
  const controlPlaneConfigured = store === "memory" || haveSupabaseEnv();
  return {
    product: "Thrallo",
    apiVersion: "v1",
    store,
    controlPlane: { configured: controlPlaneConfigured, durable: store === "supabase" },
    runner: { id: "daytona", configured: daytonaConfigured() },
    authentication: {
      encryptedCredentialStorage: aiCredentialStorageConfigured(),
      codexDeviceLogin: aiCredentialStorageConfigured(),
      byok: aiCredentialStorageConfigured(),
    },
    indexing: {
      encrypted: aiCredentialStorageConfigured(),
      exactCodeSearch: aiCredentialStorageConfigured(),
      semanticSearch: aiCredentialStorageConfigured() && embeddingsConfigured(),
      symbolGraph: aiCredentialStorageConfigured(),
      definitionReferences: aiCredentialStorageConfigured(),
      automaticRefresh: githubWebhookConfigured() && daytonaConfigured(),
      manualRefresh: daytonaConfigured(),
      embeddingModel: embeddingsConfigured() ? embeddingModel() : null,
    },
    models: [
      { id: optionalEnv("OPENAI_MODEL", "gpt-5.6-sol"), provider: "openai", configured: openAIConfigured(), managed: true },
      { id: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6"), provider: "anthropic", configured: anthropicConfigured(), managed: true },
    ],
    github: {
      configured: githubAppConfigured() || !!optionalEnv("GITHUB_AGENT_TOKEN"),
      appConfigured: githubAppConfigured(),
      webhookConfigured: githubWebhookConfigured(),
      pullRequestPublishing: githubAppConfigured() && daytonaConfigured(),
      temporaryTokenConfigured: !!optionalEnv("GITHUB_AGENT_TOKEN"),
      mode: githubAppConfigured() ? "github-app" : "temporary-token",
    },
    ready: controlPlaneConfigured && daytonaConfigured() && (openAIConfigured() || anthropicConfigured()),
  };
}

export function startCodeAgentWorker() {
  if (timer || optionalEnv("CODE_AGENT_WORKER", "on").toLowerCase() === "off") return;
  const interval = Math.max(Number(optionalEnv("CODE_AGENT_POLL_MS", "1500")), 250);
  timer = setInterval(() => poll().catch((error) => console.error("[code-agent] worker:", error)), interval);
  timer.unref?.();
  recoverStaleRuns()
    .then(() => poll())
    .catch((error) => console.error("[code-agent] initial recovery:", error));
}

export async function recoverStaleRuns() {
  const staleMinutes = Math.max(Number(optionalEnv("CODE_AGENT_STALE_RUN_MINUTES", "15")), 1);
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  return codeAgentStore().interruptStaleRuns(staleBefore);
}

export function stopCodeAgentWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function poll() {
  if (working) return;
  working = true;
  try {
    const [run] = await codeAgentStore().claimRuns(1);
    if (run) await processRun(run);
  } finally {
    working = false;
  }
}

export async function processRun(run, {
  runnerFactory = createDaytonaRunner,
  agentRunner = runCodingAgent,
  credentialResolver = activeAiCredential,
  credentialRefresher = refreshCodexAuth,
  modelFactory = createCodingModelForCredential,
  repositoryIndexer = indexRepository,
  contextRetriever = retrieveRepositoryContext,
  repositoryMapRetriever = retrieveRepositoryMap,
} = {}) {
  const store = codeAgentStore();
  const emit = (type, payload) => store.appendEvent(run, type, payload);
  let runner = null;
  let preserveRunner = false;
  const executionStarted = Date.now();
  try {
    const repository = await store.getRepository(run.owner, run.repository_id);
    if (!repository) throw withCode(new Error("Repository is no longer available"), "repository_missing");
    await emit("run.provisioning", { message: "Creating an isolated cloud workspace" });
    runner = await runnerFactory({ run, repository, emit });
    run = await store.updateRun(run, { sandbox_id: runner.id, work_branch: runner.branch, state: "running" });
    await store.createCheckpoint(run, {
      label: "Repository baseline",
      git_sha: await runner.headSha(),
      metadata: { branch: run.base_branch },
    });
    run = await store.updateRun(run, { state: "indexing" });
    await emit("run.indexing", { branch: runner.branch, message: "Preparing repository context" });
    let context = [];
    let repositoryMap = [];
    try {
      await repositoryIndexer({
        owner: run.owner,
        repository,
        runner,
        emit,
      });
      context = await contextRetriever(run.owner, repository.id, run.prompt);
      repositoryMap = await repositoryMapRetriever(run.owner, repository.id, run.prompt);
      await emit("context.ready", {
        message: context.length || repositoryMap.length
          ? `Loaded ${context.length} code excerpts and ${repositoryMap.length} symbol matches`
          : "Repository index is ready; no preloaded context matched",
        matches: context.length,
        symbolMatches: repositoryMap.length,
      });
    } catch (error) {
      await emit("context.unavailable", {
        message: `Continuing with live repository tools: ${error.message}`,
        code: error.code || "context_unavailable",
      });
    }
    run = await store.updateRun(run, { state: "running" });
    await emit("run.running", { branch: runner.branch, message: "Agent is working" });

    const credential = await credentialResolver(run.owner);
    await emit("model.selected", {
      provider: credential.provider,
      message: credential.provider === "codex"
        ? "Using your Codex subscription"
        : `Using ${credential.provider === "managed" ? "Thrallo managed AI" : `your ${credential.provider} key`}`,
    });
    const isCancelled = () => store.isCancellationRequested(run.id);
    let result;
    if (credential.provider === "codex") {
      result = await runner.runCodex({
        prompt: augmentPromptWithContext(run.prompt, context, repositoryMap),
        authJson: credential.secret,
        emit,
        isCancelled,
      });
      if (result.refreshedAuthJson) {
        await credentialRefresher(run.owner, result.refreshedAuthJson, credential.metadata);
        delete result.refreshedAuthJson;
      }
    } else {
      result = await agentRunner({
        run,
        runner,
        emit,
        isCancelled,
        provider: modelFactory(credential, run.model),
        context,
        repositoryMap,
      });
    }
    if (result.cancelled) {
      run = await store.updateRun(run, { state: "cancelled", result, usage: result.usage, finished_at: new Date().toISOString() });
      await persistUsage(store, run, result, executionStarted);
      await emit("run.cancelled", { message: "Run cancelled" });
      return run;
    }
    await persistRunOutputs(store, run, result);
    await persistUsage(store, run, result, executionStarted);
    const durableResult = {
      summary: result.summary,
      status: result.status,
      provider: result.provider,
      model: result.model,
    };
    if (repository.installation_id && String(result.diff || "").trim()) {
      preserveRunner = true;
      durableResult.approval = {
        required: true,
        action: "create_pull_request",
        branch: run.work_branch,
      };
      run = await store.updateRun(run, {
        state: "waiting_for_approval", result: durableResult, usage: result.usage,
      });
      await emit("run.waiting_for_approval", {
        message: "Changes are ready. Approve to commit, push, and open a pull request.",
        action: durableResult.approval,
      });
      return run;
    }
    run = await store.updateRun(run, {
      state: "succeeded", result: durableResult, usage: result.usage, finished_at: new Date().toISOString(),
    });
    await emit("run.succeeded", { message: "Run completed", result: durableResult, artifacts: 3 });
    return run;
  } catch (error) {
    run = await store.updateRun(run, {
      state: "failed", error_code: error.code || "run_failed", error: error.message,
      finished_at: new Date().toISOString(),
    });
    await emit("run.failed", { code: error.code || "run_failed", error: error.message });
    return run;
  } finally {
    if (!preserveRunner) await runner?.dispose?.();
  }
}

export async function approveRunPublication(owner, runId, input = {}, {
  publisher = publishDaytonaRun,
} = {}) {
  const store = codeAgentStore();
  let run = await store.getRun(owner, runId);
  if (!run) throw serviceError("Run not found", "run_not_found", 404);
  if (run.state !== "waiting_for_approval") {
    throw serviceError("Run is not waiting for publication approval", "run_not_waiting_for_approval", 409);
  }
  const repository = await store.getRepository(owner, run.repository_id);
  if (!repository?.installation_id) {
    throw serviceError("A GitHub App repository is required to publish this run", "github_installation_required", 409);
  }
  const emit = (type, payload) => store.appendEvent(run, type, payload);
  run = await store.updateRun(run, { state: "running", error_code: null, error: null });
  await emit("publish.approved", { message: "Pull-request publication approved" });
  try {
    const publication = await publisher({
      run,
      repository,
      title: String(input.title || "").trim() || undefined,
      body: String(input.body || "").trim() || undefined,
      emit,
    });
    await store.createCheckpoint(run, {
      label: "Published pull request",
      git_sha: publication.commitSha,
      metadata: { branch: publication.branch, pull_request: publication.pullRequest },
    });
    const result = { ...(run.result || {}), publication };
    run = await store.updateRun(run, {
      state: "succeeded",
      result,
      finished_at: new Date().toISOString(),
    });
    await emit("run.succeeded", {
      message: `Pull request #${publication.pullRequest.number} published`,
      result,
    });
    return run;
  } catch (error) {
    run = await store.updateRun(run, {
      state: "waiting_for_approval",
      error_code: error.code || "publish_failed",
      error: error.message,
    });
    await emit("publish.failed", { code: error.code || "publish_failed", error: error.message });
    throw error;
  }
}

export async function discardRunSandbox(run) {
  return discardDaytonaSandbox(run?.sandbox_id);
}

async function persistRunOutputs(store, run, result) {
  const artifacts = [
    { type: "diff", name: "changes.patch", content: result.diff || "", content_type: "text/x-diff" },
    { type: "log", name: "git-status.txt", content: result.status || "", content_type: "text/plain" },
    { type: "report", name: "summary.txt", content: result.summary || "", content_type: "text/plain" },
  ];
  for (const artifact of artifacts) {
    await store.createArtifact(run, {
      ...artifact,
      size_bytes: Buffer.byteLength(artifact.content),
      metadata: { provider: result.provider, model: result.model },
    });
  }
}

async function persistUsage(store, run, result, executionStarted) {
  const usage = result.usage || {};
  await store.recordUsage(run, {
    provider: result.provider || "unknown",
    model: result.model || run.model,
    input_tokens: usage.inputTokens || 0,
    cached_tokens: usage.cachedTokens || 0,
    output_tokens: usage.outputTokens || 0,
    reasoning_tokens: usage.reasoningTokens || 0,
    compute_seconds: (Date.now() - executionStarted) / 1000,
    amount_gbp: 0,
    metadata: { total_tokens: usage.totalTokens || 0 },
  });
}

function withCode(error, code) {
  error.code = code;
  return error;
}

function serviceError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
