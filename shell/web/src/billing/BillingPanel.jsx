import { useState } from "react";
import { checkout } from "../lib/api.js";

// Billing UI on the LIVE Phase 4 ledger. Reads balance (client-side, RLS-scoped) and offers the
// proven Stripe (test-mode) checkout paths. Every price string comes from /api/config -> costModel
// TIERS; nothing is hardcoded or re-derived here.
export default function BillingPanel({ config, balance, onRefresh, tier, collapsed, onToggle }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [topup, setTopup] = useState(100);

  const managed = (config?.tiers || []).filter((t) => t.managed);
  const valuePerCredit = managed.find((t) => t.id === tier)?.effectiveGbpPerCredit ?? config?.topupGbpPerCredit ?? 0;
  const total = balance?.total ?? 0;

  if (collapsed) {
    return (
      <aside className="h-full border-l border-line bg-ink-900/60 flex flex-col items-center py-3 gap-2">
        <button onClick={onToggle} title="Expand billing panel" aria-label="Expand billing panel"
          className="p-2 rounded-lg border border-line text-slate-400 hover:text-slate-100 hover:bg-ink-850">
          <ChevronLeft />
        </button>
        <div className="font-mono text-amber-soft text-sm tabular-nums mt-1" title={`${total.toFixed(2)} credits`}>{total.toFixed(0)}</div>
        <div className="text-[9px] font-mono uppercase tracking-wider text-slate-600">cr</div>
      </aside>
    );
  }

  async function go(args, key) {
    setBusy(key); setErr(null);
    try {
      const { url } = await checkout(args);
      if (url) window.location.href = url; // Stripe Checkout (test mode)
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  }

  return (
    <aside className="h-full border-l border-line bg-ink-900/60 overflow-auto">
      {/* balance meter */}
      <div className="p-4 border-b border-line">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={onToggle} title="Collapse panel" aria-label="Collapse billing panel"
              className="text-slate-500 hover:text-slate-200"><ChevronRight /></button>
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Credits</span>
          </div>
          <button className="text-[11px] text-slate-500 hover:text-amber" onClick={onRefresh}>Refresh</button>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold font-mono text-slate-100 tabular-nums">{total.toFixed(2)}</span>
          <span className="text-xs text-slate-500">≈ £{(total * valuePerCredit).toFixed(2)} of building</span>
        </div>
        <div className="mt-2 flex gap-3 text-[11px] font-mono text-slate-500">
          <span>bundle {(balance?.bundle ?? 0).toFixed(1)}</span>
          <span>top-up {(balance?.topup ?? 0).toFixed(1)}</span>
          {tier && <span className="tag bg-amber/15 text-amber-soft">{tier}</span>}
        </div>
      </div>

      {/* tiers */}
      <div className="p-4 border-b border-line">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2">Plans</div>
        <div className="space-y-2">
          {managed.map((t) => {
            const isCurrent = tier === t.id;
            // With ANY active subscription, other tiers are disabled too — a second checkout
            // would create a concurrent Stripe subscription, not a switch. (Plan switching with
            // proration is future work; until then: cancel first, then subscribe.)
            const blocked = !!tier && !isCurrent;
            return (
              <div key={t.id} className={`panel p-3 ${isCurrent ? "border-amber/40" : ""}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-100">{t.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      £{t.gbpPerMonth}/mo · {t.bundledCredits} cr · £{t.effectiveGbpPerCredit?.toFixed(3)}/cr
                    </div>
                  </div>
                  {isCurrent ? (
                    <span className="tag bg-amber/15 text-amber-soft">Current plan ✓</span>
                  ) : (
                    <button className="btn-primary text-xs" disabled={busy === t.id || blocked}
                      title={blocked ? "You already have a plan — plan switching is coming; cancel first to change." : undefined}
                      onClick={() => go({ tierId: t.id }, t.id)}>
                      {busy === t.id ? "Opening checkout…" : "Subscribe"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* top-up */}
      <div className="p-4 border-b border-line">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2">Top-up</div>
        <div className="flex items-center gap-2">
          <input className="field font-mono" type="number" min="1" value={topup}
            onChange={(e) => setTopup(Number(e.target.value))} />
          <button className="btn-ghost text-xs whitespace-nowrap" disabled={busy === "topup" || !(topup > 0)}
            onClick={() => go({ credits: topup }, "topup")}>
            {busy === "topup" ? "Opening checkout…" : `Buy · £${(topup * (config?.topupGbpPerCredit ?? 0)).toFixed(2)}`}
          </button>
        </div>
        <div className="text-[11px] text-slate-500 mt-1 font-mono">£{config?.topupGbpPerCredit}/cr · rolls over freely</div>
      </div>

      {/* three modes */}
      <div className="p-4">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2">Provider modes</div>
        <div className="space-y-2">
          {(config?.modes || []).map((m, i) => (
            <div key={m.id} className="panel p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-100">{m.name}</span>
                <span className={`tag ${i === 2 ? "bg-amber/15 text-amber-soft" : "bg-ink-800 text-slate-400"}`}>
                  {i === 2 ? "active" : "available"}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1">{m.blurb}</div>
            </div>
          ))}
        </div>
      </div>

      {err && <div className="px-4 pb-4 text-xs text-red-400">{err}</div>}
    </aside>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
