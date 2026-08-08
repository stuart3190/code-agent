import { createGeminiCodingProvider } from "../geminiCodingProvider.mjs";

// Builder-engine seam for the already-supported Gemini Interactions adapter.
export function createGeminiEngineProvider({ apiKey, model, maxOutputTokens = null } = {}) {
  const provider = createGeminiCodingProvider({ apiKey, model, maxOutputTokens });
  return {
    provider: "gemini", providerId: "gemini", model,
    async runTurn({ systemPrompt, messages = [], tools = [], signal = null }) {
      if (signal?.aborted) throw Object.assign(new Error("Gemini request cancelled before dispatch."), {
        code: "provider_cancelled", dispatchState: "before_dispatch", retrySafe: true,
      });
      const input = messages.flatMap((message) => {
        if (message.role === "user") return [{ role: "user", content: message.content }];
        if (message.role === "assistant" && message.toolCalls) return message.toolCalls.map((call) => ({
          type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments,
        }));
        if (message.role === "assistant") return [{ type: "message", role: "assistant", content: message.content }];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.output }];
        return [];
      });
      const result = await provider.turn({ instructions: systemPrompt, input, tools });
      return {
        text: result.text || "",
        toolCalls: (result.output || []).filter((item) => item.type === "function_call").map((item) => ({
          id: item.call_id, name: item.name, rawArguments: item.arguments,
          arguments: parseArguments(item.arguments),
        })),
        usage: {
          input: result.usage?.inputTokens || 0, cached: result.usage?.cachedTokens || 0,
          output: result.usage?.outputTokens || 0, reasoning: result.usage?.reasoningTokens || 0,
          total: result.usage?.totalTokens || 0, providerRequestId: result.id || null,
        },
      };
    },
  };
}

function parseArguments(value) {
  try { return JSON.parse(value || "{}"); } catch { return { __raw: value }; }
}
