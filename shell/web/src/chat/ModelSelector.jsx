// The model selector: a quiet pill that opens a token-styled menu of exactly the models
// this user can use right now (provider, source, quality label, relative cost). Defaults
// to Auto; remembers the last choice for new projects; switching inside a conversation
// affects future requests only — never a rebuild, never a memory reset.

import React, { useEffect, useRef, useState } from "react";
import { listModels } from "../lib/codeAgentApi.js";

export const MODEL_PREF_KEY = "thrallo-model-pref";

const PROVIDER_LABEL = { auto: "Auto", openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "xAI Grok", codex: "ChatGPT", managed: "Thrallo" };

export function displayName(value, options = []) {
  if (!value || value === "auto") return "Auto";
  const option = options.find((o) => o.value === value);
  if (option) return `${PROVIDER_LABEL[option.provider] || option.provider} · ${option.model}`;
  return value.replace(":", " · ");
}

export default function ModelSelector({ value, onChange, onOpenSettings, compact = false }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    listModels().then(setCatalog).catch(() => setCatalog({ options: [], unconfigured: [] }));
  }, []);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const options = catalog?.options || [];
  const selectedUnavailable = value && value !== "auto" && catalog && !options.some((o) => o.value === value && o.available);

  return (
    <div className={`ct-model ${compact ? "compact" : ""}`} ref={ref}>
      <button className={`ct-model-pill ${selectedUnavailable ? "warn" : ""}`}
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox"
        title={selectedUnavailable ? "Selected model unavailable — choose another" : "Choose which model powers this project"}>
        <span className="ct-model-glyph" aria-hidden="true">◇</span>
        {selectedUnavailable ? "Model unavailable" : displayName(value, options)}
      </button>
      {open && (
        <div className="ct-model-menu" role="listbox" aria-label="Model">
          {selectedUnavailable && (
            <div className="ct-model-warnrow">
              Your selected model isn't available any more. Pick another below or switch to Auto
              {catalog?.allowFallback ? " — automatic fallback is on, so requests keep working meanwhile." : "."}
            </div>
          )}
          {options.map((option) => (
            <button key={option.value} role="option" aria-selected={value === option.value || (!value && option.value === "auto")}
              className={`ct-model-row ${value === option.value || (!value && option.value === "auto") ? "on" : ""}`}
              disabled={!option.available}
              onClick={() => { onChange(option.value); setOpen(false); }}>
              <span className="ct-model-main">
                <span className="ct-model-name">{option.value === "auto" ? "Auto — smart routing" : `${PROVIDER_LABEL[option.provider] || option.provider} · ${option.model}`}</span>
                <span className="ct-model-sub">{option.source}{option.detail ? ` — ${option.detail}` : ""}</span>
              </span>
              <span className="ct-model-tags">
                {option.label && <span className="mg-pill">{option.label}</span>}
                {option.relCost && <span className="ct-model-cost">{option.relCost}</span>}
              </span>
            </button>
          ))}
          {catalog?.unconfigured?.length > 0 && (
            <button className="ct-model-config" onClick={() => { setOpen(false); onOpenSettings?.(); }}>
              Configure providers ({catalog.unconfigured.join(", ")}) →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
