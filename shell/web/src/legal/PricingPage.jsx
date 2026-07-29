import { useEffect, useState } from "react";
import { Logo } from "../auth/AuthGate.jsx";
import { SUPPORT_EMAIL } from "./LegalPage.jsx";

// Public /pricing — the launch-audit gap was that pricing existed only behind login. Numbers come
// LIVE from /api/config (which reads costModel — the single pricing truth); nothing is hardcoded
// here except copy. Public like the legal pages: routed pre-auth in main.jsx.

const FEATURES = {
  free: ["Build and iterate with AI", "Live previews", "Export your code any time"],
  paid: ["Everything in Free", "Publish to yourname.app.buildr101.com", "Credits refresh monthly"],
  domains: ["Connect your own custom domain"],
};

export default function PricingPage() {
  const [config, setConfig] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch((e) => setErr(e.message));
  }, []);

  const tiers = (config?.tiers || []).filter((t) => t.managed);
  const topup = config?.topupGbpPerCredit;
  const welcome = config?.welcomeCredits;

  return (
    <div className="min-h-full overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-lg font-semibold tracking-tight text-slate-100 font-display">Buildr101</span>
          </a>
          <a href="/" className="btn-primary">Start building</a>
        </div>

        <h1 className="mt-12 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-100 font-display">
          Simple, credit-based pricing
        </h1>
        <p className="mt-3 text-sm text-slate-400 max-w-xl leading-relaxed">
          Building is metered in credits{config ? ` (1 credit ≈ ${(config.tokensPerCredit / 1000).toFixed(0)}k
          tokens of AI work)` : ""}. Start free — no card needed — and pick a plan when you&rsquo;re
          ready to publish.
        </p>

        {err && <div className="mt-8 text-sm text-red-400">Couldn&rsquo;t load live pricing: {err}</div>}

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card
            name="Free"
            price="£0"
            blurb={welcome ? `${welcome} welcome credits included` : "Welcome credits included"}
            features={FEATURES.free}
            cta="Create account"
          />
          {tiers.map((t) => (
            <Card
              key={t.id}
              name={t.name}
              price={`£${t.gbpPerMonth}`}
              per="/month"
              highlight={t.id === "pro"}
              blurb={`${t.bundledCredits.toLocaleString()} credits every month`}
              features={t.id === "starter" ? FEATURES.paid : [...FEATURES.paid, ...FEATURES.domains]}
              footnote={t.effectiveGbpPerCredit ? `≈ ${(t.effectiveGbpPerCredit * 100).toFixed(1)}p per credit` : null}
              cta={`Get ${t.name}`}
            />
          ))}
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 text-sm text-slate-400">
          <div className="panel p-5">
            <div className="text-slate-200 font-medium">Need more in a busy month?</div>
            <p className="mt-1.5 leading-relaxed">
              Top up any time{topup ? ` at £${topup.toFixed(2)} per credit` : ""} — top-up credits
              never expire. Plan bundles refresh monthly (unused credits roll over up to a cap).
            </p>
          </div>
          <div className="panel p-5">
            <div className="text-slate-200 font-medium">Bring your own key</div>
            <p className="mt-1.5 leading-relaxed">
              Have your own AI provider account? Add your API key in Settings and builds run on it
              directly — no platform credits used.
            </p>
          </div>
        </div>

        <p className="mt-6 text-xs text-slate-500">
          All prices in GBP. Cancel or switch plans any time in the app — see the{" "}
          <a className="text-amber-soft hover:underline" href="/refunds">Refund Policy</a>.
        </p>

        <footer className="mt-12 pt-6 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <a className="hover:text-slate-300" href="/support">Support</a>
          <a className="hover:text-slate-300" href="/terms">Terms of Service</a>
          <a className="hover:text-slate-300" href="/privacy">Privacy Policy</a>
          <a className="hover:text-slate-300" href="/refunds">Refund Policy</a>
          <a className="hover:text-slate-300" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </footer>
      </div>
    </div>
  );
}

function Card({ name, price, per, blurb, features, footnote, cta, highlight }) {
  return (
    <div className={`panel p-5 flex flex-col ${highlight ? "border-amber/50" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-200">{name}</div>
        {highlight && <span className="tag bg-amber/15 text-amber-soft">Popular</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight text-slate-100 font-display">{price}</span>
        {per && <span className="text-xs text-slate-500">{per}</span>}
      </div>
      <div className="mt-1 text-xs text-amber-soft">{blurb}</div>
      <ul className="mt-4 space-y-1.5 text-xs text-slate-400 flex-1">
        {features.map((f) => (
          <li key={f} className="flex gap-2"><span className="text-amber-soft">✓</span>{f}</li>
        ))}
      </ul>
      {footnote && <div className="mt-3 text-[11px] font-mono text-slate-600">{footnote}</div>}
      <a href="/" className={`mt-4 text-center ${highlight ? "btn-primary" : "btn-ghost"}`}>{cta}</a>
    </div>
  );
}
