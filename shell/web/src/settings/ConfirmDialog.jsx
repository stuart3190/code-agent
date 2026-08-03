// Confirmation before something that cannot be undone.
//
// Focus lands on Cancel, not the destructive button: a stray Enter must not revoke a key. Escape
// and the scrim both cancel, and focus returns to whatever opened it — the same contract every
// other dialog in the product keeps.

import React, { useEffect, useRef, useState } from "react";

export default function ConfirmDialog({
  title, body, confirmLabel = "Confirm", destructive = false, onCancel, onConfirm,
}) {
  const cancelRef = useRef(null);
  const opener = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    opener.current = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      // Stopped here rather than allowed to bubble: the sheet behind this also closes on Escape,
      // and dismissing a confirmation should not also close the screen that raised it.
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [onCancel]);

  const confirm = async () => {
    setBusy(true); setError("");
    try {
      await onConfirm();
      onCancel();
    } catch (e) {
      setError(e?.message || "That did not work. Nothing was changed.");
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ct-scrim show" aria-hidden="true" onClick={busy ? undefined : onCancel} />
      <div className="ct-palette show st-confirm" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p className="ct-hint">{body}</p>
        {error && <div className="mg-error">{error}</div>}
        <div className="ct-actions">
          <button ref={cancelRef} className="ct-btn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className={destructive ? "ct-btn ct-danger-solid" : "ct-btn"} disabled={busy} onClick={confirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
