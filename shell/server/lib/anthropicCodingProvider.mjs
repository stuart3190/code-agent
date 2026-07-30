import { createAnthropicProvider } from "../../../src/providers/anthropicProvider.mjs";
import { optionalEnv } from "./env.mjs";

export function anthropicConfigured() {
  return !!optionalEnv("ANTHROPIC_API_KEY");
}
export function createAnthropicCodingProvider({
  apiKey = optionalEnv("ANTHROPIC_API_KEY"),
  model = optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-5"),
} = {}) {
  if (!apiKey) {
    const error = new Error("Anthropic is not connected. Set ANTHROPIC_API_KEY on the server.");
    error.code = "anthropic_setup_required";
    throw error;
  }
  const provider = createAnthropicProvider({ apiKey, model, cache: true });
  return {
    id: "anthropic",
    model,
    async turn({ instructions, input, tools }) {
      const result = await provider.runTurn({
        systemPrompt: instructions,
        messages: toNeutralMessages(input),
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      });
      const output = [];
      if (result.text) {
        output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: result.text }] });
      }
      for (const call of result.toolCalls || []) {
        output.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.rawArguments || JSON.stringify(call.arguments || {}),
        });
      }
      return {
        output,
        text: result.text || "",
        usage: {
          inputTokens: result.usage?.input || 0,
          cachedTokens: result.usage?.cached || 0,
          outputTokens: result.usage?.output || 0,
          reasoningTokens: result.usage?.reasoning || 0,
          totalTokens: result.usage?.total || 0,
        },
      };
    },
  };
}

export function toNeutralMessages(input = []) {
  const out = [];
  for (const item of input) {
    if (item.role === "user") {
      out.push({ role: "user", content: textContent(item.content) });
    } else if (item.type === "message" && item.role === "assistant") {
      out.push({ role: "assistant", content: textContent(item.content) });
    } else if (item.type === "function_call") {
      const previous = out[out.length - 1];
      const call = { id: item.call_id, name: item.name, arguments: item.arguments || "{}" };
      if (previous?.role === "assistant" && previous.toolCalls) previous.toolCalls.push(call);
      else out.push({ role: "assistant", toolCalls: [call] });
    } else if (item.type === "function_call_output") {
      out.push({ role: "tool", toolCallId: item.call_id, output: String(item.output ?? "") });
    }
    // OpenAI reasoning items are provider-specific and intentionally not forwarded to Anthropic.
  }
  return out;
}

function textContent(content) {
  if (typeof content === "string") return content;
  return (content || []).map((part) => part.text || part.content || "").join("");
}
