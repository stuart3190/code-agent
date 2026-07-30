import { optionalEnv } from "./env.mjs";
import { anthropicConfigured, createAnthropicCodingProvider } from "./anthropicCodingProvider.mjs";
import { createGeminiCodingProvider, geminiConfigured } from "./geminiCodingProvider.mjs";
import { createOpenAIProvider, openAIConfigured } from "./openAIProvider.mjs";

export function createCodingModel(requested = "auto") {
  const selection = resolveModelSelection(requested);
  if (selection.provider === "anthropic") {
    if (!anthropicConfigured()) return createAnthropicCodingProvider();
    return createAnthropicCodingProvider({ model: selection.model });
  }
  if (selection.provider === "gemini") {
    if (!geminiConfigured()) return createGeminiCodingProvider();
    return createGeminiCodingProvider({ model: selection.model });
  }
  if (!openAIConfigured()) return createOpenAIProvider();
  return createOpenAIProvider({ model: selection.model });
}

export function createCodingModelForCredential(credential, requested = "auto") {
  if (!credential || credential.provider === "managed") return createCodingModel(requested);
  const selection = resolveModelSelection(requested);
  if (credential.provider === "anthropic") {
    const model = selection.provider === "anthropic"
      ? selection.model
      : optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-5");
    return createAnthropicCodingProvider({ apiKey: credential.secret, model });
  }
  if (credential.provider === "gemini") {
    const model = selection.provider === "gemini"
      ? selection.model
      : optionalEnv("GEMINI_MODEL", "gemini-3.6-flash");
    return createGeminiCodingProvider({ apiKey: credential.secret, model });
  }
  if (credential.provider === "openai") {
    const model = selection.provider === "openai"
      ? selection.model
      : optionalEnv("OPENAI_MODEL", "gpt-5.6-sol");
    return createOpenAIProvider({ apiKey: credential.secret, model });
  }
  throw new Error(`Unsupported coding model credential: ${credential.provider}`);
}

export function resolveModelSelection(requested = "auto") {
  const value = String(requested || "auto").trim();
  if (value === "auto") {
    const provider = optionalEnv("CODE_AGENT_DEFAULT_PROVIDER", "openai").toLowerCase();
    if (provider === "anthropic") {
      return { provider, model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-5") };
    }
    if (provider === "gemini") {
      return { provider, model: optionalEnv("GEMINI_MODEL", "gemini-3.6-flash") };
    }
    return { provider: "openai", model: optionalEnv("OPENAI_MODEL", "gpt-5.6-sol") };
  }
  if (value.startsWith("anthropic:")) return { provider: "anthropic", model: value.slice("anthropic:".length) };
  if (value.startsWith("gemini:")) return { provider: "gemini", model: value.slice("gemini:".length) };
  if (value.startsWith("openai:")) return { provider: "openai", model: value.slice("openai:".length) };
  if (value.startsWith("claude-")) return { provider: "anthropic", model: value };
  if (value.startsWith("gemini-")) return { provider: "gemini", model: value };
  return { provider: "openai", model: value };
}
