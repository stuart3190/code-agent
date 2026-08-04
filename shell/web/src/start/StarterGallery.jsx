// Start from an idea.
//
// Ten expert opening prompts. Choosing one puts its text in the composer, EDITABLE, and sends it
// through the ordinary path — the same `send()` a typed sentence takes. There is no template
// engine and no second pipeline; the only difference between picking a starter and typing is who
// wrote the first draft.
//
// The edit step is not decoration. A prompt sent verbatim builds the example; a prompt someone has
// changed two nouns in builds their thing, and the whole value of a starter is being a good first
// draft rather than a finished answer.

import React, { useEffect, useRef, useState } from "react";
import { STARTER_CATEGORIES } from "../../../shared/starters.mjs";

export default function StarterGallery({ onUse, onClose, compact = false }) {
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState("");
  const textarea = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!selected) return;
    setDraft(selected.prompt);
    // Focus the text, not the send button: the expected next move is to change a word or two.
    const id = requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [selected]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (selected) { event.stopPropagation(); setSelected(null); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected]);

  if (selected) {
    return (
      <div className="st-starter-edit" role="dialog" aria-label={`Start from ${selected.title}`}>
        <div className="st-starter-edit-head">
          <button className="ct-btn-quiet" onClick={() => setSelected(null)}>← All ideas</button>
          <span className="ct-hint">{selected.title}</span>
        </div>
        <div className="st-starter-outcome">
          <b>What this builds</b>
          <span className="ct-hint">{selected.outcome}</span>
        </div>
        <label className="ct-hint" htmlFor="st-starter-prompt">
          Edit anything here before you send it — this is a first draft, not a form.
        </label>
        <textarea id="st-starter-prompt" ref={textarea} className="st-starter-prompt"
          value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} />
        <div className="ct-actions">
          <button className="ct-btn" disabled={!draft.trim()} onClick={() => onUse(draft.trim(), selected.id)}>
            Start building
          </button>
          <button className="ct-btn-quiet" onClick={() => setDraft(selected.prompt)}>Reset to the original</button>
          {onClose && <button className="ct-btn-quiet" onClick={onClose}>Cancel</button>}
        </div>
      </div>
    );
  }

  return (
    <div className={`st-starters ${compact ? "is-compact" : ""}`}>
      <div className="st-starters-head">
        <div>
          <div className="st-starters-title">Start from an idea</div>
          <span className="ct-hint">
            Expert opening prompts. Pick one, change what you like, and it goes through the normal
            build — nothing here is a template.
          </span>
        </div>
        {onClose && <button className="ct-btn-quiet" onClick={onClose}>Close</button>}
      </div>
      <div className="st-starter-grid">
        {STARTER_CATEGORIES.map((starter) => (
          <button key={starter.id} className="st-starter" ref={opener}
            onClick={() => setSelected(starter)}
            aria-label={`${starter.title} — ${starter.description}`}>
            <span className="st-starter-icon" aria-hidden="true">{starter.icon}</span>
            <span className="st-starter-body">
              <b>{starter.title}</b>
              <span className="ct-hint">{starter.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
