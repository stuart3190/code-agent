import { aiRoutingStore } from "./aiRoutingStore.mjs";
import { anthropicConfigured, createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { optionalEnv } from "./env.mjs";
import { createGeminiCodingProvider, geminiConfigured } from "./geminiCodingProvider.mjs";
import { resolveModelSelection } from "./modelGateway.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";
import { createXaiProvider, xaiConfigured, xaiPolicy, XAI_MODELS } from "./xaiProvider.mjs";

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
    // xAI/Grok: eligible only when configured AND the admin policy enables it; model ids
    // and permission come from the xAI adapter's central catalog + policy.
    ...xaiCatalogEntries(),
  ];
}

function xaiCatalogEntries() {
  const policy = xaiPolicy();
  if (!policy.enabled) return [];
  const configured = xaiConfigured();
  const entries = [
    model("xai", "quality", optionalEnv("XAI_QUALITY_MODEL", "grok-4.5"), configured),
    model("xai", "balanced", optionalEnv("XAI_BALANCED_MODEL", "grok-build-0.1"), configured),
    model("xai", "fast", optionalEnv("XAI_FAST_MODEL", "grok-4.5-fast"), configured),
  ];
  // Admin model allowlist applies to known catalog models; custom env overrides pass through.
  return entries.filter((entry) => !(entry.model in XAI_MODELS) || policy.permittedModels.has(entry.model));
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
    id: candidates[0].provider,
    model: candidates[0].model,
    candidates,
    // Why Auto chose this — measured, quotable, and null when evidence is insufficient.
    intelligence: candidates[0].intelligence || null,
    async turn(args) {
      const firstIndex = activeIndex;
      let lastError;
      for (let index = firstIndex; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const started = Date.now();
        try {
          let provider = providers.get(candidate.key);
          if (!provider) {
            provider = providerFactory(candidate, credential, providerOptionsForMode(candidate.provider, policy.mode));
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
  const byHealth = prioritizeByHealth(deduped, health);
  // Provider Intelligence: when measured production evidence names a winner that is in
  // this candidate set, promote it to the front. Absent evidence the configured order
  // stands — Auto never guesses (see providerIntelligence.mjs).
  return applyIntelligence(byHealth, policy.intelligence);
}

export function isRetryableProviderError(error) {
  const status = Number(error?.status || 0);
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  return /(timeout|timed_out|rate.?limit|overload|unavailable|connection|econn|reset|temporar)/i
    .test(`${error?.code || ""} ${error?.message || ""}`);
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
  const entry = modelCatalog().find((item) => item.provider === credential.provider && item.tier === tier)
    || modelCatalog().find((item) => item.provider === credential.provider && item.tier === "balanced");
  return entry || {
    provider: credential.provider,
    model: credential.provider === "gemini" ? "gemini-3.6-flash"
      : credential.provider === "anthropic" ? "claude-sonnet-5"
        : credential.provider === "xai" ? "grok-4.5" : "gpt-5.6-terra",
    tier,
    key: `${credential.provider}:default`,
  };
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
  const apiKey = credential?.provider === candidate.provider ? credential.secret : undefined;
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
  const preferred = optionalEnv("CODE_AGENT_DEFAULT_PROVIDER", "openai").toLowerCase();
  return [preferred, ...["openai", "anthropic", "gemini", "xai"].filter((provider) => provider !== preferred)];
}

function uniqueModels(entries) {
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

function model(provider, tier, id, configured) {
  return { provider, tier, model: id, id, configured, key: `${provider}:${id}` };
}
