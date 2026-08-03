// Domains in Project Settings.
//
// The Thrallo address is shown first and is never removable — it keeps working whatever happens to
// a custom domain, and saying so plainly is what stops "add a domain" feeling risky.
//
// Every DNS value is copyable, because retyping a token by hand is how verification fails.

import React, { useCallback, useEffect, useState } from "react";
import {
  listDomains, addDomain, verifyDomain, retryDomain, removeDomain,
} from "../lib/codeAgentApi.js";
import { displayUrl, relativeTime } from "./publishLifecycle.js";
import {
  DOMAIN_LABEL as STATUS_TEXT, domainExplanation, sslExplanation, SSL_LABEL, isDomainLive,
} from "../../../shared/operationalState.mjs";

function CopyValue({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ct-dns-value">
      <code>{value}</code>
      <button className="ct-pubrow-btn" onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2_000);
        } catch { setCopied(false); }
      }}>{copied ? "Copied" : "Copy"}</button>
    </span>
  );
}

export default function DomainsSection({ site }) {
  const [domains, setDomains] = useState([]);
  const [allowance, setAllowance] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const projectId = site?.projectId;

  const apply = useCallback((result) => {
    setDomains(result.domains || []);
    setAllowance(result.allowance || null);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    try { apply(await listDomains(projectId)); } catch { /* section simply stays empty */ }
    setLoaded(true);
  }, [projectId, apply]);

  useEffect(() => { load(); }, [load]);

  // While anything is still working towards Active, keep the panel current without the user
  // pressing Retry — DNS propagates on its own schedule.
  useEffect(() => {
    if (!domains.some((d) => d.status === "pending_dns" || d.status === "verifying")) return undefined;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [domains, load]);

  async function run(label, fn) {
    setBusy(label); setError("");
    try { apply(await fn()); } catch (e) { setError(e.message || "That didn't work. Please try again."); }
    finally { setBusy(""); }
  }

  const atLimit = allowance && allowance.limit !== null && allowance.used >= allowance.limit;
  const noPlan = allowance && allowance.limit === 0;

  return (
    <div className="ct-set-group">
      <div className="ct-set-label">Domains</div>

      {/* The default address, always present, never removable. */}
      <div className="ct-set-row">
        <div>
          {displayUrl(site.url)}
          <div className="ct-hint">Your Thrallo address. Always active — adding a custom domain never replaces it.</div>
        </div>
        <span className="ct-live-badge st-published"><span className="dot" aria-hidden="true" />Active</span>
      </div>

      {domains.map((d) => (
        <div className="ct-domain" key={d.domain}>
          <div className="ct-domain-head">
            <div>
              <strong>{d.domain}</strong>
              <div className="ct-hint">
                {domainExplanation(d.status)}
                {d.lastCheckedAt && ` · checked ${relativeTime(d.lastCheckedAt)}`}
              </div>
            </div>
            <span className={`ct-live-badge dn-${d.status}`}>
              <span className="dot" aria-hidden="true" />{STATUS_TEXT[d.status]}
            </span>
          </div>

          {d.status === "active" && (
            <div className="ct-hint">
              {SSL_LABEL[d.sslStatus] || SSL_LABEL.pending} — {sslExplanation(d.sslStatus, d.status)}
            </div>
          )}
          {d.failureReason && d.status !== "active" && <div className="ct-hint">{d.failureReason}</div>}

          {d.status !== "active" && (
            <div className="ct-dns">
              {d.records.map((r) => (
                <div className="ct-dns-row" key={`${r.type}-${r.name}`}>
                  <span className="ct-dns-type">{r.type}</span>
                  <div className="ct-dns-pair">
                    <CopyValue value={r.name} />
                    <CopyValue value={r.value} />
                    <span className="ct-hint">{r.note}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="ct-pubrow-actions">
            {d.status === "active" && (
              <a className="ct-pubrow-btn" href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer">Open</a>
            )}
            {d.status === "failed" ? (
              <button className="ct-pubrow-btn accent" disabled={busy === d.domain}
                onClick={() => run(d.domain, () => retryDomain(projectId, d.domain))}>
                {busy === d.domain ? "Retrying…" : "Retry verification"}
              </button>
            ) : d.status !== "active" && (
              <button className="ct-pubrow-btn" disabled={busy === d.domain}
                onClick={() => run(d.domain, () => verifyDomain(projectId, d.domain))}>
                {busy === d.domain ? "Checking…" : "Check now"}
              </button>
            )}
            <button className="ct-pubrow-btn" disabled={busy === d.domain}
              onClick={() => run(d.domain, () => removeDomain(projectId, d.domain))}>
              Remove
            </button>
          </div>
        </div>
      ))}

      {loaded && (
        <div className="ct-set-row">
          <div style={{ flex: 1, minWidth: 200 }}>
            <input className="ct-domain-input" value={input} placeholder="yourbusiness.com"
              aria-label="Custom domain" disabled={noPlan || busy === "add"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) run("add", () => addDomain(projectId, input.trim()).then((r) => { setInput(""); return r; })); }} />
            <div className="ct-hint">
              {noPlan
                ? "Custom domains are included on Starter and Pro."
                : allowance?.limit === null
                  ? "Your plan includes unlimited custom domains."
                  : allowance
                    ? `${allowance.used} of ${allowance.limit} custom domain${allowance.limit === 1 ? "" : "s"} used.`
                    : ""}
            </div>
          </div>
          <button className="ct-btn" disabled={!input.trim() || noPlan || atLimit || busy === "add"}
            onClick={() => run("add", () => addDomain(projectId, input.trim()).then((r) => { setInput(""); return r; }))}>
            {busy === "add" ? "Adding…" : "Add domain"}
          </button>
        </div>
      )}

      {error && <div className="mg-error">{error}</div>}
    </div>
  );
}
