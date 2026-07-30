import crypto from "node:crypto";
import { activeAiCredential } from "./aiCredentialStore.mjs";
import { aiRoutingStore } from "./aiRoutingStore.mjs";
import { decryptSecret, encryptSecret } from "./secretCrypto.mjs";
import {
  createProviderForCandidate,
  isRetryableProviderError,
  modelCatalog,
  routeCandidates,
} from "./modelRouting.mjs";

const EVALUATION_INSTRUCTIONS = `You are evaluating an AI coding model for Thrallo.
Answer the user's coding question directly and accurately in at most 200 words.
Do not use tools. State any important assumption.`;

export async function runModelEvaluation(owner, input = {}, {
  credentialResolver = activeAiCredential,
  store = aiRoutingStore(),
  providerFactory = createProviderForCandidate,
} = {}) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt || prompt.length > 2_000) throw evaluationError("Enter an evaluation prompt of 2,000 characters or fewer.");
  const label = String(input.label || "Provider comparison").trim().slice(0, 120);
  const credential = await credentialResolver(owner);
  if (credential.provider === "codex") {
    throw evaluationError("Provider comparisons use managed AI or an API-key connection. Select one first.", 409);
  }
  const health = await store.listRecentAttempts(owner, 200);
  const candidates = evaluationCandidates({
    credential,
    routingMode: input.routingMode || "balanced",
    prompt,
    health,
  });
  if (!candidates.length) throw evaluationError("No configured provider is available.", 503);

  const evaluation = await store.createEvaluation(owner, {
    label,
    prompt_encrypted: encryptSecret(prompt),
    prompt_hash: crypto.createHash("sha256").update(prompt).digest("hex"),
    requested_models: candidates.map(({ provider, model }) => ({ provider, model })),
    status: "running",
  });

  let successes = 0;
  for (const candidate of candidates) {
    const started = Date.now();
    try {
      const provider = providerFactory(candidate, credential, { maxOutputTokens: 1_000 });
      const response = await provider.turn({
        instructions: EVALUATION_INSTRUCTIONS,
        input: [{ role: "user", content: prompt }],
        tools: [],
        safetyIdentifier: owner,
      });
      const latencyMs = Date.now() - started;
      const output = String(response.text || "").trim();
      successes += output ? 1 : 0;
      await store.addEvaluationResult(owner, {
        evaluation_id: evaluation.id,
        provider: candidate.provider,
        model: candidate.model,
        status: output ? "success" : "error",
        latency_ms: latencyMs,
        input_tokens: response.usage?.inputTokens || 0,
        output_tokens: response.usage?.outputTokens || 0,
        total_tokens: response.usage?.totalTokens || 0,
        output_encrypted: output ? encryptSecret(output) : null,
        error_code: output ? null : "empty_response",
        error: output ? null : "The model returned no text.",
      });
      await store.recordAttempt(owner, {
        run_id: null,
        provider: candidate.provider,
        model: candidate.model,
        route_mode: "evaluation",
        attempt_order: 1,
        status: output ? "success" : "error",
        latency_ms: latencyMs,
        input_tokens: response.usage?.inputTokens || 0,
        output_tokens: response.usage?.outputTokens || 0,
        total_tokens: response.usage?.totalTokens || 0,
        error_code: output ? null : "empty_response",
        retryable: false,
      });
    } catch (error) {
      await store.addEvaluationResult(owner, {
        evaluation_id: evaluation.id,
        provider: candidate.provider,
        model: candidate.model,
        status: "error",
        latency_ms: Date.now() - started,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        output_encrypted: null,
        error_code: String(error.code || "evaluation_failed").slice(0, 120),
        error: String(error.message || "Evaluation failed").slice(0, 500),
      });
      await store.recordAttempt(owner, {
        run_id: null,
        provider: candidate.provider,
        model: candidate.model,
        route_mode: "evaluation",
        attempt_order: 1,
        status: "error",
        latency_ms: Date.now() - started,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        error_code: String(error.code || "evaluation_failed").slice(0, 120),
        retryable: isRetryableProviderError(error),
      });
    }
  }
  await store.updateEvaluation(owner, evaluation.id, {
    status: successes ? "completed" : "failed",
    completed_at: new Date().toISOString(),
  });
  return modelEvaluationSummary(owner, { store });
}

export function evaluationCandidates({ credential, routingMode, prompt, health }) {
  const requestedTier = routingMode === "quality"
    ? "quality"
    : ["fast", "economy"].includes(routingMode) ? "fast" : "balanced";
  const available = modelCatalog().filter((candidate) => credential.provider === "managed"
    ? candidate.configured
    : candidate.provider === credential.provider);
  const ordered = [
    ...available.filter((candidate) => candidate.tier === requestedTier),
    ...available.filter((candidate) => candidate.tier !== requestedTier),
  ];
  const unique = [...new Map(ordered.map((candidate) => [candidate.key, candidate])).values()];
  if (unique.length) return unique.slice(0, 3);
  return routeCandidates({
    credential,
    requested: "auto",
    policy: { routingMode, allowFallback: false },
    prompt,
    health,
  }).slice(0, 3);
}

export async function modelEvaluationSummary(owner, { store = aiRoutingStore() } = {}) {
  const [evaluations, attempts] = await Promise.all([
    store.listEvaluations(owner, 10),
    store.listRecentAttempts(owner, 200),
  ]);
  const results = await store.listEvaluationResults(owner, evaluations.map((item) => item.id));
  const grouped = new Map();
  for (const result of results) {
    const list = grouped.get(result.evaluation_id) || [];
    list.push(publicResult(result));
    grouped.set(result.evaluation_id, list);
  }
  return {
    health: providerHealth(attempts),
    evaluations: evaluations.map((evaluation) => ({
      id: evaluation.id,
      label: evaluation.label,
      prompt: safeDecrypt(evaluation.prompt_encrypted),
      status: evaluation.status,
      requestedModels: evaluation.requested_models || [],
      results: grouped.get(evaluation.id) || [],
      createdAt: evaluation.created_at,
      completedAt: evaluation.completed_at,
    })),
  };
}

export function providerHealth(attempts = []) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.provider}:${attempt.model}`;
    const group = groups.get(key) || {
      provider: attempt.provider,
      model: attempt.model,
      attempts: 0,
      successes: 0,
      totalLatencyMs: 0,
      lastAttemptAt: attempt.created_at,
    };
    group.attempts += 1;
    group.successes += attempt.status === "success" ? 1 : 0;
    group.totalLatencyMs += Number(attempt.latency_ms || 0);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    provider: group.provider,
    model: group.model,
    attempts: group.attempts,
    successRate: group.attempts ? Math.round((group.successes / group.attempts) * 100) : null,
    averageLatencyMs: group.attempts ? Math.round(group.totalLatencyMs / group.attempts) : null,
    lastAttemptAt: group.lastAttemptAt,
  }));
}

function publicResult(result) {
  return {
    id: result.id,
    provider: result.provider,
    model: result.model,
    status: result.status,
    latencyMs: result.latency_ms,
    inputTokens: result.input_tokens,
    outputTokens: result.output_tokens,
    totalTokens: result.total_tokens,
    output: safeDecrypt(result.output_encrypted),
    errorCode: result.error_code,
    error: result.error,
  };
}

function safeDecrypt(value) {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

function evaluationError(message, status = 400) {
  const error = new Error(message);
  error.code = "invalid_model_evaluation";
  error.status = status;
  return error;
}
