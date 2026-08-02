// Taking a site offline is visible to anyone using it, so it is confirmed rather than done on a
// single click — and the dialog says plainly what survives, because "unpublish" reads like
// "delete" to most people and it is not.

import React, { useEffect, useRef } from "react";
import { displayUrl } from "./publishLifecycle.js";

export default function UnpublishConfirm({ site, busy, error, onCancel, onConfirm }) {
  // Focus lands on the safe action, matching the delete dialog.
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <div className="ct-palette show" role="dialog" aria-modal="true" aria-label="Take this site offline?"
      style={{ padding: "22px 22px 18px" }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>Take this site offline?</h3>
      <p className="ct-hint" style={{ marginTop: 8, lineHeight: 1.5 }}>
        <strong>{displayUrl(site?.url)}</strong> will stop being reachable. Your project, its code
        and its publish history are all kept, and publishing again puts it back at the same address.
      </p>
      {error && <div className="mg-error">{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="ct-btn-quiet" ref={cancelRef} onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="ct-btn" onClick={onConfirm} disabled={busy}>
          {busy ? "Taking offline…" : "Unpublish"}
        </button>
      </div>
    </div>
  );
}
