// The user-facing model selector catalog: exactly which providers/models THIS owner can
// choose right now, with source, availability, quality label and relative cost — plus the
// per-conversation preference contract. Selecting a model never rebuilds anything and
// never resets memory: it only shapes FUTURE AI requests. No secrets ever appear here.

import { aiCredentialStore, activeAiCredential } from "./aiCredentialStore.mjs";
import { modelCatalog, routeCandidates } from "./modelRouting.mjs";
import { modelWeight } from "../../../src/billing/costModel.mjs";
import { openAIProviderMeta } from "./openAIProvider.mjs";
import { anthropicProviderMeta } from "./anthropicCodingProvider.mjs";
import { geminiProviderMeta } from "./geminiCodingProvider.mjs";
import { xaiProviderMeta } from "./xaiProvider.mjs";
import { serviceClient } from "./supabase.mjs";

// ── Provider registry: adding a provider = registering its adapter meta here. The
// selector UI populates entirely from this — no provider-specific UI anywhere else. ──
const PROVIDER_METAS = () => [openAIProviderMeta(), anthropicProviderMeta(), geminiProviderMeta(), xaiProviderMeta()];

// ── Execution modes (global vocabulary; each adapter maps them to what it supports) ──
export const MODES = [
  { id: "fast", name: "Fast", icon: "⚡", badge: "Fastest", detail: "Lowest latency, lowest reasoning effort." },
  { id: "balanced", name: "Balanced", icon: "⚖", badge: "Recommended", detail: "The default experience.", recommended: true },
  { id: "deep", name: "Deep Thinking", icon: "🧠", badge: "Best Quality", detail: "Maximum reasoning quality." },
  { id: "cheapest", name: "Cheapest", icon: "💰", badge: "Lowest Cost", detail: "Optimise for lowest total cost." },
  { id: "max_quality", name: "Maximum Quality", icon: "🏆", badge: "Best Verified Result", detail: "Best verified result regardless of speed." },
];

export function modesForProvider(providerId) {
  const meta = PROVIDER_METAS().find((m) => m.id === providerId);
  if (!meta) return MODES.filter((m) => ["fast", "balanced"].includes(m.id));
  return MODES.filter((mode) => meta.supportedModes.includes(mode.id));
}

// Map a mode to the provider's actual knobs (reasoning effort / tier hint). Unsupported
// modes fall back to the closest supported behaviour — balanced.
export function mapModeForProvider(providerId, modeId) {
  const meta = PROVIDER_METAS().find((m) => m.id === providerId);
  if (!meta) return {};
  return meta.modeMap[modeId] || meta.modeMap.balanced || {};
}

// ── Preference format: "auto" | "provider:model" with optional "#mode" suffix ──────────
export function parseModelPref(pref) {
  const raw = String(pref || "auto").trim();
  const [valuePart, modePart] = raw.split("#");
  const mode = MODES.some((m) => m.id === modePart) ? modePart : "balanced";
  return { value: valuePart || "auto", mode };
}

export function formatModelPref(value, mode = "balanced") {
  return mode && mode !== "balanced" ? `${value}#${mode}` : value;
}

// ── Measured telemetry per model (platform-wide aggregates from diag_runs) ─────────────
export const STATS_MIN_SAMPLES = 5;

export async function modelStats({ client = null } = {}) {
  const db = client || serviceClient();
  const { data } = await db.from("diag_runs")
    .select("model, status, duration_ms, totals, repair_rounds")
    .order("started_at", { ascending: false }).limit(500);
  const byModel = new Map();
  for (const run of data || []) {
    if (!run.model || !["passed", "failed", "complete_unverified"].includes(run.status)) continue;
    const entry = byModel.get(run.model) || { samples: 0, passed: 0, cost: 0, duration: 0, repairs: 0 };
    entry.samples += 1;
    entry.passed += run.status === "failed" ? 0 : 1;
    entry.cost += Number(run.totals?.cost || 0);
    entry.duration += Number(run.duration_ms || 0);
    entry.repairs += Number(run.repair_rounds || 0);
    byModel.set(run.model, entry);
  }
  const stats = {};
  for (const [model, e] of byModel) {
    stats[model] = e.samples >= STATS_MIN_SAMPLES ? {
      samples: e.samples,
      successRate: Number(((e.passed / e.samples) * 100).toFixed(1)),
      avgCostCredits: Number((e.cost / e.samples).toFixed(3)),
      avgDurationMs: Math.round(e.duration / e.samples),
      avgRepairRounds: Number((e.repairs / e.samples).toFixed(1)),
    } : { collecting: true, samples: e.samples };
  }
  return stats;
}

// ── Auto strategy explanation: exactly what Auto would pick right now, and why ─────────
export function autoStrategy({ credential = { provider: "managed" }, routing = {}, stats = {} }) {
  const candidates = routeCandidates({ credential, requested: "auto", policy: routing });
  const first = candidates[0] || null;
  if (!first) return null;
  const s = stats[first.model];
  return {
    provider: first.provider,
    model: first.model,
    mode: "balanced",
    reason: s && !s.collecting
      ? `Highest measured success rate for your routing profile (${s.successRate}% verified across ${s.samples} builds).`
      : "Default balanced routing — telemetry is still collecting for a measured ranking.",
    stats: s || null,
  };
}

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

  const unconfigured = PROVIDER_METAS().map((m) => m.id)
    .filter((provider) => !connected.has(provider) && !options.some((o) => o.provider === provider));

  // Hierarchical Provider -> Model -> Mode shape, populated entirely from adapter meta.
  const providers = [{
    id: "auto", name: "Auto", recommended: true, available: true, source: "Thrallo managed", models: [],
  }];
  for (const meta of PROVIDER_METAS()) {
    const providerOptions = options.filter((o) => o.provider === meta.id);
    if (providerOptions.length) {
      const seen = new Set();
      providers.push({
        id: meta.id, name: meta.name, available: true,
        source: providerOptions[0].source,
        models: providerOptions.filter((o) => !seen.has(o.model) && seen.add(o.model)).map((o) => ({
          id: o.model, name: o.model, tier: o.label, relCost: o.relCost, value: o.value,
        })),
        modes: modesForProvider(meta.id).map((m) => ({ ...m })),
      });
    } else {
      providers.push({ id: meta.id, name: meta.name, available: false, configure: true, models: [], modes: [] });
    }
  }
  if (connected.has("codex")) {
    providers.push({
      id: "codex", name: "ChatGPT Codex", available: true, source: "Included plan",
      models: [{ id: "codex", name: "ChatGPT Codex", tier: "Your ChatGPT plan", relCost: "included", value: "codex" }],
      modes: modesForProvider("codex").map((m) => ({ ...m })),
    });
  }

  return { options, providers, modes: MODES, unconfigured, allowFallback: routing.allowFallback !== false };
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

// The full API payload: hierarchical catalog + measured per-model telemetry + the exact
// Auto strategy (provider/model/mode/reason) so the UI can explain and let users override.
export async function modelSelectorPayload(owner, { store = aiCredentialStore(), statsClient = null } = {}) {
  const [credentials, credential] = await Promise.all([
    store.listCredentials(owner).catch(() => []),
    activeAiCredential(owner, { store }).catch(() => ({ provider: "managed", routing: {} })),
  ]);
  const catalog = selectableModels({
    credentials: (credentials || []).map((c) => ({ provider: c.provider })),
    routing: credential.routing || {},
  });
  const stats = await modelStats({ client: statsClient }).catch(() => ({}));
  for (const provider of catalog.providers) {
    for (const model of provider.models) model.stats = stats[model.id] || null;
  }
  catalog.autoStrategy = autoStrategy({
    credential: { provider: credential.provider || "managed", secret: null },
    routing: credential.routing || {},
    stats,
  });
  return catalog;
}

// Validation for storing a preference: only "auto" or a currently-listed option, with an
// optional "#mode" suffix that must be a supported mode for that provider.
export function validateModelChoice(catalog, rawValue) {
  const { value, mode } = parseModelPref(rawValue);
  const option = catalog.options.find((o) => o.value === value);
  if (!option || !option.available) {
    const error = new Error("That model isn't available on your account — pick one from the list or Auto.");
    error.status = 400;
    error.code = "model_unavailable";
    throw error;
  }
  const providerId = value === "auto" ? "auto" : option.provider;
  const supported = providerId === "auto"
    ? MODES.some((m) => m.id === mode)
    : modesForProvider(providerId).some((m) => m.id === mode);
  return formatModelPref(value, supported ? mode : "balanced");
}

// The Lead Agent's request resolution for a conversation preference. NEVER silently
// switches: an unavailable selection either falls back (only when the user enabled
// automatic fallback) WITH a visible notice, or surfaces a clear warning.
export function resolveConversationModel(conversation, catalog) {
  const parsed = parseModelPref(conversation?.model_pref);
  const pref = parsed.value;
  const mode = parsed.mode;
  if (pref === "auto" || pref === "codex") return { requested: "auto", mode, notice: null, warning: null };
  const option = catalog.options.find((o) => o.value === pref);
  if (option?.available) return { requested: pref, mode, notice: null, warning: null };
  if (catalog.allowFallback) {
    return {
      requested: "auto",
      mode,
      notice: `Your selected model (${pref.replace(":", " · ")}) isn't available right now, so I'm using smart routing for this request — automatic fallback is enabled in your settings.`,
      warning: null,
    };
  }
  return {
    requested: null,
    mode,
    notice: null,
    warning: `Your selected model (${pref.replace(":", " · ")}) isn't available right now and automatic fallback is off. Pick another model from the selector, switch to Auto, or enable fallback in Settings.`,
  };
}
