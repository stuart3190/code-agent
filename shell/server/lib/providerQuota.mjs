// Provider quota management: the Lead Agent should behave like a senior engineer who
// quietly watches the fuel gauges and keeps the build moving. It tracks how much headroom
// each configured provider has, warns in plain language at 20% / 10% / 5%, offers the
// alternatives it can actually reach, and — when automatic fallback is on — switches and
// carries on from where execution stopped rather than restarting.
//
// Exact figures where a provider exposes them (Thrallo-managed = the owner's plan budget);
// an honest ESTIMATE from recent usage where it doesn't (BYOK keys expose no balance).

import { serviceClient } from "./supabase.mjs";

export const WARN_THRESHOLDS = [20, 10, 5];

const PROVIDER_LABEL = {
  managed: "Thrallo managed", openai: "OpenAI", anthropic: "Anthropic",
  gemini: "Gemini", xai: "Grok", codex: "ChatGPT Codex",
};

export function providerLabel(id) {
  return PROVIDER_LABEL[id] || id;
}

// Model display used in the badges and switch notices ("Grok 4.5", "GPT-5.6 Terra").
export function modelLabel(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  if (/^grok/i.test(raw)) return raw.replace(/^grok-?/i, "Grok ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (/^gpt/i.test(raw)) {
    // gpt-5.6-terra -> GPT-5.6 Terra
    const [, version = "", suffix = ""] = /^gpt-?([\d.]+)?-?(.*)$/i.exec(raw) || [];
    const name = suffix ? ` ${suffix.charAt(0).toUpperCase()}${suffix.slice(1).replace(/-/g, " ")}` : "";
    return `GPT${version ? `-${version}` : ""}${name}`.trim();
  }
  if (/^claude/i.test(raw)) return raw.replace(/^claude-?/i, "Claude ").replace(/-/g, " ").trim();
  if (/^gemini/i.test(raw)) return raw.replace(/^gemini-?/i, "Gemini ").replace(/-/g, " ").trim();
  return raw;
}

// ── Headroom ────────────────────────────────────────────────────────────────────────────

// Managed: exact, from the owner's plan budget. BYOK: no provider exposes a balance, so we
// report an estimate derived from this month's burn against a soft ceiling the owner can
// set (THRALLO_BYOK_SOFT_CEILING_CREDITS), and say plainly that it's an estimate.
export async function providerHeadroom(owner, {
  provider = "managed",
  overview = null,
  client = null,
  now = new Date(),
} = {}) {
  if (provider === "managed" || provider === "codex") {
    const tokens = overview?.budgets?.managedTokens;
    if (!tokens || !tokens.limit) return { provider, exact: false, percentRemaining: null, unknown: true };
    const percent = Math.max(0, Math.min(100, (Number(tokens.remaining || 0) / Number(tokens.limit)) * 100));
    return {
      provider, exact: true,
      percentRemaining: Number(percent.toFixed(1)),
      remaining: Number(tokens.remaining || 0),
      limit: Number(tokens.limit),
      unit: "tokens",
    };
  }

  const ceiling = Number(process.env.THRALLO_BYOK_SOFT_CEILING_CREDITS || 0);
  if (!ceiling) return { provider, exact: false, percentRemaining: null, unknown: true };
  const db = client || serviceClient();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data } = await db.from("ai_requests").select("cost, provider, created_at")
    .eq("owner", owner).eq("provider", provider).gte("created_at", since).limit(5000);
  const spent = (data || []).reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const percent = Math.max(0, Math.min(100, ((ceiling - spent) / ceiling) * 100));
  return {
    provider, exact: false,
    percentRemaining: Number(percent.toFixed(1)),
    remaining: Number(Math.max(ceiling - spent, 0).toFixed(2)),
    limit: ceiling,
    unit: "credits",
    estimated: true,
  };
}

// Which warning band (if any) a level falls into, given what has already been said.
// Report the MOST URGENT band actually crossed. A sudden drop from full to 9% warns once
// at 10% (not 20%), and once 5% has been announced nothing louder is said afterwards.
export function thresholdCrossed(percentRemaining, alreadyWarned = []) {
  if (percentRemaining == null) return null;
  const crossed = WARN_THRESHOLDS.filter((t) => percentRemaining <= t);
  if (!crossed.length) return null;
  const mostUrgent = Math.min(...crossed);
  return alreadyWarned.includes(mostUrgent) ? null : mostUrgent;
}

// ── Alternatives ────────────────────────────────────────────────────────────────────────

// Providers this owner could switch to right now: their own connected keys plus managed
// when the platform runs it. Never lists something the user cannot actually reach.
export function alternativeProviders({ current, credentials = [], managedAvailable = true }) {
  const connected = new Set((credentials || []).map((c) => c.provider).filter((p) => p && p !== "codex"));
  const options = [...connected];
  if (managedAvailable) options.push("managed");
  return options.filter((p) => p !== current);
}

// ── Plain-language copy (never technical) ───────────────────────────────────────────────

export function lowQuotaMessage({ provider, percent, estimated = false, alternatives = [] }) {
  const about = estimated ? "roughly" : "about";
  const head = `Just a heads up — your current ${providerLabel(provider)} budget is getting low (${about} ${Math.round(percent)}% remaining).`;
  if (!alternatives.length) {
    return `${head} There's no other provider connected, so I'll keep going on this one and let you know before it runs out. You can raise the limit or connect another provider in Settings at any time.`;
  }
  const names = alternatives.map(providerLabel);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return `${head} Would you like me to switch this build to ${list}, or continue using ${providerLabel(provider)} until it's exhausted?`;
}

export function switchedMessage({ from, to, toModel = null, reason = "quota" }) {
  const target = toModel ? modelLabel(toModel) : providerLabel(to);
  const why = {
    quota: `${providerLabel(from)} has reached its limit.`,
    rate_limit: `${providerLabel(from)} is rate-limiting requests right now.`,
    outage: `${providerLabel(from)} is temporarily unavailable.`,
    user_request: `You asked me to move off ${providerLabel(from)}.`,
    cost: `${providerLabel(to)} is the better-value option for this work.`,
  }[reason] || `${providerLabel(from)} couldn't continue.`;
  return `${why} I've switched this build to ${target} and continued from the last successful step.`;
}

export function exhaustedNoAlternativeMessage({ provider, kind = "quota" }) {
  const cause = kind === "rate_limit"
    ? `${providerLabel(provider)} is limiting how fast requests can be made`
    : `your ${providerLabel(provider)} budget is used up`;
  return [
    `I've had to pause here: ${cause}, and there's no other provider connected to switch to.`,
    "Everything done so far is saved — nothing is lost.",
    "To continue: connect another provider in Settings (Anthropic, Gemini or Grok all work), raise the limit on your current one, or wait for the allowance to reset. Tell me when you're ready and I'll pick up exactly where I stopped.",
  ].join(" ");
}

// ── Badges ──────────────────────────────────────────────────────────────────────────────

export function providerBadge({ provider, model, mode = null, switched = false }) {
  const label = modelLabel(model) || providerLabel(provider);
  if (switched) return { icon: "⚡", text: `Switched to ${label}` };
  if (mode === "deep" || mode === "max_quality") return { icon: "🧠", text: `Using Deep Thinking mode` };
  return { icon: "🤖", text: `Building with ${label}` };
}

// ── Diagnostics ─────────────────────────────────────────────────────────────────────────

export const SWITCH_REASONS = ["quota", "rate_limit", "outage", "user_request", "cost"];

// Every switch is recorded privately with its reason; the conversation only ever sees the
// plain-language sentence above.
export async function recordProviderSwitch({
  owner, conversationId = null, buildId = null,
  from, to, model = null, reason = "quota", detail = null, client = null,
} = {}) {
  const safeReason = SWITCH_REASONS.includes(reason) ? reason : "quota";
  const record = {
    audit: "provider_switch", owner, conversation: conversationId, build: buildId,
    from, to, model, reason: safeReason, detail: detail ? String(detail).slice(0, 500) : null,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(record));
  try {
    const { captureIncident } = await import("./errorShield.mjs");
    // Reuses the private incident trail so switches appear in Diagnostics alongside the
    // failure that caused them — never in the conversation.
    await captureIncident({
      error: { message: `provider switch ${from} -> ${to} (${safeReason})${detail ? `: ${detail}` : ""}`, code: `switch_${safeReason}` },
      owner, conversationId, buildId, service: "provider_routing", model, client,
    });
  } catch { /* diagnostics must never break a switch */ }
  return record;
}
