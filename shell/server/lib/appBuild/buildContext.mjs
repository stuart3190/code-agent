// Per-owner build context for the generation pipeline on Thrallo: which engine provider a
// job uses and whether it bills the owner's own key (BYOK) or Thrallo's managed budget.
//
// Managed builds run on Thrallo's OpenAI API key (quality tier for generation/design,
// balanced tier for edits — the same strong/cheap split the legacy router made). An owner
// whose active Thrallo AI connection is an Anthropic or OpenAI BYOK key builds on their own
// account and consumes no managed budget. A Codex-subscription selection falls back to
// managed for builds: the engine's Codex transport is the ChatGPT backend used by Buildr101,
// which Thrallo does not touch.

import { optionalEnv } from "../env.mjs";
import { activeAiCredential } from "../aiCredentialStore.mjs";
import { createOpenAIEngineProvider } from "./openaiEngineProvider.mjs";
import { createRoutingProvider } from "../../../../src/providers/routingProvider.mjs";

function managedModelForIntent(intent) {
  return intent === "edit"
    ? optionalEnv("OPENAI_BALANCED_MODEL", "gpt-5.6-terra")
    : optionalEnv("OPENAI_QUALITY_MODEL", optionalEnv("OPENAI_MODEL", "gpt-5.6-sol"));
}

export async function resolveBuildContext(ownerId, {
  credentialResolver = activeAiCredential,
} = {}) {
  let credential;
  try {
    credential = await credentialResolver(ownerId);
  } catch {
    credential = { provider: "managed", secret: null };
  }

  if (credential.provider === "anthropic" && credential.secret) {
    const strong = optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-5");
    const config = { provider: "anthropic", strong, apiKey: credential.secret };
    return {
      byok: true,
      providerLabel: "anthropic",
      strongModel: strong,
      buildProvider: (intent) => createRoutingProvider({ config, turnMeta: { intent } }),
    };
  }

  if (credential.provider === "openai" && credential.secret) {
    return {
      byok: true,
      providerLabel: "openai",
      strongModel: managedModelForIntent("generate"),
      buildProvider: (intent) =>
        createOpenAIEngineProvider({ model: managedModelForIntent(intent), apiKey: credential.secret }),
    };
  }

  return {
    byok: false,
    providerLabel: "openai-managed",
    strongModel: managedModelForIntent("generate"),
    buildProvider: (intent) => createOpenAIEngineProvider({ model: managedModelForIntent(intent) }),
  };
}
