import { createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { createGeminiCodingProvider } from "./geminiCodingProvider.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";
import { createXaiProvider } from "./xaiProvider.mjs";
import { createCodexProvider } from "../../../src/providers/codexProvider.mjs";
import { MODEL_LANES, approvedConfiguredModel, canonicalModelIdentity, parseSelection } from "./modelCatalogue.mjs";

export function createCodingModel(requested = "auto") {
  const selection = resolveModelSelection(requested, { defaultLane: MODEL_LANES.managed });
  canonicalModelIdentity({ ...selection, lane: MODEL_LANES.managed });
  if (!openAIConfigured()) return createOpenAIProvider({ model: selection.model });
  return createOpenAIProvider({ model: selection.model });
}

export function createCodingModelForCredential(credential, requested = "auto") {
  if (!credential || credential.provider === "managed") return createCodingModel(requested);
  const lane = credential.provider === "codex" ? MODEL_LANES.codex : MODEL_LANES.byok;
  const selection = resolveModelSelection(requested, { defaultLane: lane, defaultProvider: credential.provider });
  const identity = canonicalModelIdentity({ ...selection, lane });
  if (identity.provider !== credential.provider) throw modelLaneError(credential.provider, identity.provider);
  if (credential.provider !== "codex" && !credential.secret) {
    throw Object.assign(new Error(`The selected ${credential.provider} model requires that provider's credential.`), { code: "byok_credential_unavailable", status: 400 });
  }
  if (credential.provider === "anthropic") {
    return createAnthropicCodingProvider({ apiKey: credential.secret, model: identity.model });
  }
  if (credential.provider === "gemini") {
    return createGeminiCodingProvider({ apiKey: credential.secret, model: identity.model });
  }
  if (credential.provider === "openai") {
    return createOpenAIProvider({ apiKey: credential.secret, model: identity.model });
  }
  if (credential.provider === "xai") return createXaiProvider({ apiKey: credential.secret, model: identity.model });
  if (credential.provider === "codex") return codexLeadAdapter(createCodexProvider());
  throw new Error(`Unsupported coding model credential: ${credential.provider}`);
}

export function resolveModelSelection(requested = "auto", { defaultLane = MODEL_LANES.managed, defaultProvider = null } = {}) {
  const value = String(requested || "auto").trim();
  if (value === "auto") {
    const provider = defaultProvider || (defaultLane === MODEL_LANES.managed ? "openai" : null);
    if (provider === "anthropic") return { provider, model: approvedConfiguredModel("ANTHROPIC_MODEL", "claude-sonnet-5", { provider }) };
    if (provider === "gemini") return { provider, model: approvedConfiguredModel("GEMINI_MODEL", "gemini-3.6-flash", { provider }) };
    if (provider === "xai") return { provider, model: approvedConfiguredModel("XAI_BALANCED_MODEL", "grok-build-0.1", { provider }) };
    if (provider === "codex") return { provider, model: "gpt-5.5" };
    return { provider: "openai", model: approvedConfiguredModel("OPENAI_MODEL", "gpt-5.6-sol", { provider: "openai" }) };
  }
  const parsed = parseSelection(value, { defaultLane });
  canonicalModelIdentity({ ...parsed, lane: parsed.lane || defaultLane });
  return { provider: parsed.provider, model: parsed.model };
}

function modelLaneError(expected, actual) {
  return Object.assign(new Error(`The selected ${actual} model cannot execute with the active ${expected} credential.`), {
    code: "model_lane_unavailable", status: 400, retryable: false,
  });
}

export function toCodexLeadMessages(input = []) {
  return input.flatMap((item) => {
    if (item?.type === "function_call") {
      return [{ role: "assistant", toolCalls: [{
        id: item.call_id, name: item.name, arguments: item.arguments || "{}",
      }] }];
    }
    if (item?.type === "function_call_output") {
      return [{ role: "tool", toolCallId: item.call_id, name: item.name || null, output: String(item.output || "") }];
    }
    if (item?.role === "user") {
      return [{ role: "user", content: typeof item.content === "string"
        ? item.content : (item.content || []).map((part) => part.text || "").join("") }];
    }
    if (item?.role === "assistant") return [{ role: "assistant", content: String(item.content || "") }];
    return [];
  });
}

// Exported so the adapter is provable with an injected provider (no ChatGPT login on the box).
export function codexLeadAdapter(provider) {
  return {
    id: "codex", model: provider.model,
    async turn({ instructions, input = [], tools = [], maxOutputTokens = null }) {
      const result = await provider.runTurn({
        systemPrompt: instructions,
        messages: toCodexLeadMessages(input),
        tools,
        maxOutputTokens,
      });
      const toolCalls = (result.toolCalls || []).map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.rawArguments || JSON.stringify(call.arguments || {}),
      }));
      const usage = result.usage || {};
      return {
        text: result.text,
        output: toolCalls,
        usage: {
          inputTokens: Number(usage.input || usage.inputTokens || 0),
          cachedTokens: Number(usage.cached || usage.cachedTokens || 0),
          outputTokens: Number(usage.output || usage.outputTokens || 0),
          reasoningTokens: Number(usage.reasoning || usage.reasoningTokens || 0),
          totalTokens: Number(usage.total || usage.totalTokens || 0),
          providerRequestId: usage.providerRequestId || null,
        },
        providerRequestId: usage.providerRequestId || null,
      };
    },
  };
}
