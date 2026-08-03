// Settings → API keys.
//
// A token is shown exactly once, at creation. Everything afterwards works from the prefix, so
// nothing on this screen can ever hand back a secret — including to whoever is looking over the
// customer's shoulder when they reopen Settings a week later.

import React, { useState } from "react";
import { createApiToken, renameApiToken, revokeApiToken } from "../lib/codeAgentApi.js";
import { useCopy } from "../manage/shared.jsx";
import { formatBillingDate } from "../billing/planState.js";

export default function TokensTab({ tokens, onTokens, onConfirm, showToast }) {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);
  const [renaming, setRenaming] = useState(null);   // { id, value }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, copy] = useCopy();

  // A load failure is not "no tokens". Told apart so nobody creates a duplicate token believing
  // they had none — the exact confusion Phase 1 kept finding.
  if (tokens === null) {
    return (
      <div className="st-tab">
        <h3>API keys</h3>
        <div className="mg-error">
          Your API keys could not be loaded, so this list is not showing them — it does not mean you
          have none. Reopen Settings to try again.
        </div>
      </div>
    );
  }

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  const act = async (run, message = null) => {
    setBusy(true); setError("");
    try {
      const result = await run();
      if (result?.tokens) onTokens(result.tokens);
      if (message) showToast(message);
      return result;
    } catch (e) {
      setError(e.message || "That did not work. Nothing was changed.");
      return null;
    } finally { setBusy(false); }
  };

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setFresh(null);
    const result = await act(() => createApiToken(name.trim()));
    if (result) { setFresh(result.token); setName(""); }
  };

  const revoke = (token) => onConfirm({
    title: `Revoke “${token.name}”?`,
    body: "Anything signed in with this key — the CLI, the editor extension, Thrallo Desktop — stops "
      + "working immediately. This cannot be undone, and the key cannot be recovered: you would need "
      + "to create a new one and paste it everywhere this one was used.",
    confirmLabel: "Revoke key",
    destructive: true,
    onConfirm: () => act(() => revokeApiToken(token.id), `“${token.name}” revoked.`),
  });

  const saveName = async () => {
    const { id, value } = renaming;
    setRenaming(null);
    if (!value.trim()) return;
    await act(() => renameApiToken(id, value.trim()), "Key renamed.");
  };

  return (
    <div className="st-tab">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">API keys</div>
          <div className="ct-hint">
            For the CLI, the editor extension and Thrallo Desktop. Each key acts as you.
          </div>
        </div>
      </div>

      {fresh && (
        <div className="st-notice tone-warn st-fresh">
          <strong>Copy this now — it will not be shown again.</strong>
          <code className="st-secret">{fresh}</code>
          <div className="ct-actions">
            <button className="ct-btn" onClick={() => copy(fresh)}>{copied ? "Copied ✓" : "Copy key"}</button>
            <button className="ct-btn-quiet" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      <form className="st-newtoken" onSubmit={create}>
        <label className="ct-hint" htmlFor="st-token-name">Name this key</label>
        <div className="st-newtoken-row">
          <input id="st-token-name" className="mg-input" value={name} maxLength={120}
            placeholder="e.g. Laptop CLI" onChange={(e) => setName(e.target.value)} />
          <button className="ct-btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create key"}</button>
        </div>
      </form>

      {error && <div className="mg-error">{error}</div>}

      <div className="st-section">
        <h3>Active keys{active.length ? ` (${active.length})` : ""}</h3>
        {!active.length && (
          <div className="st-empty">
            No active keys. Create one above to connect the CLI, the VS Code extension or Thrallo Desktop.
          </div>
        )}
        <div className="st-rows">
          {active.map((token) => (
            <div className="st-row st-token" key={token.id}>
              <div className="st-token-meta">
                {renaming?.id === token.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="st-newtoken-row">
                    <input className="mg-input" autoFocus value={renaming.value} maxLength={120}
                      aria-label={`Rename ${token.name}`}
                      onChange={(e) => setRenaming({ id: token.id, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} />
                    <button className="ct-btn" disabled={!renaming.value.trim()}>Save</button>
                    <button type="button" className="ct-btn-quiet" onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <b>{token.name}</b>
                    <div className="ct-hint">
                      <code>{token.prefix}…</code>
                      {" · "}{(token.scopes || []).join(", ") || "runs"}
                      {" · created "}{formatBillingDate(token.createdAt) || "—"}
                      {" · "}{token.lastUsedAt ? `last used ${formatBillingDate(token.lastUsedAt)}` : "never used"}
                    </div>
                  </>
                )}
              </div>
              {renaming?.id !== token.id && (
                <div className="st-token-actions">
                  <button className="ct-btn-quiet" disabled={busy}
                    onClick={() => setRenaming({ id: token.id, value: token.name })}>Rename</button>
                  <button className="ct-btn-quiet ct-danger" disabled={busy}
                    onClick={() => revoke(token)}>Revoke</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {revoked.length > 0 && (
        <div className="st-section">
          <h3>Revoked</h3>
          {/* Kept visible rather than vanishing: seeing that a key was revoked, and when, is how
              someone confirms the one they were worried about is really dead. */}
          <div className="st-rows">
            {revoked.map((token) => (
              <div className="st-row st-token is-revoked" key={token.id}>
                <div className="st-token-meta">
                  <b>{token.name}</b>
                  <div className="ct-hint">
                    <code>{token.prefix}…</code> · revoked {formatBillingDate(token.revokedAt) || "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
