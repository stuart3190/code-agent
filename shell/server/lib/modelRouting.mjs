import { aiRoutingStore } from "./aiRoutingStore.mjs";
import { anthropicConfigured, createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { optionalEnv } from "./env.mjs";
import { createGeminiCodingProvider, geminiConfigured } from "./geminiCodingProvider.mjs";
import { resolveModelSelection } from "./modelGateway.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";

export const ROUTING_MODES = Object.freeze(["balanced", "quality", "fast", "economy", "manual"]);

export function modelCatalog() {
  return [
    model("openai", "quality", optionalEnv("OPENAI_QUALITY_MODEL", optionalEnv("OPENAI_MODEL", "gpt-5.6-sol")), openAIConfigured()),
    model("openai", "balanced", optionalEnv("OPENAI_BALANCED_MODEL", "gpt-5.6-terra"), openAIConfigured()),
    model("openai", "fast", optionalEnv("OPENAI_FAST_MODEL", "gpt-5.6-luna"), openAIConfigured()),
    model("anthropic", "quality", optionalEnv("ANTHROPIC_QUALITY_MODEL", "claude-opus-5"), anthropicConfigured()),
    model("anthropic", "balanced", optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-5"), anthropicConfigured()),
    model("anthropic", "fast", optionalEnv("ANTHROPIC_FAST_MODEL", "claude-haiku-4-5"), anthropicConfigured()),
    model("gemini", "quality", optionalEnv("GEMINI_QUALITY_MODEL", optionalEnv("GEMINI_MODEL", "gemini-3.6-flash")), geminiConfigured()),
    model("gemini", "balanced", optionalEnv("GEMINI_MODEL", "gemini-3.6-flash"), geminiConfigured()),
    model("gemini", "fast", optionalEnv("GEMINI_FAST_MODEL", "gemini-3.5-flash-lite"), geminiConfigured()),
  ];
}

export async function createRoutedCodingModel({
  owner,
  run = null,
  credential,
  requested = "auto",
  policy = {},
  store = aiRoutingStore(),
  providerFactory = createProviderForCandidate,
} = {}) {
  const health = owner ? await store.listRecentAttempts(owner, 200) : [];
  const candidates = routeCandidates({ credential, requested, policy, prompt: run?.prompt, health });
  if (!candidates.length) {
    const error = new Error("No configured AI model is available for this routing policy.");
    error.code = "model_provider_unavailable";
    throw error;
  }

  let activeIndex = 0;
  const providers = new Map();
  const routed = {
    id: candidates[0].provider,
    model: candidates[0].model,
    candidates,
    async turn(args) {
      const firstIndex = activeIndex;
      let lastError;
      for (let index = firstIndex; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const started = Date.now();
        try {
          let provider = providers.get(candidate.key);
          if (!provider) {
            provider = providerFactory(candidate, credential);
            providers.set(candidate.key, provider);
          }
          const response = await provider.turn(args);
          const latencyMs = Date.now() - started;
          await recordAttempt(store, owner, run, candidate, index + 1, {
            status: "success",
            latency_ms: latencyMs,
            input_tokens: response.usage?.inputTokens || 0,
            output_tokens: response.usage?.outputTokens || 0,
            total_tokens: response.usage?.totalTokens || 0,
            error_code: null,
            retryable: false,
          });
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
          const retryable = isRetryableProviderError(error);
          await recordAttempt(store, owner, run, candidate, index + 1, {
            status: "error",
            latency_ms: Date.now() - started,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            error_code: String(error.code || `http_${error.status || "unknown"}`).slice(0, 120),
            retryable,
          });
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
  if (requested !== "auto") {
    const selection = resolveModelSelection(requested);
    if (credential.provider !== "managed" && credential.provider !== selection.provider) {
      return [credentialCandidate(credential, selectionTier(policy, prompt))];
    }
    return [{ ...selection, tier: "manual", key: `${selection.provider}:${selection.model}` }];
  }

  if (policy.routingMode === "manual" && policy.preferredModel) {
    const selection = resolveModelSelection(policy.preferredModel);
    if (credential.provider === "managed" || credential.provider === selection.provider) {
      return [{ ...selection, tier: "manual", key: `${selection.provider}:${selection.model}` }];
    }
  }

  const tier = selectionTier(policy, prompt);
  if (credential.provider !== "managed") return [credentialCandidate(credential, tier)];

  const configured = modelCatalog().filter((entry) => entry.configured);
  const providerOrder = preferredProviderOrder();
  const primary = configured.filter((entry) => entry.tier === tier);
  const balancedFallback = tier === "balanced" ? [] : configured.filter((entry) => entry.tier === "balanced");
  const deduped = uniqueModels([...primary, ...balancedFallback])
    .sort((a, b) => providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider));
  return prioritizeByHealth(deduped, health);
}

export function isRetryableProviderError(error) {
  const status = Number(error?.status || 0);
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  return /(timeout|timed_out|rate.?limit|overload|unavailable|connection|econn|reset|temporar)/i
    .test(`${error?.code || ""} ${error?.message || ""}`);
}

function selectionTier(policy, prompt) {
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
  const entry = modelCatalog().find((item) => item.provider === credential.provider && item.tier === tier)
    || modelCatalog().find((item) => item.provider === credential.provider && item.tier === "balanced");
  return entry || {
    provider: credential.provider,
    model: credential.provider === "gemini" ? "gemini-3.6-flash"
      : credential.provider === "anthropic" ? "claude-sonnet-5" : "gpt-5.6-terra",
    tier,
    key: `${credential.provider}:default`,
  };
}

export function createProviderForCandidate(candidate, credential, options = {}) {
  const apiKey = credential?.provider === candidate.provider ? credential.secret : undefined;
  if (candidate.provider === "anthropic") {
    return createAnthropicCodingProvider({ apiKey, model: candidate.model });
  }
  if (candidate.provider === "gemini") {
    return createGeminiCodingProvider({ apiKey, model: candidate.model, ...options });
  }
  return createOpenAIProvider({ apiKey, model: candidate.model });
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

function preferredProviderOrder() {
  const preferred = optionalEnv("CODE_AGENT_DEFAULT_PROVIDER", "openai").toLowerCase();
  return [preferred, ...["openai", "anthropic", "gemini"].filter((provider) => provider !== preferred)];
}

function uniqueModels(entries) {
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

function model(provider, tier, id, configured) {
  return { provider, tier, model: id, id, configured, key: `${provider}:${id}` };
}
