// API tokens — Settings drill-in. Create-shows-once, revoke; the secret never re-appears.

import React, { useEffect, useState } from "react";
import { createApiToken, listApiTokens, revokeApiToken } from "../lib/codeAgentApi.js";
import { SkeletonRows, useCopy } from "./shared.jsx";

export default function TokensSettings() {
  const [tokens, setTokens] = useState(null); // null = loading
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();

  useEffect(() => {
    listApiTokens().then((r) => setTokens(r.tokens || [])).catch((e) => { setError(e.message); setTokens([]); });
  }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError(""); setFresh(null);
    try {
      const result = await createApiToken(name.trim());
      setTokens(result.tokens);
      setFresh(result.token); // the raw secret string — shown exactly once
      setName("");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true); setError("");
    try { setTokens((await revokeApiToken(id)).tokens); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const active = (tokens || []).filter((token) => !token.revokedAt);

  return (
    <div>
      <h3>API tokens</h3>
      <p className="mg-sub">For the CLI, the editor extension, and Thrallo Desktop. A token is shown exactly once.</p>
      {error && <div className="mg-error">{error}</div>}
      {fresh && (
        <div className="mg-card">
          <div style={{ fontWeight: 700, fontSize: 14 }}>Copy it now — it won't be shown again</div>
          <button className="mg-mono" style={{ marginTop: 8, padding: "8px 10px", cursor: "pointer", display: "block", width: "100%", textAlign: "left" }}
            title="Copy to clipboard" onClick={() => copy(fresh)}>{fresh}</button>
          <div className="ct-actions">
            <button className="ct-btn" onClick={() => copy(fresh)}>{copied ? "Copied ✓" : "Copy"}</button>
            <button className="ct-btn-quiet" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input className="mg-input" placeholder="Name, e.g. desktop" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="ct-btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
      </form>
      <div className="mg-card">
        {tokens === null && <SkeletonRows rows={2} />}
        {tokens !== null && !active.length && (
          <div className="ct-hint">No active tokens yet — create one above to connect the CLI, the VS Code extension, or Thrallo Desktop.</div>
        )}
        {active.map((token) => (
          <div className="mg-row" key={token.id}>
            <div>{token.name}<div className="ct-hint">{token.prefix}… · {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "never used"}</div></div>
            <button className="ct-btn-quiet" disabled={busy} onClick={() => revoke(token.id)}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}
