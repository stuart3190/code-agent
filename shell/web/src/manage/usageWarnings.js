// Usage warnings: quiet until 75%, amber at 90%, red at 100%. Plain module (no JSX) so
// the node test suite can verify the thresholds directly.

export function meterWarning(used, limit) {
  if (!limit) return null;
  const pct = (used / limit) * 100;
  if (pct >= 100) return { level: 100, tone: "var(--bad)", text: "Limit reached — new work pauses until the period resets or the plan changes." };
  if (pct >= 90) return { level: 90, tone: "var(--warn)", text: `${Math.floor(pct)}% used — nearly at the limit.` };
  if (pct >= 75) return { level: 75, tone: "var(--warn)", text: `${Math.floor(pct)}% used.` };
  return null;
}
