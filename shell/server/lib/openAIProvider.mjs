import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { approvedConfiguredModel, assertProviderModel } from "./modelCatalogue.mjs";
import { DISPATCH_STATES, providerFailure } from "./providerOutcome.mjs";

// Provider self-description for the model selector: display name, the models this
// deployment offers (synced from env config — new models appear by env change, no UI
// code), and which execution modes the adapter can honor (reasoning effort is native).
export const openAIProviderMeta = () => ({
  id: "openai",
  name: "OpenAI",
  models: [
    { id: approvedConfiguredModel("OPENAI_QUALITY_MODEL", "gpt-5.6-sol", { provider: "openai", tier: "quality" }), tier: "quality" },
    { id: approvedConfiguredModel("OPENAI_BALANCED_MODEL", "gpt-5.6-terra", { provider: "openai", tier: "balanced" }), tier: "balanced" },
    { id: approvedConfiguredModel("OPENAI_FAST_MODEL", "gpt-5.6-luna", { provider: "openai", tier: "fast" }), tier: "fast" },
  ],
  supportedModes: ["fast", "balanced", "deep", "cheapest", "max_quality"],
  modeMap: { fast: { reasoningEffort: "low" }, balanced: { reasoningEffort: "medium" }, deep: { reasoningEffort: "high" }, cheapest: { reasoningEffort: "low" }, max_quality: { reasoningEffort: "high" } },
});

const endpoint = "https://api.openai.com/v1/responses";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function openAIConfigured() {
  return !!optionalEnv("OPENAI_API_KEY");
}

export function createOpenAIProvider({
  apiKey = optionalEnv("OPENAI_API_KEY"),
  model = approvedConfiguredModel("OPENAI_MODEL", "gpt-5.6-sol", { provider: "openai" }),
  reasoningEffort = optionalEnv("OPENAI_REASONING_EFFORT", "medium"),
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    const error = new Error("OpenAI is not connected. Set OPENAI_API_KEY on the server.");
    error.code = "openai_setup_required";
    throw error;
  }
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error("OPENAI_REASONING_EFFORT must be one of none, low, medium, high, xhigh, or max.");
  }
  const executableModel = assertProviderModel({ provider: "openai", model }).model;

  return {
    id: "openai",
    model: executableModel,
    async turn({ instructions, input, tools, safetyIdentifier }) {
      let response;
      try { response = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: executableModel,
          instructions,
          input,
          tools,
          reasoning: { effort: reasoningEffort },
          parallel_tool_calls: false,
          store: false,
          truncation: "auto",
          safety_identifier: hashIdentifier(safetyIdentifier),
        }),
      }); } catch (error) { throw providerFailure(error, { state: DISPATCH_STATES.ambiguous }); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
        error.code = payload?.error?.code || "openai_request_failed";
        error.status = response.status;
        throw providerFailure(error, { state: response.status < 500 ? DISPATCH_STATES.rejected : DISPATCH_STATES.ambiguous,
          retrySafe: [408, 409, 425, 429].includes(response.status) });
      }
      return {
        id: payload.id,
        output: payload.output || [],
        text: outputText(payload.output || []),
        usage: { ...normalizeUsage(payload.usage), providerRequestId: payload.id || response.headers?.get?.("x-request-id") || null },
        raw: payload,
      };
    },
  };
}

function outputText(output) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens || 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || 0,
  };
}

function hashIdentifier(value) {
  return crypto.createHash("sha256").update(String(value || "anonymous")).digest("hex").slice(0, 64);
}
