import { optionalEnv } from "./env.mjs";

const endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";

export function geminiConfigured() {
  return !!optionalEnv("GEMINI_API_KEY");
}

export function createGeminiCodingProvider({
  apiKey = optionalEnv("GEMINI_API_KEY"),
  model = optionalEnv("GEMINI_MODEL", "gemini-3.6-flash"),
  fetchImpl = fetch,
  maxOutputTokens = null,
} = {}) {
  if (!apiKey) {
    const error = new Error("Gemini is not connected. Set GEMINI_API_KEY on the server.");
    error.code = "gemini_setup_required";
    throw error;
  }

  return {
    id: "gemini",
    model,
    async turn({ instructions, input, tools = [] }) {
      const body = {
        model,
        input: toGeminiInput(input),
        system_instruction: instructions,
        tools: toGeminiTools(tools),
        store: false,
      };
      if (!body.tools.length) delete body.tools;
      if (maxOutputTokens) body.generation_config = { max_output_tokens: maxOutputTokens };

      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(300_000),
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.status === "failed") {
        const error = new Error(
          payload?.error?.message || payload?.message || `Gemini request failed (${response.status})`,
        );
        error.code = payload?.error?.code || payload?.code || "gemini_request_failed";
        error.status = response.status;
        throw error;
      }

      const output = normalizeGeminiSteps(payload.steps || []);
      return {
        id: payload.id,
        output,
        text: outputText(output),
        usage: normalizeGeminiUsage(payload.usage),
        raw: payload,
      };
    },
  };
}

export function toGeminiTools(tools = []) {
  return tools.map(({ name, description, parameters }) => ({
    type: "function",
    name,
    description,
    parameters,
  }));
}

export function toGeminiInput(input = []) {
  const callNames = new Map(
    input
      .filter((item) => item?.type === "function_call")
      .map((item) => [item.call_id, item.name]),
  );
  const steps = [];
  for (const item of input) {
    const raw = item?.provider_metadata?.gemini_step;
    if (raw) {
      steps.push(raw);
    } else if (item?.role === "user") {
      steps.push({ type: "user_input", content: [{ type: "text", text: textContent(item.content) }] });
    } else if (item?.type === "message" && item.role === "assistant") {
      steps.push({ type: "model_output", content: [{ type: "text", text: textContent(item.content) }] });
    } else if (item?.type === "function_call") {
      steps.push({
        type: "function_call",
        id: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      });
    } else if (item?.type === "function_call_output") {
      steps.push({
        type: "function_result",
        name: callNames.get(item.call_id),
        call_id: item.call_id,
        result: [{ type: "text", text: String(item.output ?? "") }],
      });
    }
  }
  return steps;
}

export function normalizeGeminiSteps(steps = []) {
  const output = [];
  for (const step of steps) {
    if (step.type === "model_output") {
      const text = (step.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("");
      if (text) {
        output.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
          provider_metadata: { gemini_step: step },
        });
      }
    } else if (step.type === "function_call") {
      output.push({
        type: "function_call",
        call_id: step.id,
        name: step.name,
        arguments: JSON.stringify(step.arguments || {}),
        provider_metadata: { gemini_step: step },
      });
    } else {
      output.push({
        type: "reasoning",
        provider: "gemini",
        provider_metadata: { gemini_step: step },
      });
    }
  }
  return output;
}

function normalizeGeminiUsage(usage = {}) {
  return {
    inputTokens: usage.total_input_tokens || 0,
    cachedTokens: usage.total_cached_tokens || 0,
    outputTokens: usage.total_output_tokens || 0,
    reasoningTokens: usage.total_thought_tokens || 0,
    totalTokens: usage.total_tokens || 0,
  };
}

function outputText(output) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((item) => item.text || "")
    .join("");
}

function textContent(content) {
  if (typeof content === "string") return content;
  return (content || []).map((part) => part.text || part.content || "").join("");
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}
