// One executable model catalogue for the selector, router, adapters and billing records.
// Environment variables may choose among approved entries; they may never invent an entry.

export const MODEL_LANES = Object.freeze({
  managed: "managed",
  byok: "byok_api",
  codex: "connected_allowance",
});

const OPENAI_REASONING = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_REASONING = Object.freeze(["default"]);

const MODELS = Object.freeze([
  entry("openai", "gpt-5.6-sol", "quality", [MODEL_LANES.managed, MODEL_LANES.byok], OPENAI_REASONING),
  entry("openai", "gpt-5.6-terra", "balanced", [MODEL_LANES.managed, MODEL_LANES.byok], OPENAI_REASONING),
  entry("openai", "gpt-5.6-luna", "fast", [MODEL_LANES.managed, MODEL_LANES.byok], OPENAI_REASONING),
  entry("anthropic", "claude-opus-5", "quality", [MODEL_LANES.byok], DEFAULT_REASONING),
  entry("anthropic", "claude-sonnet-5", "balanced", [MODEL_LANES.byok], DEFAULT_REASONING),
  entry("anthropic", "claude-haiku-4-5-20251001", "fast", [MODEL_LANES.byok], DEFAULT_REASONING),
  entry("anthropic", "claude-opus-4-8", "quality", [MODEL_LANES.byok], DEFAULT_REASONING, ["quality"], "deprecated_hidden"),
  entry("anthropic", "claude-sonnet-4-6", "balanced", [MODEL_LANES.byok], DEFAULT_REASONING, ["balanced"], "deprecated_hidden"),
  entry("anthropic", "claude-haiku-4-5", "fast", [MODEL_LANES.byok], DEFAULT_REASONING, ["fast"], "deprecated_alias"),
  entry("gemini", "gemini-3.6-flash", "quality", [MODEL_LANES.byok], DEFAULT_REASONING, ["quality", "balanced"]),
  entry("gemini", "gemini-3.5-flash-lite", "fast", [MODEL_LANES.byok], DEFAULT_REASONING),
  entry("xai", "grok-4.5", "quality", [MODEL_LANES.byok], ["low", "medium", "high"]),
  entry("xai", "grok-build-0.1", "balanced", [MODEL_LANES.byok], ["default"]),
  entry("xai", "grok-4.3", "fast", [MODEL_LANES.byok], ["low", "medium", "high"]),
  entry("codex", "gpt-5.6-sol", "quality", [MODEL_LANES.codex], OPENAI_REASONING),
  entry("codex", "gpt-5.6-terra", "balanced", [MODEL_LANES.codex], OPENAI_REASONING),
  entry("codex", "gpt-5.6-luna", "fast", [MODEL_LANES.codex], OPENAI_REASONING),
  // Optional: the selector shows this only after live discovery lists it for the account.
  entry("codex", "gpt-6-astra", "quality", [MODEL_LANES.codex], OPENAI_REASONING, ["quality"], "discovered", {}, { optional: true }),
  // Retired on the ChatGPT plan 2026-10-14. Hidden from the selector, still resolvable so a
  // stored preference does not throw; execution maps it onto the quality successor.
  entry("codex", "gpt-5.5", "quality", [MODEL_LANES.codex], OPENAI_REASONING, ["quality", "balanced", "fast"], "deprecated_hidden", {}, { replacement: "gpt-5.6-sol" }),
  entry("openai", "gpt-5.4-mini", "runtime", [MODEL_LANES.managed, MODEL_LANES.byok], OPENAI_REASONING,
    ["runtime"], "internal", { generatedAppBuilds: false, runtimeOperations: ["text", "structured"] }),
  entry("openai", "gpt-5.4", "runtime", [MODEL_LANES.managed, MODEL_LANES.byok], OPENAI_REASONING,
    ["runtime"], "internal", { generatedAppBuilds: false, runtimeOperations: ["image"] }),
  entry("openai", "text-embedding-3-small", "runtime", [MODEL_LANES.managed, MODEL_LANES.byok], DEFAULT_REASONING,
    ["runtime"], "internal", { tools: false, structuredOutput: false, generatedAppBuilds: false, runtimeOperations: ["embeddings"] }),
  entry("replicate", "bytedance/seedance-1-pro", "runtime", [MODEL_LANES.managed, MODEL_LANES.byok], DEFAULT_REASONING,
    ["runtime"], "internal", { tools: false, structuredOutput: false, generatedAppBuilds: false, runtimeOperations: ["prediction"] }),
]);

export const CODEX_DEFAULT_MODEL = "gpt-5.6-terra";
export const CODEX_PLAN_FALLBACKS = Object.freeze(["gpt-5.6-terra", "gpt-5.6-luna"]);

function entry(provider, model, tier, lanes, reasoningProfiles, tiers = [tier], visibility = "public", capabilityOverrides = {}, extra = {}) {
  return Object.freeze({
    provider, model, tier, tiers: Object.freeze(tiers), lanes: Object.freeze(lanes),
    reasoningProfiles: Object.freeze(reasoningProfiles),
    billingPolicy: Object.freeze({
      [MODEL_LANES.managed]: "thrallo_managed_credits",
      [MODEL_LANES.byok]: "owner_provider_account",
      [MODEL_LANES.codex]: "connected_subscription_allowance",
    }),
    visibility,
    replacement: extra.replacement || null,
    optional: extra.optional === true,
    capabilities: Object.freeze({ tools: true, structuredOutput: true, generatedAppBuilds: true, ...capabilityOverrides }),
  });
}

export function codexStaticModels() {
  return executableModelCatalogue()
    .filter((row) => row.provider === "codex" && row.visibility === "public" && row.lanes.includes(MODEL_LANES.codex))
    .map((row) => row.model);
}

// Public ChatGPT-plan models, plus optional rows that discovery is allowed to reveal.
export function codexDiscoverableModels() {
  return executableModelCatalogue()
    .filter((row) => row.provider === "codex" && row.lanes.includes(MODEL_LANES.codex))
    .filter((row) => row.visibility === "public" || row.visibility === "discovered")
    .map((row) => row.model);
}

// gpt-5.5 stays addressable for old preferences and resolves to its public successor.
// Anything else is sent as given; an empty selection uses the balanced catalogue default.
export function codexExecutionModel(model) {
  const requested = String(model || "").trim();
  if (!requested) return CODEX_DEFAULT_MODEL;
  const row = modelEntry("codex", requested);
  if (row?.visibility !== "deprecated_hidden") return requested;
  const replacement = row.replacement ? modelEntry("codex", row.replacement) : null;
  if (replacement?.visibility === "public") return replacement.model;
  return CODEX_DEFAULT_MODEL;
}

// A ChatGPT-plan credential executes Codex-lane slugs even when a stored preference
// still names the same model on the managed or BYOK lane. Other providers are unchanged.
export function selectionForActiveCredential(credential, selection) {
  const active = credential?.provider || "managed";
  const provider = selection?.provider;
  const model = selection?.model;
  if (active === "codex") {
    const onCodex = modelEntry("codex", model);
    const executable = onCodex
      && onCodex.lanes.includes(MODEL_LANES.codex)
      && onCodex.visibility !== "internal";
    if (provider === "codex" || executable) {
      return { provider: "codex", model: codexExecutionModel(model) };
    }
  }
  return { provider, model };
}

export function executableModelCatalogue() {
  return MODELS.map((row) => ({ ...row }));
}

export function modelEntry(provider, model) {
  return MODELS.find((row) => row.provider === provider && row.model === model) || null;
}

export function modelEntriesFor({ provider = null, lane = null, tier = null } = {}) {
  return executableModelCatalogue().filter((row) => (
    (!provider || row.provider === provider)
    && (!lane || row.lanes.includes(lane))
    && (!tier || row.tiers.includes(tier))
  ));
}

export function canonicalModelIdentity({ provider, model, lane, reasoningProfile = "default" } = {}) {
  const normalizedProvider = provider === "openai-managed" ? "openai" : String(provider || "");
  const normalizedLane = lane || (provider === "openai-managed" ? MODEL_LANES.managed : null);
  const row = modelEntry(normalizedProvider, String(model || ""));
  if (!row) throw modelError("model_unsupported", `Model ${normalizedProvider || "unknown"}:${model || "unknown"} is not executable.`);
  if (!row.lanes.includes(normalizedLane)) {
    throw modelError("model_lane_unavailable", `Model ${row.provider}:${row.model} is not executable on lane ${normalizedLane || "unknown"}.`);
  }
  const defaultReasoning = row.reasoningProfiles.includes("medium") ? "medium" : row.reasoningProfiles[0];
  const reasoning = row.reasoningProfiles.includes(reasoningProfile)
    ? reasoningProfile
    : (reasoningProfile === "default" ? defaultReasoning : null);
  if (!reasoning) {
    throw modelError("model_reasoning_unavailable", `Reasoning profile ${reasoningProfile} is not executable for ${row.provider}:${row.model}.`);
  }
  return Object.freeze({
    provider: row.provider, model: row.model, lane: normalizedLane, reasoningProfile: reasoning,
    billingPolicy: row.billingPolicy[normalizedLane],
    capabilities: row.capabilities,
    key: `${normalizedLane}:${row.provider}:${row.model}:${reasoning}`,
  });
}

export function selectionValue(identity) {
  return `${identity.lane}:${identity.provider}:${identity.model}`;
}

export function parseSelection(value, { defaultLane = null } = {}) {
  const raw = String(value || "").trim();
  const parts = raw.split(":");
  if (parts.length === 3 && Object.values(MODEL_LANES).includes(parts[0])) {
    return { lane: parts[0], provider: parts[1], model: parts.slice(2).join(":") };
  }
  if (parts.length === 2) return { lane: defaultLane, provider: parts[0], model: parts[1] };
  throw modelError("model_selection_invalid", "Model selection must include lane, provider and model.");
}

export function approvedConfiguredModel(envName, fallback, { provider, tier = null } = {}) {
  const selected = String(process.env[envName] || fallback);
  const row = modelEntry(provider, selected);
  if (!row || (tier && !row.tiers.includes(tier))) {
    throw modelError("model_configuration_invalid", `${envName} names a model that is not approved for ${provider}${tier ? `/${tier}` : ""}.`);
  }
  return selected;
}

export function assertExecutableCandidate(candidate) {
  if (candidate.executable === false) {
    throw modelError("model_unavailable", `Model ${candidate.provider || "unknown"}:${candidate.model || "unknown"} has no executable adapter.`);
  }
  const identity = canonicalModelIdentity({
    provider: candidate.provider,
    model: candidate.model,
    lane: candidate.billingLane || candidate.lane,
    reasoningProfile: candidate.reasoningProfile || "default",
  });
  return { ...candidate, catalogueExecutable: true, identity, canonicalKey: identity.key };
}

export function assertCapabilityModel({ provider, model, lane, operation }) {
  const identity = canonicalModelIdentity({ provider, model, lane });
  const allowed = modelEntry(identity.provider, identity.model)?.capabilities?.runtimeOperations || [];
  if (!allowed.includes(operation)) {
    throw modelError("model_capability_unavailable", `Model ${identity.provider}:${identity.model} cannot execute runtime operation ${operation}.`);
  }
  return identity;
}

export function assertProviderModel({ provider, model, capability = "generatedAppBuilds" }) {
  const row = modelEntry(provider, model);
  if (!row) throw modelError("model_unsupported", "The requested provider model is not executable.");
  if (capability && row.capabilities?.[capability] !== true) {
    throw modelError("model_capability_unavailable", "The requested provider model cannot execute this capability.");
  }
  return row;
}

function modelError(code, message) {
  return Object.assign(new Error(message), { code, status: 400, retryable: false });
}
