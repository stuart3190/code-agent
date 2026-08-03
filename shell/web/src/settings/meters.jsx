// One meter, used everywhere a budget is shown.
//
// There were two before — UsageView drew its own and the Settings sheet drew a second, simpler one
// with no warning thresholds at all. The same account could be at 94% of its token allowance and
// see an amber warning in one place and a plain grey bar in the other.
//
// The thresholds themselves stay in usageWarnings.js, which is a plain module so the node suite can
// assert them without a renderer.

import React from "react";
import { meterWarning } from "../manage/usageWarnings.js";

export const formatTokens = (n) => {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
  return String(value);
};

export const formatCount = (n) => Number(n || 0).toLocaleString("en-GB");

// Compute is metered in seconds; hours are what a person can picture.
export const formatCompute = (seconds) => {
  const value = Number(seconds) || 0;
  if (value < 90) return `${Math.round(value)}s`;
  if (value < 5_400) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(value >= 36_000 ? 0 : 1)}h`;
};

/**
 * A budget, as a bar.
 *
 * Shows used, limit AND remaining. "18k of 20k" makes someone do the subtraction to answer the
 * question they actually have, which is how much is left.
 */
export function Meter({ label, used, limit, format = formatCount, unlimited = false, hint = null }) {
  const usedValue = Math.max(0, Number(used) || 0);
  const limitValue = Number(limit) || 0;
  const warning = unlimited ? null : meterWarning(usedValue, limitValue);
  const pct = limitValue ? Math.min(100, Math.round((usedValue / limitValue) * 100)) : 0;
  const remaining = Math.max(0, limitValue - usedValue);
  const tone = warning?.level >= 100 ? "var(--bad)" : warning ? "var(--warn)" : null;

  return (
    <div className="st-meter">
      <div className="st-meter-head">
        <span className="st-meter-label">{label}</span>
        <span className="st-meter-figure">
          {unlimited ? format(usedValue) : <>{format(usedValue)} <span className="st-meter-of">of</span> {format(limitValue)}</>}
        </span>
      </div>
      <div className="st-meter-track" role="progressbar" aria-label={`${label} used`}
        aria-valuenow={unlimited ? undefined : pct} aria-valuemin={0} aria-valuemax={100}
        aria-valuetext={unlimited ? "Not limited" : `${pct}% used, ${format(remaining)} remaining`}>
        <i style={{ width: `${unlimited ? 0 : Math.max(pct, usedValue ? 2 : 0)}%`, ...(tone ? { background: tone } : {}) }} />
      </div>
      <div className="st-meter-foot">
        {unlimited
          ? <span className="ct-hint">Not limited on this account.</span>
          : <span className="ct-hint">{pct}% used · {format(remaining)} remaining</span>}
        {hint && <span className="ct-hint">{hint}</span>}
      </div>
      {warning && <div className="st-meter-warn" style={{ color: warning.tone }}>{warning.text}</div>}
    </div>
  );
}
