import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";

const endpoint = "https://api.openai.com/v1/responses";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function openAIConfigured() {
  return !!optionalEnv("OPENAI_API_KEY");
}

export function createOpenAIProvider({
  apiKey = optionalEnv("OPENAI_API_KEY"),
  model = optionalEnv("OPENAI_MODEL", "gpt-5.6-sol"),
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

  return {
    id: "openai",
    model,
    async turn({ instructions, input, tools, safetyIdentifier }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions,
          input,
          tools,
          reasoning: { effort: reasoningEffort },
          parallel_tool_calls: false,
          store: false,
          truncation: "auto",
          safety_identifier: hashIdentifier(safetyIdentifier),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
        error.code = payload?.error?.code || "openai_request_failed";
        error.status = response.status;
        throw error;
      }
      return {
        id: payload.id,
        output: payload.output || [],
        text: outputText(payload.output || []),
        usage: normalizeUsage(payload.usage),
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
