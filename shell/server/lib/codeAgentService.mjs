import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import {
  attachDaytonaRunner, createDaytonaRunner, daytonaConfigured, discardDaytonaSandbox,
  publishDaytonaRun,
} from "./daytonaRunner.mjs";
import { evaluatePublishPolicy } from "./publishPolicy.mjs";
import { runCodingAgent } from "./codingAgent.mjs";
import { openAIConfigured } from "./openAIProvider.mjs";
import { anthropicConfigured } from "./anthropicCodingProvider.mjs";
import { geminiConfigured } from "./geminiCodingProvider.mjs";
import { haveSupabaseEnv } from "./supabase.mjs";
import { githubAppConfigured, githubWebhookConfigured } from "./githubApp.mjs";
import {
  activeAiCredential,
  activeAiProviderName,
  aiCredentialStorageConfigured,
  refreshCodexAuth,
} from "./aiCredentialStore.mjs";
import { assertRunWithinBudget } from "./usageBudgets.mjs";
import { planCatalog } from "./subscriptionPlans.mjs";
import { thralloStripeConfigured } from "./subscriptionBilling.mjs";
import { retentionDays } from "./retentionService.mjs";
import { createRoutedCodingModel, modelCatalog } from "./modelRouting.mjs";
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
    models: modelCatalog().map(({ id, provider, tier, configured }) => ({
      id, provider, tier, configured, managed: true,
    })),
    billing: {
      plans: planCatalog().map(({ id, priceApproved }) => ({ id, priceApproved })),
      budgets: true,
      stripeConfigured: thralloStripeConfigured(),
      operationalTelemetry: true,
    },
    execution: {
      approvalPolicies: true,
      autoPublish: true,
      protectedPaths: true,
      resume: daytonaConfigured(),
      artifactStorage: store === "supabase",
      networkPolicies: daytonaConfigured(),
      commandPolicies: true,
      rateLimits: true,
      retentionDays: retentionDays(),
    },
    editor: {
      apiTokens: true,
      vscodeExtension: true,
    },
    github: {
      configured: githubAppConfigured() || !!optionalEnv("GITHUB_AGENT_TOKEN"),
      appConfigured: githubAppConfigured(),
      webhookConfigured: githubWebhookConfigured(),
      pullRequestPublishing: githubAppConfigured() && daytonaConfigured(),
      temporaryTokenConfigured: !!optionalEnv("GITHUB_AGENT_TOKEN"),
      mode: githubAppConfigured() ? "github-app" : "temporary-token",
    },
    ready: controlPlaneConfigured && daytonaConfigured()
      && (openAIConfigured() || anthropicConfigured() || geminiConfigured()),
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
  modelFactory = null,
  repositoryIndexer = indexRepository,
  contextRetriever = retrieveRepositoryContext,
  repositoryMapRetriever = retrieveRepositoryMap,
  budgetGuard = assertRunWithinBudget,
  providerNameResolver = activeAiProviderName,
  attachRunnerFactory = attachDaytonaRunner,
  publisher = publishDaytonaRun,
} = {}) {
  const store = codeAgentStore();
  const emit = (type, payload) => store.appendEvent(run, type, payload);
  let runner = null;
  let preserveRunner = false;
  let billingSource = "unknown";
  let resumedRun = null;
  const executionStarted = Date.now();
  try {
    const repository = await store.getRepository(run.owner, run.repository_id);
    if (!repository) throw withCode(new Error("Repository is no longer available"), "repository_missing");
    const agent = await store.getAgent(run.owner, run.agent_id);
    // A queued run can outlive the allowance that admitted it; re-check before spending.
    const credentialProvider = await providerNameResolver(run.owner).catch(() => "managed");
    const budget = await budgetGuard(run.owner, { credentialProvider, store })
      .catch((error) => { throw withCode(new Error(error.message), "budget_exhausted"); });

    // Codex executes its own tooling inside the sandbox and needs the network; an offline
    // policy is relaxed for Codex runs with an explicit timeline warning.
    let networkPolicy = agent?.network_policy === "offline" ? "offline" : "full";
    if (networkPolicy === "offline" && credentialProvider === "codex") {
      networkPolicy = "full";
      await emit("network.policy_relaxed", {
        message: "Offline network policy does not apply to Codex subscription runs; the sandbox keeps network access.",
      });
    }

    if (run.resumed_from_run_id) {
      const previous = await store.getRun(run.owner, run.resumed_from_run_id);
      if (previous?.sandbox_id && previous.sandbox_state !== "discarded") {
        await emit("run.provisioning", { message: "Reconnecting to the preserved workspace" });
        try {
          runner = await attachRunnerFactory({ run, repository, previous, emit, networkPolicy });
          resumedRun = previous;
          // The sandbox now belongs to this run; the old run can no longer resume it.
          await store.updateRun(previous, { sandbox_state: "discarded" });
        } catch (error) {
          await emit("resume.fallback", {
            code: error.code || "sandbox_expired",
            message: `Preserved workspace unavailable (${error.message}); starting from a clean baseline`,
          });
        }
      }
    }
    if (!runner) {
      await emit("run.provisioning", { message: "Creating an isolated cloud workspace" });
      runner = await runnerFactory({ run, repository, emit, networkPolicy });
    }
    run = await store.updateRun(run, { sandbox_id: runner.id, work_branch: runner.branch, state: "running" });
    await store.createCheckpoint(run, {
      label: resumedRun ? "Resumed workspace" : "Repository baseline",
      git_sha: await runner.headSha(),
      metadata: resumedRun
        ? { branch: runner.branch, resumed_from: resumedRun.id }
        : { branch: run.base_branch },
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

    const executionPrompt = resumedRun ? resumePreamble(resumedRun) + run.prompt : run.prompt;
    const credential = await credentialResolver(run.owner);
    billingSource = credential.provider === "managed" ? "managed"
      : credential.provider === "codex" ? "codex" : "byok";
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
        prompt: augmentPromptWithContext(executionPrompt, context, repositoryMap),
        authJson: credential.secret,
        emit,
        isCancelled,
      });
      if (result.refreshedAuthJson) {
        await credentialRefresher(run.owner, result.refreshedAuthJson, credential.metadata);
        delete result.refreshedAuthJson;
      }
    } else {
      const selectedModel = modelFactory
        ? await modelFactory(credential, run.model)
        : await createRoutedCodingModel({
          owner: run.owner,
          run,
          credential,
          requested: run.model,
          policy: credential.routing,
        });
      result = await agentRunner({
        run,
        runner,
        emit,
        isCancelled,
        provider: selectedModel,
        context,
        repositoryMap,
        prompt: executionPrompt,
        commandPolicy: agent?.command_policy || "standard",
        tokenBudget: billingSource === "managed"
          ? budget.budgets.managedTokens.remaining
          : null,
      });
    }
    if (result.cancelled) {
      run = await store.updateRun(run, {
        state: "cancelled", result, usage: result.usage, sandbox_state: "discarded",
        finished_at: new Date().toISOString(),
      });
      await persistUsage(store, run, result, executionStarted, billingSource);
      await emit("run.cancelled", { message: "Run cancelled" });
      return run;
    }
    await persistRunOutputs(store, run, result);
    await persistUsage(store, run, result, executionStarted, billingSource);
    const durableResult = {
      summary: result.summary,
      status: result.status,
      provider: result.provider,
      model: result.model,
    };
    if (repository.installation_id && String(result.diff || "").trim()) {
      preserveRunner = true;
      const policy = evaluatePublishPolicy(agent, result.status);
      if (policy.action === "auto_publish") {
        run = await store.updateRun(run, { result: durableResult, usage: result.usage });
        await emit("publish.auto_approved", {
          message: "Publishing automatically per this agent's policy",
          publishMode: "auto_publish",
        });
        try {
          const publication = await publisher({ run, repository, emit });
          await store.createCheckpoint(run, {
            label: "Published pull request",
            git_sha: publication.commitSha,
            metadata: { branch: publication.branch, pull_request: publication.pullRequest, auto: true },
          });
          const published = { ...durableResult, publication };
          run = await store.updateRun(run, {
            state: "succeeded", result: published, sandbox_state: "discarded",
            finished_at: new Date().toISOString(),
          });
          await emit("run.succeeded", {
            message: `Pull request #${publication.pullRequest.number} published automatically`,
            result: published,
          });
          return run;
        } catch (error) {
          await emit("publish.failed", {
            code: error.code || "publish_failed",
            error: error.message,
            message: "Automatic publication failed; approve manually to retry",
          });
        }
      }
      durableResult.approval = {
        required: true,
        action: "create_pull_request",
        branch: run.work_branch,
        ...(policy.reason === "protected_path" ? { reason: "protected_path", protectedTouched: policy.protectedTouched.slice(0, 20) } : {}),
      };
      run = await store.updateRun(run, {
        state: "waiting_for_approval", result: durableResult, usage: result.usage,
      });
      await emit("run.waiting_for_approval", {
        message: policy.reason === "protected_path"
          ? `Protected files changed (${policy.protectedTouched.slice(0, 3).join(", ")}); approval is required.`
          : "Changes are ready. Approve to commit, push, and open a pull request.",
        action: durableResult.approval,
      });
      return run;
    }
    run = await store.updateRun(run, {
      state: "succeeded", result: durableResult, usage: result.usage, sandbox_state: "discarded",
      finished_at: new Date().toISOString(),
    });
    await emit("run.succeeded", { message: "Run completed", result: durableResult, artifacts: 3 });
    return run;
  } catch (error) {
    if (error.usage) {
      await persistUsage(store, run, { usage: error.usage }, executionStarted, billingSource)
        .catch((usageError) => console.error("[code-agent] usage persistence:", usageError));
    }
    // Keep the workspace so the owner can resume instead of restarting from a clean clone.
    // Daytona's auto-stop/archive/delete limits cap the cost of preserved sandboxes.
    const preservable = !!runner;
    run = await store.updateRun(run, {
      state: "failed", error_code: error.code || "run_failed", error: error.message,
      sandbox_state: preservable ? "preserved" : null,
      finished_at: new Date().toISOString(),
    });
    await emit("run.failed", { code: error.code || "run_failed", error: error.message });
    if (preservable) {
      preserveRunner = true;
      await runner.stop?.();
      await emit("run.resumable", {
        message: "The workspace is preserved. Resume this run to continue from where it stopped.",
      });
    }
    return run;
  } finally {
    if (!preserveRunner) await runner?.dispose?.();
  }
}

function resumePreamble(previous) {
  const error = previous.error ? ` It stopped with: ${previous.error}` : "";
  const summary = previous.result?.summary ? `\nPrevious progress summary: ${String(previous.result.summary).slice(0, 2_000)}` : "";
  return `You are resuming an earlier run in the same workspace.${error}${summary}\n`
    + "Your earlier uncommitted changes are still present — inspect git status and git diff before continuing, "
    + "verify what was already done, and complete the task below.\n\nTask:\n";
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
      sandbox_state: "discarded",
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

async function persistUsage(store, run, result, executionStarted, billingSource = "unknown") {
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
    billing_source: billingSource,
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
