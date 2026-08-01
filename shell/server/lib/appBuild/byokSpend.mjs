// Rolling daily BYOK spend.
//
// Completes byokSafety's maxDailySpend, which shipped enforced but always received 0
// because nothing aggregated a real daily total. The source is `ai_requests` — one row per
// AI request, written by the diagnostics recorder at the moment usage is known — filtered
// to `byok = true` so a user's own provider spend is never mixed with Thrallo-managed usage.
//
// Double-counting is avoided by construction rather than by de-duplication:
//   * one row per completed request; a provider's INTERNAL retry bills once and is recorded
//     once (the adapter normalises usage before it reaches diagnostics)
//   * failed requests record zero usage and a null cost, so they contribute nothing
//   * a provider fallback writes rows under the NEW provider, so per-provider totals stay
//     separate and the lifecycle's other rounds are not re-counted
//   * repair rounds are separate real requests and SHOULD count — they are genuinely charged
//
// Fail-open: if the accounting query fails, this returns { available: false } and callers
// must not block on it. Refusing a user's own paid capacity because Thrallo's telemetry
// hiccuped would be the worse failure.

// Day boundaries. Default is a clearly defined UTC calendar day; an IANA timezone stored in
// the user's safeguards shifts the window to their local day.
export function dailyWindow({ now = new Date(), timezone = null } = {}) {
  if (!timezone) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000), timezone: "UTC" };
  }
  try {
    // Offset between UTC and the zone at `now`, applied to find the local midnight.
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    const offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000;
    const localMidnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMs;
    const start = new Date(localMidnightUtc);
    return { start, end: new Date(start.getTime() + 86_400_000), timezone };
  } catch {
    // An unknown timezone falls back to the documented UTC window rather than failing.
    return dailyWindow({ now });
  }
}

// Total BYOK spend in the current window. `provider` narrows to one connection; omitting it
// totals every BYOK provider the user has.
export async function dailyByokSpend({ client, owner, provider = null, now = new Date(), timezone = null }) {
  const window = dailyWindow({ now, timezone });
  try {
    let query = client.from("ai_requests")
      .select("provider, cost")
      .eq("owner", owner)
      .eq("byok", true)
      .gte("created_at", window.start.toISOString())
      .lt("created_at", window.end.toISOString());
    if (provider) query = query.eq("provider", provider);
    const { data, error } = await query;
    if (error) {
      console.error("[byok-spend] unavailable:", error.message);
      return { available: false, total: 0, byProvider: {}, window, reason: "accounting_unavailable" };
    }
    const byProvider = {};
    let total = 0;
    for (const row of data || []) {
      // Only requests the provider actually charged for: a null/zero cost is either a failed
      // request or one whose usage was never reported, and must not inflate the total.
      const cost = Number(row.cost);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      total += cost;
      const key = row.provider || "unknown";
      byProvider[key] = (byProvider[key] || 0) + cost;
    }
    return { available: true, total, byProvider, window };
  } catch (error) {
    console.error("[byok-spend] unavailable:", error.message);
    return { available: false, total: 0, byProvider: {}, window, reason: "accounting_unavailable" };
  }
}

// The daily verdict for a dispatch decision. Enforcement happens ONLY when the user enabled
// a limit, and never when accounting is unavailable.
export function dailyVerdict({ spend, limit, warnAt = null }) {
  if (limit == null) return { enforced: false, blocked: false, warn: false };
  if (!spend?.available) {
    return { enforced: false, blocked: false, warn: false, reason: "accounting_unavailable" };
  }
  const total = Number(spend.total) || 0;
  return {
    enforced: true,
    blocked: total >= limit,
    warn: warnAt != null && total >= warnAt && total < limit,
    total,
    limit,
    resetsAt: spend.window.end,
  };
}

export function dailyWarningMessage(verdict) {
  if (!verdict?.warn) return null;
  return "Heads up — today's spending on your own API account has passed the warning level you set. I'll keep going and stop at your daily limit.";
}
