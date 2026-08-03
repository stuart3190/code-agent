// Settings → Usage → the parts most people never need.
//
// Spend guards and per-request accounting, ported from the old standalone UsageView so there is
// one usage surface rather than two. It is a separate module because it is also a separate
// download: this only loads when someone actually opens the disclosure, which most visits do not.

import React, { useEffect, useState } from "react";
import { updateBudgets, usageInsights, usageSummary } from "../lib/codeAgentApi.js";
import { SkeletonRows, formatCompact, formatNumber } from "../manage/shared.jsx";
import { formatCompute, formatCount, formatTokens } from "./meters.jsx";

const duration = (ms) => (ms == null ? "—"
  : ms >= 60_000 ? `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${Math.round(ms / 1000)}s`);

export default function UsageDetail({ subscription, onChanged, showToast }) {
  const [records, setRecords] = useState(null);
  const [insights, setInsights] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    usageSummary().then((r) => setRecords(r.records || [])).catch((e) => setError(e.message));
    // Insights are extra colour; unavailable is a state, not a failure of the section.
    usageInsights().then(setInsights).catch(() => setInsights({ unavailable: true }));
  }, []);

  return (
    <div className="st-detail">
      <SpendGuards subscription={subscription} onChanged={onChanged} showToast={showToast} onError={setError} />

      {error && <div className="mg-error">{error}</div>}

      {insights?.recentRequests?.length > 0 && (
        <>
          <h4>AI requests this period</h4>
          <div className="st-tablewrap">
            <table className="mg-table">
              <thead>
                <tr><th>When</th><th>Agent</th><th>Provider / model</th><th>In</th><th>Out</th><th>Cached</th><th>Time</th></tr>
              </thead>
              <tbody>
                {insights.recentRequests.map((r, i) => (
                  <tr key={i}>
                    <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                    <td>{r.agent || "—"}</td>
                    <td>{r.provider} / {r.model}</td>
                    <td>{formatCompact(r.inputTokens)}</td>
                    <td>{formatCompact(r.outputTokens)}</td>
                    <td>{formatCompact(r.cachedTokens)}</td>
                    <td>{duration(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h4>Run usage records</h4>
      {records === null && !error && <SkeletonRows rows={2} />}
      {records !== null && !records.length && (
        <div className="st-empty">No completed runs have recorded usage yet.</div>
      )}
      {records !== null && records.length > 0 && (
        <div className="st-tablewrap">
          <table className="mg-table">
            <thead><tr><th>Provider</th><th>Model</th><th>Input</th><th>Output</th></tr></thead>
            <tbody>
              {records.slice(0, 20).map((record) => (
                <tr key={record.id}>
                  <td>{record.provider}</td><td>{record.model}</td>
                  <td>{formatNumber(record.input_tokens)}</td>
                  <td>{formatNumber(record.output_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Personal caps below the plan's allowance.
 *
 * These can only ever TIGHTEN the plan — the server clamps them — so they are a spend guard rather
 * than a way to buy more. Said plainly, because a field labelled "Max builds" next to a plan
 * allowance otherwise reads as though it could raise it.
 */
function SpendGuards({ subscription, onChanged, showToast, onError }) {
  const overrides = subscription.overrides || {};
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(overrides.runs || "");
  const [tokens, setTokens] = useState(overrides.managedTokens || "");
  const [compute, setCompute] = useState(overrides.computeSeconds || "");
  const [busy, setBusy] = useState(false);
  const anySet = !!(overrides.runs || overrides.managedTokens || overrides.computeSeconds);

  const save = async () => {
    setBusy(true); onError("");
    try {
      onChanged(await updateBudgets({
        runs: runs === "" ? null : Number(runs),
        managedTokens: tokens === "" ? null : Number(tokens),
        computeSeconds: compute === "" ? null : Number(compute),
      }));
      showToast("Spend guards saved.");
      setOpen(false);
    } catch (e) {
      onError(e.message || "Those guards could not be saved.");
    } finally { setBusy(false); }
  };

  return (
    <div className="st-guards">
      <h4>Spend guards</h4>
      <p className="ct-hint">
        Your own cap, below the plan's allowance — useful for keeping a shared account predictable.
        They can only lower a limit, never raise it. Leave a field empty to use the plan's figure.
      </p>
      {anySet && !open && (
        <div className="ct-hint st-guards-current">
          Currently capped at{" "}
          {[
            overrides.runs && `${formatCount(overrides.runs)} builds`,
            overrides.managedTokens && `${formatTokens(overrides.managedTokens)} tokens`,
            overrides.computeSeconds && `${formatCompute(overrides.computeSeconds)} compute`,
          ].filter(Boolean).join(" · ")}.
        </div>
      )}
      {!open ? (
        <button className="ct-btn-quiet" onClick={() => setOpen(true)}>
          {anySet ? "Edit spend guards" : "Set spend guards"}
        </button>
      ) : (
        <div className="st-guards-form">
          <label>Max builds
            <input className="mg-input" type="number" min="1" value={runs}
              onChange={(e) => setRuns(e.target.value)} placeholder="Plan limit" />
          </label>
          <label>Max managed tokens
            <input className="mg-input" type="number" min="1" value={tokens}
              onChange={(e) => setTokens(e.target.value)} placeholder="Plan limit" />
          </label>
          <label>Max compute (seconds)
            <input className="mg-input" type="number" min="1" value={compute}
              onChange={(e) => setCompute(e.target.value)} placeholder="Plan limit" />
          </label>
          <div className="ct-actions">
            <button className="ct-btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save guards"}</button>
            <button className="ct-btn-quiet" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
