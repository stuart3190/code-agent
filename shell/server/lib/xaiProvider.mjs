// xAI / Grok — first-class provider adapter. ALL Grok-specific logic lives here:
// both platform seams (the Lead Agent's `turn` contract and the build engine's `runTurn`
// contract), the model catalog with pricing metadata (including long-context tiers),
// account model discovery, exact cost calculation, admin policy, task-based reasoning
// effort, retries, timeouts, cancellation, and error normalization. Nothing outside this
// module branches on "grok".
//
// Transport: xAI's OpenAI-compatible Responses API (api.x.ai/v1/responses) — the same
// wire shapes the existing OpenAI adapters use, so tool calling and structured outputs
// work identically. The key comes from the owner's encrypted BYOK credential or the
// XAI_API_KEY env; it is never logged, never returned to a browser, and never enters a
// generated application.

import { optionalEnv } from "./env.mjs";

const XAI_BASE = () => optionalEnv("XAI_BASE_URL", "https://api.x.ai/v1");

// ── Model catalog: metadata + centrally managed pricing (USD per MTok) ──────────────────
// Long-context pricing: requests whose input exceeds longContextThreshold bill at the
// long rates for the whole request (xAI's published scheme). Update prices HERE only.

export const XAI_MODELS = {
  "grok-4.5": {
    label: "Grok 4.5", tier: "quality",
    contextLimit: 262_144, longContextThreshold: 128_000,
    usdPerMInput: 3.0, usdPerMCachedInput: 0.75, usdPerMOutput: 15.0,
    usdPerMInputLong: 6.0, usdPerMOutputLong: 30.0,
    reasoning: true, tools: true, structuredOutputs: true,
    rateLimit: { rpm: 480, tpm: 2_000_000 },
  },
  // Verified against a live account 2026-08-02: grok-4.3 exists, grok-4.5-fast does NOT
  // (it was an assumed name and is gone). Capability flags below are probed truths, not
  // guesses — and the adapter self-corrects anyway if an API disagrees.
  "grok-4.3": {
    label: "Grok 4.3", tier: "fast",
    contextLimit: 131_072, longContextThreshold: 128_000,
    usdPerMInput: 0.6, usdPerMCachedInput: 0.15, usdPerMOutput: 2.4,
    usdPerMInputLong: 1.2, usdPerMOutputLong: 4.8,
    reasoning: true, tools: true, structuredOutputs: true,
    rateLimit: { rpm: 600, tpm: 4_000_000 },
  },
  "grok-build-0.1": {
    label: "Grok Build 0.1 (coding preview)", tier: "balanced",
    contextLimit: 262_144, longContextThreshold: 128_000,
    usdPerMInput: 1.2, usdPerMCachedInput: 0.3, usdPerMOutput: 6.0,
    usdPerMInputLong: 2.4, usdPerMOutputLong: 12.0,
    // Probed: this model REJECTS the reasoning parameter (400 invalid-argument).
    reasoning: false, tools: true, structuredOutputs: true,
    rateLimit: { rpm: 300, tpm: 1_000_000 },
    preview: true, // may not be enabled on every account — discovery filters it
  },
};

// Models proven at runtime to reject `reasoning`, so a wrong catalog entry (or a brand
// new model) costs one failed call once, not every call forever.
const NO_REASONING = new Set();

// Known models honour their probed capability flag. Unknown ones (a brand-new Grok)
// attempt reasoning optimistically — the transport strips it permanently if rejected,
// so a model we've never seen costs at most one corrected call.
function supportsReasoning(model) {
  if (NO_REASONING.has(model)) return false;
  const meta = xaiModelMeta(model);
  return meta ? meta.reasoning !== false : true;
}

export function xaiModelMeta(model) {
  return XAI_MODELS[model] || null;
}

// Provider self-description for the model selector (see openAIProviderMeta).
export const xaiProviderMeta = () => ({
  id: "xai",
  name: "xAI / Grok",
  models: Object.entries(XAI_MODELS)
    .filter(([id]) => xaiPolicy().permittedModels.has(id))
    .map(([id, meta]) => ({ id, tier: meta.tier })),
  supportedModes: ["fast", "balanced", "deep", "cheapest", "max_quality"],
  modeMap: { fast: { reasoningEffort: "low" }, balanced: { reasoningEffort: "medium" }, deep: { reasoningEffort: "high" }, cheapest: { reasoningEffort: "low" }, max_quality: { reasoningEffort: "high" } },
});

export function xaiConfigured() {
  return Boolean(optionalEnv("XAI_API_KEY"));
}

// Exact request cost in USD (and GBP) with long-context pricing applied whenever input
// crosses the model's threshold. Cached input bills at the cached rate in BOTH tiers.
export function xaiCostForUsage({ model, inputTokens = 0, cachedTokens = 0, outputTokens = 0 }) {
  const meta = xaiModelMeta(model);
  if (!meta) return null;
  const long = inputTokens > meta.longContextThreshold;
  const freshInput = Math.max(inputTokens - cachedTokens, 0);
  const usd = (freshInput / 1e6) * (long ? meta.usdPerMInputLong : meta.usdPerMInput)
    + (cachedTokens / 1e6) * meta.usdPerMCachedInput
    + (outputTokens / 1e6) * (long ? meta.usdPerMOutputLong : meta.usdPerMOutput);
  const usdGbp = Number(optionalEnv("USD_GBP_RATE", "0.79"));
  return { usd: Number(usd.toFixed(6)), gbp: Number((usd * usdGbp).toFixed(6)), longContext: long };
}

// ── Admin policy (env-managed; see CONTEXT.md admin section) ────────────────────────────

export const XAI_AGENT_TYPES = ["build", "edit", "repair", "plan", "review", "verify"];

export function xaiPolicy(env = process.env) {
  const enabled = env.THRALLO_XAI_ENABLED !== "0" && env.THRALLO_XAI_ENABLED !== "false";
  const agents = String(env.THRALLO_XAI_AGENTS || XAI_AGENT_TYPES.join(","))
    .split(",").map((s) => s.trim()).filter((s) => XAI_AGENT_TYPES.includes(s));
  const permittedModels = String(env.THRALLO_XAI_MODELS || Object.keys(XAI_MODELS).join(","))
    .split(",").map((s) => s.trim()).filter((s) => s in XAI_MODELS);
  return {
    enabled,
    agents: new Set(agents),
    permittedModels: new Set(permittedModels),
    defaultReasoning: ["low", "medium", "high"].includes(env.THRALLO_XAI_DEFAULT_REASONING)
      ? env.THRALLO_XAI_DEFAULT_REASONING : "low",
    maxContextTokens: Number(env.THRALLO_XAI_MAX_CONTEXT_TOKENS || 120_000),
    longContextApprovalTokens: Number(env.THRALLO_XAI_LONG_CONTEXT_APPROVAL || 128_000),
    perRequestLimitCredits: Number(env.THRALLO_XAI_PER_REQUEST_LIMIT_CREDITS || 0) || null,
    dailyBudgetCredits: Number(env.THRALLO_XAI_DAILY_BUDGET_CREDITS || 0) || null,
    perUserBudgetCredits: Number(env.THRALLO_XAI_PER_USER_BUDGET_CREDITS || 0) || null,
    maxRetries: Math.min(Math.max(Number(env.THRALLO_XAI_MAX_RETRIES || 2), 0), 5),
    allowFallback: env.THRALLO_XAI_ALLOW_FALLBACK !== "0",
  };
}

export function xaiEligibleForAgent(agentType, policy = xaiPolicy()) {
  return policy.enabled && policy.agents.has(agentType);
}

// Cheap tasks never pay for deep reasoning (directive: configurable low/medium/high).
export function xaiReasoningForTask(taskType, policy = xaiPolicy()) {
  if (["simple_edit", "component_edit"].includes(taskType)) return "low";
  if (["bug_repair", "verification_repair", "feature"].includes(taskType)) return "medium";
  if (taskType === "full_build") return policy.defaultReasoning === "low" ? "medium" : policy.defaultReasoning;
  return policy.defaultReasoning;
}

// ── Account model discovery (merge live /models with the catalog) ───────────────────────

export async function discoverXaiModels(apiKey, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${XAI_BASE()}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw normalizeXaiError(await safeJson(response), response.status);
  const payload = await response.json().catch(() => ({ data: [] }));
  const available = new Set((payload.data || []).map((m) => m.id));
  return Object.entries(XAI_MODELS)
    .filter(([id]) => available.size === 0 || available.has(id))
    .map(([id, meta]) => ({ id, ...meta, availableOnAccount: available.has(id) }))
    .concat([...available]
      .filter((id) => !(id in XAI_MODELS) && /^grok/.test(id))
      .map((id) => ({ id, label: id, tier: "balanced", discovered: true, availableOnAccount: true })));
}

// ── Error normalization + retry classification ──────────────────────────────────────────

async function safeJson(response) {
  return response.json().catch(() => ({}));
}

export function normalizeXaiError(payload, status) {
  const message = payload?.error?.message || payload?.error || `xAI request failed (${status})`;
  const error = new Error(String(message).slice(0, 500));
  error.status = status;
  error.code = payload?.error?.code
    || (status === 401 || status === 403 ? "xai_key_rejected"
      : status === 429 ? "xai_rate_limited"
        : status >= 500 ? "xai_unavailable" : "xai_request_failed");
  return error;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// ── Shared transport: one POST to /responses with retries, timeout, cancellation ────────

// A 400 telling us a parameter is unsupported is a CAPABILITY fact, not a failure: drop
// the parameter, remember it for this model, and retry immediately.
function unsupportedParameter(error) {
  return /does not support parameter\s+(\w+)/i.exec(String(error?.message || ""))?.[1] || null;
}

async function xaiResponsesCall({ apiKey, body, fetchImpl, signal, timeoutMs, maxRetries }) {
  let lastError;
  let retries = 0;
  if (body?.model && NO_REASONING.has(body.model)) delete body.reasoning;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error("xAI request cancelled.");
      error.code = "xai_cancelled";
      throw error;
    }
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(`${XAI_BASE()}/responses`, {
        method: "POST",
        signal: composite,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = normalizeXaiError(await safeJson(response), response.status);
        // Self-correcting capability discovery: strip the rejected parameter and retry
        // immediately (this attempt doesn't count against the retry budget).
        const unsupported = unsupportedParameter(error);
        if (unsupported && unsupported in body) {
          if (unsupported === "reasoning" && body.model) NO_REASONING.add(body.model);
          delete body[unsupported];
          attempt -= 1;
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
          lastError = error;
          retries += 1;
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }
        throw error;
      }
      const payload = await response.json();
      return { payload, retries };
    } catch (error) {
      if (error.code === "xai_cancelled" || signal?.aborted) {
        const cancelled = new Error("xAI request cancelled.");
        cancelled.code = "xai_cancelled";
        throw cancelled;
      }
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        const timeoutError = new Error("xAI request timed out.");
        timeoutError.code = "xai_timeout";
        timeoutError.status = 408;
        if (attempt < maxRetries) { lastError = timeoutError; retries += 1; continue; }
        throw timeoutError;
      }
      if (error.status && RETRYABLE_STATUS.has(error.status) && attempt < maxRetries) {
        lastError = error;
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function normalizeUsage(usage = {}, retries = 0) {
  return {
    inputTokens: usage.input_tokens || 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
    retries,
  };
}

function outputText(output) {
  return (output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

// ── Seam 1: the Lead Agent / routed-model contract (`turn`) ─────────────────────────────

export function createXaiProvider({
  apiKey = null, model = "grok-4.5", reasoningEffort = null,
  fetchImpl = fetch, timeoutMs = 300_000, maxRetries = xaiPolicy().maxRetries, signal = null,
} = {}) {
  const key = apiKey || optionalEnv("XAI_API_KEY");
  if (!key) {
    const error = new Error("No xAI API key is configured.");
    error.code = "xai_not_configured";
    throw error;
  }
  const effort = reasoningEffort || xaiPolicy().defaultReasoning;
  return {
    provider: "xai",
    model,
    async turn({ instructions, input, tools, safetyIdentifier }) {
      void safetyIdentifier; // xAI has no safety-identifier field; never forward user ids
      const { payload, retries } = await xaiResponsesCall({
        apiKey: key, fetchImpl, signal, timeoutMs, maxRetries,
        body: {
          model, instructions, input, tools,
          ...(supportsReasoning(model) ? { reasoning: { effort } } : {}),
          parallel_tool_calls: false,
          store: false,
        },
      });
      return {
        id: payload.id,
        output: payload.output || [],
        text: outputText(payload.output || []),
        usage: normalizeUsage(payload.usage, retries),
        raw: payload,
      };
    },
  };
}

// ── Seam 2: the build engine contract (`runTurn`) ───────────────────────────────────────

function toInputItems(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        items.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
    } else if (m.role === "assistant") {
      items.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
    } else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.output });
    }
  }
  return items;
}

export function createXaiEngineProvider({
  model = "grok-build-0.1", apiKey = null, reasoningEffort = null,
  fetchImpl = fetch, timeoutMs = 300_000, signal = null,
} = {}) {
  const key = apiKey || optionalEnv("XAI_API_KEY");
  if (!key) throw new Error("An xAI API key is required for Grok builds.");
  const effort = reasoningEffort || xaiPolicy().defaultReasoning;
  const maxRetries = xaiPolicy().maxRetries;

  async function runTurn({ systemPrompt, messages, tools }) {
    const { payload, retries } = await xaiResponsesCall({
      apiKey: key, fetchImpl, signal, timeoutMs, maxRetries,
      body: {
        model,
        instructions: systemPrompt,
        input: toInputItems(messages),
        tools: tools?.length ? tools.map((t) => ({
          type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false,
        })) : undefined,
        ...(supportsReasoning(model) ? { reasoning: { effort } } : {}),
        parallel_tool_calls: false,
        store: false,
      },
    });
    const toolCalls = (payload.output || [])
      .filter((item) => item.type === "function_call")
      .map((item) => {
        let parsed = {};
        try { parsed = JSON.parse(item.arguments || "{}"); } catch { parsed = {}; }
        return { id: item.call_id, name: item.name, arguments: parsed, rawArguments: item.arguments || "{}" };
      });
    const usage = normalizeUsage(payload.usage, retries);
    return {
      text: outputText(payload.output || []),
      toolCalls,
      usage: {
        input: usage.inputTokens, output: usage.outputTokens,
        reasoning: usage.reasoningTokens, cached: usage.cachedTokens,
        cacheWrite: 0, total: usage.totalTokens, retries,
      },
    };
  }

  return { model, provider: "xai", runTurn };
}
