// Provider → Model → Mode selector. Beginners leave it on Auto; advanced users drill in
// without touching Settings. Populates ENTIRELY from /api/v1/models (adapter metadata +
// measured telemetry) — no provider-specific UI here. Switching affects future requests
// only: never a rebuild, never a memory reset.

import React, { useEffect, useRef, useState } from "react";
import { listModels } from "../lib/codeAgentApi.js";

export const MODEL_PREF_KEY = "thrallo-model-pref";

export function parsePref(pref) {
  const [value, mode] = String(pref || "auto").split("#");
  return { value: value || "auto", mode: mode || "balanced" };
}

const PROVIDER_SHORT = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "Grok", codex: "ChatGPT", auto: "Auto" };

export function displayName(pref, catalog = null) {
  const { value, mode } = parsePref(pref);
  const modeName = catalog?.modes?.find((m) => m.id === mode)?.name || (mode === "balanced" ? null : mode);
  if (value === "auto") return modeName && mode !== "balanced" ? `Auto • ${modeName}` : "Auto";
  const [provider, model] = value.split(":");
  const base = `${PROVIDER_SHORT[provider] || provider} · ${model || value}`;
  return mode !== "balanced" && modeName ? `${base} • ${modeName}` : base;
}

const fmtStats = (s) => s && !s.collecting
  ? `${"⭐".repeat(Math.max(1, Math.min(5, Math.round(s.successRate / 20))))} ${s.successRate}% · ${s.avgCostCredits} cr · ${Math.round(s.avgDurationMs / 1000)}s · ${s.avgRepairRounds} repairs`
  : "Collecting benchmark data…";

export default function ModelSelector({ value, onChange, onOpenSettings, compact = false }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [level, setLevel] = useState("providers"); // providers | models | modes | auto
  const [pickedProvider, setPickedProvider] = useState(null);
  const [pickedModel, setPickedModel] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    listModels().then(setCatalog).catch(() => setCatalog({ providers: [], modes: [], options: [] }));
  }, []);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => { if (!open) { setLevel("providers"); setPickedProvider(null); setPickedModel(null); } }, [open]);

  const { value: currentValue } = parsePref(value);
  const selectedUnavailable = currentValue !== "auto" && currentValue !== "codex" && catalog?.options
    && !catalog.options.some((o) => o.value === currentValue && o.available);

  const choose = (val, mode) => {
    onChange(mode && mode !== "balanced" ? `${val}#${mode}` : val);
    setOpen(false);
  };

  const providers = catalog?.providers || [];
  const provider = providers.find((p) => p.id === pickedProvider);
  const auto = catalog?.autoStrategy;

  return (
    <div className={`ct-model ${compact ? "compact" : ""}`} ref={ref}>
      <button className={`ct-model-pill ${selectedUnavailable ? "warn" : ""}`}
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox"
        title={selectedUnavailable ? "Selected model unavailable — choose another" : "Provider · Model · Mode for this project"}>
        <span className="ct-model-glyph" aria-hidden="true">◇</span>
        {selectedUnavailable ? "Model unavailable" : displayName(value, catalog)}
      </button>
      {open && (
        <div className="ct-model-menu" role="listbox" aria-label="Model">
          {selectedUnavailable && (
            <div className="ct-model-warnrow">
              Your selected model isn't available any more. Pick another below or switch to Auto
              {catalog?.allowFallback ? " — automatic fallback is on, so requests keep working meanwhile." : "."}
            </div>
          )}

          {level !== "providers" && (
            <button className="ct-model-back" onClick={() => setLevel(level === "modes" ? "models" : "providers")}>
              ← {level === "modes" ? provider?.name : "Providers"}
            </button>
          )}

          {level === "providers" && (
            <>
              <div role="option" aria-selected={currentValue === "auto"} tabIndex={0}
                className={`ct-model-row ${currentValue === "auto" ? "on" : ""}`}
                onClick={() => choose("auto", "balanced")}
                onKeyDown={(e) => { if (e.key === "Enter") choose("auto", "balanced"); }}>
                <span className="ct-model-main">
                  <span className="ct-model-name">Auto</span>
                  <span className="ct-model-sub">Thrallo picks the best measured model per task</span>
                </span>
                <span className="ct-model-tags">
                  <span className="mg-pill">Recommended</span>
                  <button className="ct-model-info" aria-label="How Auto decides"
                    onClick={(e) => { e.stopPropagation(); setLevel("auto"); }}>ⓘ</button>
                </span>
              </div>
              {providers.filter((p) => p.id !== "auto").map((p) => (
                p.available ? (
                  <button key={p.id} className="ct-model-row" onClick={() => { setPickedProvider(p.id); setLevel("models"); }}>
                    <span className="ct-model-main">
                      <span className="ct-model-name">{p.name}</span>
                      <span className="ct-model-sub">{p.source} · {p.models.length} model{p.models.length === 1 ? "" : "s"}</span>
                    </span>
                    <span className="ct-model-tags"><span aria-hidden="true">→</span></span>
                  </button>
                ) : (
                  <button key={p.id} className="ct-model-row ct-model-configure"
                    onClick={() => { setOpen(false); onOpenSettings?.(); }}>
                    <span className="ct-model-main">
                      <span className="ct-model-name" style={{ color: "var(--ink-3)" }}>{p.name}</span>
                      <span className="ct-model-sub">Not connected</span>
                    </span>
                    <span className="ct-model-tags"><span className="ct-model-cost" style={{ color: "var(--accent)" }}>Configure provider →</span></span>
                  </button>
                )
              ))}
            </>
          )}

          {level === "auto" && auto && (
            <div className="ct-model-autoinfo">
              <div className="ct-model-name" style={{ marginBottom: 6 }}>Auto — current strategy</div>
              <div className="ct-model-sub">Provider: <b>{PROVIDER_SHORT[auto.provider] || auto.provider}</b></div>
              <div className="ct-model-sub">Model: <b>{auto.model}</b></div>
              <div className="ct-model-sub">Mode: <b>Balanced</b></div>
              <div className="ct-model-sub" style={{ margin: "6px 0" }}>{auto.reason}</div>
              {auto.stats && !auto.stats.collecting && (
                <div className="ct-model-sub">{fmtStats(auto.stats)}</div>
              )}
              <button className="ct-model-config" onClick={() => choose(`${auto.provider}:${auto.model}`, "balanced")}>
                Pin this exact model instead of Auto →
              </button>
            </div>
          )}
          {level === "auto" && !auto && <div className="ct-model-sub" style={{ padding: 10 }}>Auto strategy unavailable right now.</div>}

          {level === "models" && provider && provider.models.map((m) => (
            <button key={m.id} role="option" aria-selected={currentValue === m.value}
              className={`ct-model-row ${currentValue === m.value ? "on" : ""}`}
              onClick={() => {
                if (provider.id === "codex") { choose(m.value, "balanced"); return; }
                setPickedModel(m); setLevel("modes");
              }}>
              <span className="ct-model-main">
                <span className="ct-model-name">{m.name}</span>
                <span className="ct-model-sub">{fmtStats(m.stats)}</span>
              </span>
              <span className="ct-model-tags">
                {m.tier && <span className="mg-pill">{m.tier}</span>}
                {m.relCost && <span className="ct-model-cost">{m.relCost}</span>}
              </span>
            </button>
          ))}

          {level === "modes" && provider && pickedModel && (provider.modes || []).map((mode) => (
            <button key={mode.id} role="option"
              className={`ct-model-row ${value === (mode.id === "balanced" ? pickedModel.value : `${pickedModel.value}#${mode.id}`) ? "on" : ""}`}
              onClick={() => choose(pickedModel.value, mode.id)}>
              <span className="ct-model-main">
                <span className="ct-model-name">{mode.icon} {mode.name}</span>
                <span className="ct-model-sub">{mode.detail}</span>
              </span>
              <span className="ct-model-tags"><span className="mg-pill">{mode.badge}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
