import { aiRoutingStore } from "./aiRoutingStore.mjs";
import { anthropicConfigured, createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { createGeminiCodingProvider, geminiConfigured } from "./geminiCodingProvider.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";
import { createCodingModelForCredential } from "./modelGateway.mjs";
import { createXaiProvider, xaiConfigured, xaiPolicy } from "./xaiProvider.mjs";
import {
  MODEL_LANES, canonicalModelIdentity, executableModelCatalogue,
  modelEntriesFor, parseSelection,
} from "./modelCatalogue.mjs";

export const ROUTING_MODES = Object.freeze(["balanced", "quality", "fast", "economy", "manual"]);

export function modelCatalog() {
  const configured = { openai: openAIConfigured(), anthropic: anthropicConfigured(), gemini: geminiConfigured(), xai: xaiConfigured() };
  return executableModelCatalogue()
    .filter((row) => row.provider !== "codex")
    .filter((row) => row.visibility === "public")
    .filter((row) => row.provider !== "xai" || (xaiPolicy().enabled && xaiPolicy().permittedModels.has(row.model)))
    .flatMap((row) => row.tiers.map((tier) => ({
      provider: row.provider, tier, model: row.model, id: row.model,
      configured: Boolean(configured[row.provider]),
      lanes: row.lanes, key: `${row.provider}:${row.model}`,
    })));
}

export async function createRoutedCodingModel({
  owner,
  run = null,
  credential,
  requested = "auto",
  policy = {},
  store = aiRoutingStore(),
  providerFactory = createProviderForCandidate,
  intelligence = undefined, // injectable; undefined = look it up, null = skip
} = {}) {
  const health = owner ? await store.listRecentAttempts(owner, 200) : [];
  let evidence = intelligence;
  if (evidence === undefined && requested === "auto" && credential?.provider === "managed") {
    evidence = await import("./providerIntelligence.mjs")
      .then((m) => m.recommendModel({ task: policy.taskType || null }))
      .catch(() => null);
  }
  const candidates = routeCandidates({
    credential, requested, prompt: run?.prompt, health,
    policy: { ...policy, intelligence: evidence || null },
  });
  if (!candidates.length) {
    const error = new Error("No configured AI model is available for this routing policy.");
    error.code = "model_provider_unavailable";
    throw error;
  }

  let activeIndex = 0;
  const providers = new Map();
  const routed = {
    supportsDispatchAccounting: true,
    id: candidates[0].provider,
    model: candidates[0].model,
    candidates,
    // Why Auto chose this — measured, quotable, and null when evidence is insufficient.
    intelligence: candidates[0].intelligence || null,
    async turn(args) {
      const {
        beforeDispatch = null,
        afterDispatch = null,
        dispatchFailed = null,
        ...providerArgs
      } = args;
      const firstIndex = activeIndex;
      let lastError;
      for (let index = firstIndex; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const started = Date.now();
        let dispatchContext = null;
        let accountingSettled = false;
        let providerCompleted = false;
        try {
          let provider = providers.get(candidate.key);
          if (!provider) {
            provider = providerFactory(candidate, credential, providerOptionsForMode(candidate.provider, policy.mode));
            providers.set(candidate.key, provider);
          }
          dispatchContext = await beforeDispatch?.(candidate, { attemptOrder: index + 1, args: providerArgs });
          const response = await provider.turn(beforeDispatch ? {
            ...providerArgs,
            maxProviderRetries: 0,
            allowParameterRetry: false,
          } : providerArgs);
          providerCompleted = true;
          await afterDispatch?.(dispatchContext, candidate, response);
          accountingSettled = true;
          const latencyMs = Date.now() - started;
          await recordAttempt(store, owner, run, candidate, index + 1, {
            status: "success",
            latency_ms: latencyMs,
            input_tokens: response.usage?.inputTokens || 0,
            output_tokens: response.usage?.outputTokens || 0,
            total_tokens: response.usage?.totalTokens || 0,
            error_code: null,
            retryable: false,
          }).catch((error) => console.error(`[model-routing] success telemetry: ${error.message}`));
          activeIndex = index;
          routed.id = candidate.provider;
          routed.model = candidate.model;
          return {
            ...response,
            provider: candidate.provider,
            model: candidate.model,
            routing: index > firstIndex ? {
              fallbackFrom: candidates[index - 1],
              selected: candidate,
              reason: lastError?.code || "provider_unavailable",
            } : { selected: candidate },
          };
        } catch (error) {
          lastError = error;
          if (providerCompleted && !accountingSettled) {
            throw Object.assign(error, { code: error.code || "billing_settlement_failed" });
          }
          if (dispatchContext && !accountingSettled) {
            try {
              await dispatchFailed?.(dispatchContext, candidate, error);
            } catch (accountingError) {
              throw Object.assign(accountingError, { code: accountingError.code || "billing_settlement_failed" });
            }
          }
          const retryable = isRetryableProviderError(error);
          await recordAttempt(store, owner, run, candidate, index + 1, {
            status: "error",
            latency_ms: Date.now() - started,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            error_code: String(error.code || `http_${error.status || "unknown"}`).slice(0, 120),
            retryable,
          }).catch((telemetryError) => console.error(`[model-routing] failure telemetry: ${telemetryError.message}`));
          const mayFallback = policy.allowFallback !== false && requested === "auto" && retryable;
          if (!mayFallback || index === candidates.length - 1) throw error;
        }
      }
      throw lastError;
    },
  };
  return routed;
}

export function routeCandidates({ credential = { provider: "managed" }, requested = "auto", policy = {}, prompt = "", health = [] }) {
  const lane = laneForCredential(credential);
  if (requested !== "auto") {
    const selection = parseSelection(requested, { defaultLane: lane });
    const identity = canonicalModelIdentity({ ...selection, lane: selection.lane || lane, reasoningProfile: reasoningForMode(policy.mode) });
    const expectedProvider = credential.provider === "managed" ? identity.provider : credential.provider;
    if (identity.lane !== lane || identity.provider !== expectedProvider) {
      throw Object.assign(new Error("The selected model is not executable with the selected provider and billing lane."), {
        code: "model_lane_unavailable", status: 400, retryable: false,
      });
    }
    return [{ ...identity, billingLane: identity.lane, tier: "manual", key: `${identity.provider}:${identity.model}` }];
  }

  if (policy.routingMode === "manual" && policy.preferredModel) {
    return routeCandidates({ credential, requested: policy.preferredModel, policy: { ...policy, routingMode: "balanced" }, prompt, health });
  }

  const tier = selectionTier(policy, prompt);
  if (credential.provider !== "managed") return [credentialCandidate(credential, tier)];

  const configured = modelCatalog().filter((entry) => entry.configured && entry.lanes.includes(MODEL_LANES.managed))
    .map((entry) => withIdentity(entry, MODEL_LANES.managed, policy.mode));
  const providerOrder = preferredProviderOrder();
  const primary = configured.filter((entry) => entry.tier === tier);
  const balancedFallback = tier === "balanced" ? [] : configured.filter((entry) => entry.tier === "balanced");
  const deduped = uniqueModels([...primary, ...balancedFallback])
    .sort((a, b) => providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider));
  const byHealth = prioritizeByHealth(deduped, health);
  // Provider Intelligence: when measured production evidence names a winner that is in
  // this candidate set, promote it to the front. Absent evidence the configured order
  // stands — Auto never guesses (see providerIntelligence.mjs).
  return applyIntelligence(byHealth, policy.intelligence);
}

export function isRetryableProviderError(error) {
  return error?.retrySafe === true;
}

function selectionTier(policy, prompt) {
  // Execution mode (Provider→Model→Mode selector) steers the tier under Auto: intensity
  // modes want the quality tier, economy modes the fast tier.
  if (["deep", "max_quality"].includes(policy.mode)) return "quality";
  if (["fast", "cheapest"].includes(policy.mode)) return "fast";
  const mode = ROUTING_MODES.includes(policy.routingMode) ? policy.routingMode : "balanced";
  if (mode === "quality") return "quality";
  if (mode === "fast" || mode === "economy") return "fast";
  const value = String(prompt || "").toLowerCase();
  if (/(security|migration|architecture|refactor|race condition|production|database|authentication|investigate|debug)/.test(value)) {
    return "quality";
  }
  if (/(typo|rename|readme|documentation|copy change|small css|quick|simple)/.test(value)) return "fast";
  return "balanced";
}

function credentialCandidate(credential, tier) {
  const lane = laneForCredential(credential);
  const entry = modelEntriesFor({ provider: credential.provider, lane, tier })[0]
    || modelEntriesFor({ provider: credential.provider, lane, tier: "balanced" })[0];
  if (!entry) throw Object.assign(new Error(`No executable ${credential.provider} model is available for ${lane}.`), {
    code: "model_provider_unavailable", status: 400, retryable: false,
  });
  return withIdentity({ ...entry, tier }, lane, credential.routing?.mode);
}

// Execution-mode knobs per provider, resolved through each adapter's own modeMap — no
// provider conditionals leak out of the adapters.
import { openAIProviderMeta } from "./openAIProvider.mjs";
import { anthropicProviderMeta } from "./anthropicCodingProvider.mjs";
import { geminiProviderMeta } from "./geminiCodingProvider.mjs";
import { xaiProviderMeta } from "./xaiProvider.mjs";

export function providerOptionsForMode(providerId, mode) {
  if (!mode) return {};
  const meta = [openAIProviderMeta(), anthropicProviderMeta(), geminiProviderMeta(), xaiProviderMeta()]
    .find((m) => m.id === providerId);
  if (!meta) return {};
  const mapped = meta.modeMap[mode] || meta.modeMap.balanced || {};
  const { tierHint, ...options } = mapped;
  void tierHint; // tier steering happens in selectionTier; only real knobs reach the ctor
  return options;
}

export function createProviderForCandidate(candidate, credential, options = {}) {
  const identity = canonicalModelIdentity({
    provider: candidate.provider, model: candidate.model,
    lane: candidate.billingLane || candidate.lane,
    reasoningProfile: options.reasoningEffort || candidate.reasoningProfile || "default",
  });
  if (identity.lane === MODEL_LANES.byok && (!credential?.secret || credential.provider !== identity.provider)) {
    throw Object.assign(new Error("The selected BYOK model requires that provider's connected credential."), {
      code: "byok_credential_unavailable", status: 400, retryable: false,
    });
  }
  const apiKey = credential?.provider === candidate.provider ? credential.secret : undefined;
  if (candidate.provider === "codex") {
    return createCodingModelForCredential(credential, `${MODEL_LANES.codex}:codex:${candidate.model}`);
  }
  if (candidate.provider === "anthropic") {
    return createAnthropicCodingProvider({ apiKey, model: candidate.model, ...options });
  }
  if (candidate.provider === "gemini") {
    return createGeminiCodingProvider({ apiKey, model: candidate.model, ...options });
  }
  if (candidate.provider === "xai") {
    return createXaiProvider({ apiKey, model: candidate.model, ...options });
  }
  return createOpenAIProvider({ apiKey, model: candidate.model, ...options });
}

async function recordAttempt(store, owner, run, candidate, attemptOrder, result) {
  if (!owner) return;
  await store.recordAttempt(owner, {
    run_id: run?.id || null,
    provider: candidate.provider,
    model: candidate.model,
    route_mode: candidate.tier,
    attempt_order: attemptOrder,
    ...result,
  }).catch(() => {});
}

function prioritizeByHealth(candidates, attempts) {
  const metrics = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.provider}:${attempt.model}`;
    const value = metrics.get(key) || { count: 0, failures: 0, latency: 0 };
    value.count += 1;
    value.failures += attempt.status === "error" ? 1 : 0;
    value.latency += Number(attempt.latency_ms || 0);
    metrics.set(key, value);
  }
  return candidates
    .map((candidate, index) => {
      const value = metrics.get(candidate.key);
      const penalty = value
        ? (value.failures / value.count) * 10_000 + value.latency / value.count
        : 0;
      return { candidate, score: index * 250 + penalty };
    })
    .sort((a, b) => a.score - b.score)
    .map(({ candidate }) => candidate);
}

// Deterministic: the recommendation is a stable promotion of one existing candidate, so
// the same evidence always yields the same order and the decision stays auditable.
export function applyIntelligence(candidates, recommendation) {
  if (!recommendation?.model || !candidates?.length) return candidates;
  const index = candidates.findIndex((c) => c.model === recommendation.model);
  if (index < 0) return candidates; // recommended model isn't configured here — ignore it
  const evidence = {
    explanation: recommendation.explanation,
    confidence: recommendation.confidence,
    samples: recommendation.samples,
  };
  // Attach the evidence even when the model is ALREADY first — Auto must be able to
  // explain a choice it would have made anyway, not only one it changed.
  const chosen = { ...candidates[index], intelligence: evidence };
  return [chosen, ...candidates.filter((_, i) => i !== index)];
}

function preferredProviderOrder() {
  // Grok is never the platform default: it joins the candidate pool and earns priority
  // through the health/latency scoring, not by assumption.
  const preferred = String(process.env.CODE_AGENT_DEFAULT_PROVIDER || "openai").toLowerCase();
  return [preferred, ...["openai", "anthropic", "gemini", "xai"].filter((provider) => provider !== preferred)];
}

function uniqueModels(entries) {
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

function laneForCredential(credential) {
  if (credential?.provider === "managed") return MODEL_LANES.managed;
  if (credential?.provider === "codex") return MODEL_LANES.codex;
  return MODEL_LANES.byok;
}

function reasoningForMode(mode) {
  return ({ fast: "low", cheapest: "low", balanced: "medium", deep: "high", max_quality: "high" })[mode] || "default";
}

function withIdentity(entry, lane, mode = null) {
  const identity = canonicalModelIdentity({ provider: entry.provider, model: entry.model, lane, reasoningProfile: reasoningForMode(mode) });
  return { ...entry, ...identity, billingLane: lane, key: `${entry.provider}:${entry.model}` };
}
