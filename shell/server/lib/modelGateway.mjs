import { optionalEnv } from "./env.mjs";
import { anthropicConfigured, createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";

export function createCodingModel(requested = "auto") {
  const selection = resolveModelSelection(requested);
  if (selection.provider === "anthropic") {
    if (!anthropicConfigured()) return createAnthropicCodingProvider();
    return createAnthropicCodingProvider({ model: selection.model });
  }
  if (!openAIConfigured()) return createOpenAIProvider();
  return createOpenAIProvider({ model: selection.model });
}
export function resolveModelSelection(requested = "auto") {
  const value = String(requested || "auto").trim();
  if (value === "auto") {
    const provider = optionalEnv("CODE_AGENT_DEFAULT_PROVIDER", "openai").toLowerCase();
    if (provider === "anthropic") {
      return { provider, model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6") };
    }
    return { provider: "openai", model: optionalEnv("OPENAI_MODEL", "gpt-5.6-sol") };
  }
  if (value.startsWith("anthropic:")) return { provider: "anthropic", model: value.slice("anthropic:".length) };
  if (value.startsWith("openai:")) return { provider: "openai", model: value.slice("openai:".length) };
  if (value.startsWith("claude-")) return { provider: "anthropic", model: value };
  return { provider: "openai", model: value };
}
