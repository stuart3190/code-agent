// Per-owner build context for the generation pipeline on Thrallo: which engine provider a
// job uses and whether it bills the owner's own key (BYOK) or Thrallo's managed budget.
//
// Managed builds run on Thrallo's OpenAI API key (quality tier for generation/design,
// balanced tier for edits — the same strong/cheap split the legacy router made). An owner
// whose active Thrallo AI connection is an Anthropic/OpenAI/xAI key builds on their own
// account, and a Codex connection builds on the ChatGPT-linked allowance via the engine's
// Codex transport. Neither consumes managed budget, and neither silently falls back to it:
// the previous header said Codex "falls back to managed for builds", and that sentence cost
// a Codex-connected owner seven managed gpt-5.6 calls. Every lane carries its provider
// POLICY (providerPolicy.mjs), and a lane change is a policy decision, never a fallback.

import { activeAiCredential, refreshCodexAuth } from "../aiCredentialStore.mjs";
import { createOpenAIEngineProvider } from "./openaiEngineProvider.mjs";
import { createRoutingProvider } from "../../../../src/providers/routingProvider.mjs";
import { resolveProviderPolicy } from "./providerPolicy.mjs";
import { approvedConfiguredModel } from "../modelCatalogue.mjs";
import { createGeminiEngineProvider } from "./geminiEngineProvider.mjs";
import { createStoredAccessTokenProvider } from "../../../../src/providers/auth.mjs";

function managedModelForIntent(intent) {
  if (intent === "fast") return approvedConfiguredModel("OPENAI_FAST_MODEL", "gpt-5.6-luna", { provider: "openai", tier: "fast" });
  return intent === "edit"
    ? approvedConfiguredModel("OPENAI_BALANCED_MODEL", "gpt-5.6-terra", { provider: "openai", tier: "balanced" })
    : approvedConfiguredModel("OPENAI_QUALITY_MODEL", "gpt-5.6-sol", { provider: "openai", tier: "quality" });
}

// `preferProvider` is set only by an automatic provider fallback: the build continues on a
// different connected provider without the owner changing their active connection. Falls
// back to the active credential whenever that provider is not usable.
export async function resolveBuildContext(ownerId, {
  credentialResolver = activeAiCredential,
  preferProvider = null,
} = {}) {
  // A credential lookup failure is not evidence that the owner selected managed billing. Falling
  // back here silently changes both provider and payer, so resolution fails closed without a call.
  let credential = await credentialResolver(ownerId);

  if (preferProvider && preferProvider !== credential.provider) {
    // A fallback may not widen the billing lane. Switching TO managed is a billing decision made
    // by the policy at selection time, never by an error handler mid-build — this exact path is
    // how a Codex-connected owner's build spent managed credits.
    const activePolicy = resolveProviderPolicy(credential);
    if (preferProvider === "managed" && activePolicy.allowManagedFallback) {
      credential = { provider: "managed", secret: null };
    } else if (preferProvider !== "managed") {
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
    const strong = approvedConfiguredModel("ANTHROPIC_MODEL", "claude-sonnet-5", { provider: "anthropic", tier: "balanced" });
    const config = { provider: "anthropic", strong, apiKey: credential.secret };
    return {
      byok: true,
      providerLabel: "anthropic",
      strongModel: strong,
      routing: credential.routing || null,
      byokSafety: credential.byokSafety || null,
      policy: resolveProviderPolicy(credential),
      buildProvider: (intent) => createRoutingProvider({ config, turnMeta: { intent } }),
    };
  }

  if (credential.provider === "xai" && credential.secret) {
    const { createXaiEngineProvider, xaiPolicy, xaiEligibleForAgent, xaiReasoningForTask } = await import("../xaiProvider.mjs");
    const policy = xaiPolicy();
    if (policy.enabled && xaiEligibleForAgent("build", policy)) {
      const strong = approvedConfiguredModel("XAI_QUALITY_MODEL", "grok-4.5", { provider: "xai", tier: "quality" });
      const editModel = approvedConfiguredModel("XAI_BALANCED_MODEL", "grok-build-0.1", { provider: "xai", tier: "balanced" });
      return {
        byok: true,
        providerLabel: "xai",
        strongModel: strong,
        routing: credential.routing || null,
        byokSafety: credential.byokSafety || null,
        policy: resolveProviderPolicy(credential),
        buildProvider: (intent) => createXaiEngineProvider({
          model: intent === "fast" ? approvedConfiguredModel("XAI_FAST_MODEL", "grok-4.3", { provider: "xai", tier: "fast" }) : intent === "edit" ? editModel : strong,
          apiKey: credential.secret,
          reasoningEffort: xaiReasoningForTask(intent === "edit" ? "component_edit" : "full_build", policy),
        }),
      };
    }
    throw Object.assign(new Error("The selected xAI connection is not enabled for application builds."), {
      code: "provider_unavailable",
    });
  }

  if (credential.provider === "openai" && credential.secret) {
    return {
      byok: true,
      providerLabel: "openai",
      strongModel: managedModelForIntent("generate"),
      routing: credential.routing || null,
      byokSafety: credential.byokSafety || null,
      policy: resolveProviderPolicy(credential),
      buildProvider: (intent) =>
        createOpenAIEngineProvider({ model: managedModelForIntent(intent), apiKey: credential.secret }),
    };
  }

  // A Codex-subscription connection builds on the owner's ChatGPT-linked allowance. This used to
  // "fall back to managed for builds" — silently, per this file's own former header — which is how
  // an owner with Codex active watched seven managed gpt-5.6 calls spend their managed credits.
  // A provider choice is a billing-lane choice: Codex means Codex, and if the transport is
  // unavailable the build STOPS rather than switching lanes.
  if (credential.provider === "codex") {
    const { createCodexProvider } = await import("../../../../src/providers/codexProvider.mjs");
    // The transport's REAL wire model, not a cosmetic label: the ChatGPT-account backend rejects
    // "-codex"-suffixed names, and telemetry recording a model the wire never used would be the
    // same class of lie as recording null.
    // Codex auth is owner-scoped encrypted database state. The worker service account must not
    // depend on a shared ~/.codex/auth.json belonging to the VPS operator. Rotated refresh tokens
    // are persisted back to the same owner credential atomically through the credential store.
    let storedAuth = credential.secret;
    const tokenProvider = createStoredAccessTokenProvider({
      loadAuth: async () => storedAuth,
      persistAuth: async (auth) => {
        storedAuth = JSON.stringify(auth);
        await refreshCodexAuth(ownerId, storedAuth, credential.metadata || {});
      },
    });
    const strong = createCodexProvider({ tokenProvider }).model;
    return {
      byok: true, // never reserves or debits managed credits
      providerLabel: "codex",
      strongModel: strong,
      routing: credential.routing || null,
      byokSafety: credential.byokSafety || null,
      policy: resolveProviderPolicy(credential),
      buildProvider: () => createCodexProvider({ tokenProvider }),
    };
  }

  if (credential.provider === "gemini" && credential.secret) {
    const strong = approvedConfiguredModel("GEMINI_QUALITY_MODEL", "gemini-3.6-flash", { provider: "gemini", tier: "quality" });
    const fast = approvedConfiguredModel("GEMINI_FAST_MODEL", "gemini-3.5-flash-lite", { provider: "gemini", tier: "fast" });
    return {
      byok: true, providerLabel: "gemini", strongModel: strong,
      routing: credential.routing || null, byokSafety: credential.byokSafety || null,
      policy: resolveProviderPolicy(credential),
      buildProvider: (intent) => createGeminiEngineProvider({
        apiKey: credential.secret, model: intent === "fast" ? fast : strong,
      }),
    };
  }

  if (credential.provider !== "managed") {
    throw Object.assign(new Error(`The selected ${credential.provider} connection cannot run application builds.`), {
      code: "provider_unavailable",
    });
  }

  return {
    byok: false,
    providerLabel: "openai-managed",
    strongModel: managedModelForIntent("generate"),
    routing: credential.routing || null,
    byokSafety: credential.byokSafety || null,
    policy: resolveProviderPolicy({ provider: "managed" }),
    buildProvider: (intent) => createOpenAIEngineProvider({ model: managedModelForIntent(intent) }),
  };
}
