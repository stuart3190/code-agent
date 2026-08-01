// Model selector — Provider → Model → Mode. The closed pill always says what will run
// ("🤖 Model: Auto" / "🤖 gpt-5.6-terra • Deep Thinking"); the open menu is a PORTAL
// popover anchored to the pill (never clipped by parent containers, never behind cards,
// flips above when near the viewport bottom, closes on outside click / Escape). Fully
// keyboard navigable. Populates entirely from /api/v1/models adapter metadata.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listModels } from "../lib/codeAgentApi.js";

export const MODEL_PREF_KEY = "thrallo-model-pref";

export function parsePref(pref) {
  const [value, mode] = String(pref || "auto").split("#");
  return { value: value || "auto", mode: mode || "balanced" };
}

const PROVIDER_SHORT = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "Grok", codex: "ChatGPT", auto: "Auto" };
const PROVIDER_MONOGRAM = {
  openai: { text: "◯", hue: "#10a37f" },
  anthropic: { text: "A", hue: "#d97706" },
  gemini: { text: "G", hue: "#1a73e8" },
  xai: { text: "𝕏", hue: "#111111" },
  codex: { text: "C", hue: "#10a37f" },
};

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

function Monogram({ provider }) {
  const m = PROVIDER_MONOGRAM[provider];
  if (!m) return null;
  return <span className="ct-model-mono" style={{ background: m.hue }} aria-hidden="true">{m.text}</span>;
}

export default function ModelSelector({ value, onChange, onOpenSettings, compact = false }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [level, setLevel] = useState("providers"); // providers | models | modes | auto
  const [pickedProvider, setPickedProvider] = useState(null);
  const [pickedModel, setPickedModel] = useState(null);
  const [menuPos, setMenuPos] = useState(null); // {left, top?, bottom?, width}
  const pillRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    listModels().then(setCatalog).catch(() => setCatalog({ providers: [], modes: [], options: [] }));
  }, []);

  // Anchor: fixed-position portal directly below the pill; flip above when the viewport
  // bottom is close. Recomputed on open, resize, and any scroll.
  const place = () => {
    const rect = pillRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(380, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 340 && rect.top > spaceBelow;
    setMenuPos(openUp
      ? { left, bottom: window.innerHeight - rect.top + 8, width }
      : { left, top: rect.bottom + 8, width });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => { window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open]);

  // Outside click + Escape close; focus returns to the pill.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (pillRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); pillRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  useEffect(() => { if (!open) { setLevel("providers"); setPickedProvider(null); setPickedModel(null); } }, [open]);

  // Keyboard navigation inside the menu: arrows move, Enter activates, ← goes back.
  useEffect(() => {
    if (!open) return undefined;
    const first = menuRef.current?.querySelector("[data-row]");
    first?.focus();
  }, [open, level]);
  const onMenuKey = (e) => {
    const rows = [...(menuRef.current?.querySelectorAll("[data-row]") || [])];
    const index = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(index + 1, rows.length - 1)]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); rows[Math.max(index - 1, 0)]?.focus(); }
    if (e.key === "ArrowLeft" && level !== "providers") { e.preventDefault(); setLevel(level === "modes" ? "models" : "providers"); }
  };

  const { value: currentValue } = parsePref(value);
  const selectedUnavailable = currentValue !== "auto" && currentValue !== "codex" && catalog?.options
    && !catalog.options.some((o) => o.value === currentValue && o.available);

  const choose = (val, mode) => {
    onChange(mode && mode !== "balanced" ? `${val}#${mode}` : val);
    setOpen(false);
    pillRef.current?.focus();
  };

  const providers = catalog?.providers || [];
  const provider = providers.find((p) => p.id === pickedProvider);
  const auto = catalog?.autoStrategy;

  const pillLabel = selectedUnavailable
    ? "Model unavailable"
    : currentValue === "auto" ? `Model: ${displayName(value, catalog)}` : displayName(value, catalog);

  return (
    <div className={`ct-model ${compact ? "compact" : ""}`}>
      <button ref={pillRef} className={`ct-model-pill ${selectedUnavailable ? "warn" : ""}`}
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox"
        title={selectedUnavailable ? "Selected model unavailable — choose another" : "Choose which AI model powers this project"}>
        <span className="ct-model-glyph" aria-hidden="true">🤖</span>
        {pillLabel}
        <span className="ct-model-caret" aria-hidden="true">▾</span>
      </button>

      {open && menuPos && createPortal(
        <div ref={menuRef} className="ct-model-menu" role="listbox" aria-label="Model"
          style={{ left: menuPos.left, top: menuPos.top, bottom: menuPos.bottom, width: menuPos.width }}
          onKeyDown={onMenuKey}>
          <div className="ct-model-head" aria-hidden="true">🤖 Model</div>
          {selectedUnavailable && (
            <div className="ct-model-warnrow">
              Your selected model isn't available any more. Pick another below or switch to Auto
              {catalog?.allowFallback ? " — automatic fallback is on, so requests keep working meanwhile." : "."}
            </div>
          )}

          {level !== "providers" && (
            <button data-row className="ct-model-back" onClick={() => setLevel(level === "modes" ? "models" : "providers")}>
              ← {level === "modes" ? provider?.name : "Providers"}
            </button>
          )}

          {level === "providers" && (
            <>
              <div data-row role="option" aria-selected={currentValue === "auto"} tabIndex={0}
                className={`ct-model-row ${currentValue === "auto" ? "on" : ""}`}
                onClick={() => choose("auto", "balanced")}
                onKeyDown={(e) => { if (e.key === "Enter") choose("auto", "balanced"); }}>
                <span className="ct-model-main">
                  <span className="ct-model-name">Auto <span className="mg-pill" style={{ marginLeft: 4 }}>Recommended</span></span>
                  <span className="ct-model-sub">
                    Thrallo automatically chooses the best provider, model and reasoning mode using
                    measured cost, speed and verified success rates.{" "}
                    <button className="ct-model-why" onClick={(e) => { e.stopPropagation(); setLevel("auto"); }}>Why?</button>
                  </span>
                </span>
              </div>
              {providers.filter((p) => p.id !== "auto").map((p) => (
                p.available ? (
                  <button data-row key={p.id} className="ct-model-row" onClick={() => { setPickedProvider(p.id); setLevel("models"); }}>
                    <span className="ct-model-main" style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <Monogram provider={p.id} />
                      <span>
                        <span className="ct-model-name">{p.name}</span>
                        <span className="ct-model-sub">{p.source} · {p.models.length} model{p.models.length === 1 ? "" : "s"}</span>
                      </span>
                    </span>
                    <span className="ct-model-tags"><span className="ct-model-chev" aria-hidden="true">›</span></span>
                  </button>
                ) : (
                  <button data-row key={p.id} className="ct-model-row ct-model-configure"
                    onClick={() => { setOpen(false); onOpenSettings?.(); }}>
                    <span className="ct-model-main" style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <Monogram provider={p.id} />
                      <span>
                        <span className="ct-model-name" style={{ color: "var(--accent)" }}>Configure {p.name}</span>
                        <span className="ct-model-sub">Connect a key in Settings to unlock these models</span>
                      </span>
                    </span>
                    <span className="ct-model-tags"><span className="ct-model-chev" aria-hidden="true">›</span></span>
                  </button>
                )
              ))}
            </>
          )}

          {level === "auto" && auto && (
            <div className="ct-model-autoinfo">
              <div className="ct-model-name" style={{ marginBottom: 6 }}>Auto — current choice</div>
              <div className="ct-model-sub">Provider: <b>{PROVIDER_SHORT[auto.provider] || auto.provider}</b></div>
              <div className="ct-model-sub">Model: <b>{auto.model}</b></div>
              <div className="ct-model-sub">Mode: <b>Balanced</b></div>
              <div className="ct-model-sub" style={{ margin: "8px 0 2px", fontWeight: 700 }}>Reason</div>
              <div className="ct-model-sub">{auto.reason}</div>
              {auto.stats && !auto.stats.collecting ? (
                <>
                  <div className="ct-model-sub">Estimated build cost {auto.stats.avgCostCredits} cr · average completion {Math.round(auto.stats.avgDurationMs / 1000)}s</div>
                  <div className="ct-model-sub">Benchmark confidence: {auto.stats.samples} verified builds</div>
                </>
              ) : (
                <div className="ct-model-sub">Benchmark confidence: collecting — figures appear as builds accumulate.</div>
              )}
              <button data-row className="ct-model-config" onClick={() => choose(`${auto.provider}:${auto.model}`, "balanced")}>
                Pin this exact model instead of Auto →
              </button>
            </div>
          )}
          {level === "auto" && !auto && <div className="ct-model-sub" style={{ padding: 10 }}>Auto strategy unavailable right now.</div>}

          {level === "models" && provider && provider.models.map((m) => (
            <button data-row key={m.id} role="option" aria-selected={currentValue === m.value}
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
                <span className="ct-model-chev" aria-hidden="true">›</span>
              </span>
            </button>
          ))}

          {level === "modes" && provider && pickedModel && (provider.modes || []).map((mode) => (
            <button data-row key={mode.id} role="option"
              className={`ct-model-row ${value === (mode.id === "balanced" ? pickedModel.value : `${pickedModel.value}#${mode.id}`) ? "on" : ""}`}
              onClick={() => choose(pickedModel.value, mode.id)}>
              <span className="ct-model-main">
                <span className="ct-model-name">{mode.icon} {mode.name}</span>
                <span className="ct-model-sub">{mode.detail}</span>
              </span>
              <span className="ct-model-tags"><span className="mg-pill">{mode.badge}</span></span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
