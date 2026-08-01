// The user-facing model selector catalog: exactly which providers/models THIS owner can
// choose right now, with source, availability, quality label and relative cost — plus the
// per-conversation preference contract. Selecting a model never rebuilds anything and
// never resets memory: it only shapes FUTURE AI requests. No secrets ever appear here.

import { aiCredentialStore, activeAiCredential } from "./aiCredentialStore.mjs";
import { modelCatalog } from "./modelRouting.mjs";
import { modelWeight } from "../../../src/billing/costModel.mjs";

const TIER_LABEL = { quality: "Best quality", balanced: "Balanced", fast: "Fast" };

function relCost(model) {
  const weight = modelWeight(model);
  return `≈${weight.toFixed(2)}×`;
}

// The full selectable catalog for one owner. `credentials` = the owner's connected
// providers (no secrets — provider names only); managed availability comes from the
// platform's own configured env keys via modelCatalog().
export function selectableModels({ credentials = [], routing = {} } = {}) {
  const connected = new Set(credentials.map((c) => c.provider));
  const options = [{
    value: "auto",
    provider: "auto",
    model: "Smart routing",
    source: "Thrallo managed",
    label: "Recommended",
    relCost: null,
    available: true,
    detail: "Thrallo picks the best configured model per task and can fall back if a provider stumbles.",
  }];

  for (const entry of modelCatalog()) {
    const byok = connected.has(entry.provider);
    // A model is selectable when the platform runs it managed, or the user's own key
    // covers that provider. Never list a provider with neither.
    const available = entry.configured || byok;
    if (!available) continue;
    options.push({
      value: `${entry.provider}:${entry.model}`,
      provider: entry.provider,
      model: entry.model,
      source: byok ? "Your API key" : "Thrallo managed",
      label: TIER_LABEL[entry.tier] || entry.tier,
      relCost: relCost(entry.model),
      available: true,
      detail: null,
    });
  }

  if (connected.has("codex")) {
    options.push({
      value: "codex",
      provider: "codex",
      model: "ChatGPT Codex",
      source: "Included plan",
      label: "Your ChatGPT plan",
      relCost: "included",
      available: true,
      detail: "Repo runs use your Codex allowance; conversation and app builds route to managed models.",
    });
  }

  const unconfigured = ["openai", "anthropic", "gemini", "xai"]
    .filter((provider) => !connected.has(provider) && !options.some((o) => o.provider === provider));
  return { options, unconfigured, allowFallback: routing.allowFallback !== false };
}

export async function selectableModelsForOwner(owner, { store = aiCredentialStore() } = {}) {
  const [credentials, credential] = await Promise.all([
    store.listCredentials(owner).catch(() => []),
    activeAiCredential(owner, { store }).catch(() => ({ routing: {} })),
  ]);
  return selectableModels({
    credentials: (credentials || []).map((c) => ({ provider: c.provider })),
    routing: credential.routing || {},
  });
}

// Validation for storing a preference: only "auto" or a currently-listed option.
export function validateModelChoice(catalog, value) {
  const trimmed = String(value || "auto").trim();
  const option = catalog.options.find((o) => o.value === trimmed);
  if (!option || !option.available) {
    const error = new Error("That model isn't available on your account — pick one from the list or Auto.");
    error.status = 400;
    error.code = "model_unavailable";
    throw error;
  }
  return trimmed;
}

// The Lead Agent's request resolution for a conversation preference. NEVER silently
// switches: an unavailable selection either falls back (only when the user enabled
// automatic fallback) WITH a visible notice, or surfaces a clear warning.
export function resolveConversationModel(conversation, catalog) {
  const pref = String(conversation?.model_pref || "auto").trim();
  if (pref === "auto" || pref === "codex") return { requested: "auto", notice: null, warning: null };
  const option = catalog.options.find((o) => o.value === pref);
  if (option?.available) return { requested: pref, notice: null, warning: null };
  if (catalog.allowFallback) {
    return {
      requested: "auto",
      notice: `Your selected model (${pref.replace(":", " · ")}) isn't available right now, so I'm using smart routing for this request — automatic fallback is enabled in your settings.`,
      warning: null,
    };
  }
  return {
    requested: null,
    notice: null,
    warning: `Your selected model (${pref.replace(":", " · ")}) isn't available right now and automatic fallback is off. Pick another model from the selector, switch to Auto, or enable fallback in Settings.`,
  };
}
