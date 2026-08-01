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

// `preferProvider` is set only by an automatic provider fallback: the build continues on a
// different connected provider without the owner changing their active connection. Falls
// back to the active credential whenever that provider is not usable.
export async function resolveBuildContext(ownerId, {
  credentialResolver = activeAiCredential,
  preferProvider = null,
} = {}) {
  let credential;
  try {
    credential = await credentialResolver(ownerId);
  } catch {
    credential = { provider: "managed", secret: null };
  }

  if (preferProvider && preferProvider !== credential.provider) {
    if (preferProvider === "managed") {
      credential = { provider: "managed", secret: null };
    } else {
      try {
        const { aiCredentialStore } = await import("../aiCredentialStore.mjs");
        const { decryptSecret } = await import("../secretCrypto.mjs");
        const row = await aiCredentialStore().getCredential(ownerId, preferProvider);
        if (row?.status === "connected" && row.secret_encrypted) {
          credential = { provider: preferProvider, secret: decryptSecret(row.secret_encrypted) };
        }
      } catch { /* unusable alternative — keep the active credential */ }
    }
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

  if (credential.provider === "xai" && credential.secret) {
    const { createXaiEngineProvider, xaiPolicy, xaiEligibleForAgent, xaiReasoningForTask } = await import("../xaiProvider.mjs");
    const policy = xaiPolicy();
    if (policy.enabled && xaiEligibleForAgent("build", policy)) {
      const strong = optionalEnv("XAI_QUALITY_MODEL", "grok-4.5");
      const editModel = optionalEnv("XAI_BALANCED_MODEL", "grok-build-0.1");
      return {
        byok: true,
        providerLabel: "xai",
        strongModel: strong,
        buildProvider: (intent) => createXaiEngineProvider({
          model: intent === "edit" ? editModel : strong,
          apiKey: credential.secret,
          reasoningEffort: xaiReasoningForTask(intent === "edit" ? "component_edit" : "full_build", policy),
        }),
      };
    }
    // Grok connected but admin-disabled for builds — fall through to managed.
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
