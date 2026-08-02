// The /pricing page.
//
// Starter and Pro only — Free is where the visitor already is, and there is nothing to buy there.
// Every number shown comes from the server's plan catalogue, so the page cannot drift from what
// Stripe actually charges (scripts/stripe-live-check.mjs enforces that the catalogue matches Stripe).

import React, { useState } from "react";
import { PAID_PLANS } from "./planState.js";
import { formatNumber, formatCompact } from "../manage/shared.jsx";

function features(plan) {
  return [
    `${formatNumber(plan.monthly.runs)} builds a month`,
    `${formatCompact(plan.monthly.managedTokens)} managed AI tokens`,
    `${Math.round(plan.monthly.computeSeconds / 3600)} hours of sandbox compute`,
  ];
}

export default function PricingView({ planState, onBack }) {
  const { billing, subscription, busy, error, choose } = planState;
  const [notice, setNotice] = useState("");
  const plans = (billing?.plans || []).filter((p) => PAID_PLANS.includes(p.id));
  const rank = { free: 0, starter: 1, pro: 2 };

  return (
    <div className="ct-pricing">
      <div className="ct-pricing-inner">
        <button className="ct-back" onClick={onBack} aria-label="Back to your projects">
          <span aria-hidden="true">←</span> Projects
        </button>

        <h1 className="ct-pricing-title">Choose your plan</h1>
        <p className="ct-pricing-sub">
          Every plan runs the same agents on the same models. What changes is how much you can do
          each month.
        </p>

        {error && <div className="mg-error">{error}</div>}
        {notice && <div className="mg-ok">{notice}</div>}

        {!billing && <div className="mg-card"><div className="ct-hint">Loading plans…</div></div>}

        <div className="ct-pricing-grid">
          {plans.map((plan) => {
            const current = subscription?.plan === plan.id;
            const scheduled = subscription?.pendingPlan === plan.id;
            const direction = subscription && rank[plan.id] < rank[subscription.plan] ? "Downgrade" : "Choose Plan";
            return (
              <div className={`ct-pricecard ${current ? "current" : ""}`} key={plan.id}>
                <div className="ct-pricecard-head">
                  <span className="ct-pricecard-name">{plan.name}</span>
                  {current && <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />current</span>}
                  {scheduled && <span className="mg-pill"><span className="dot" style={{ background: "var(--warn)" }} />scheduled</span>}
                </div>
                <div className="ct-pricecard-price">
                  {plan.priceApproved
                    ? <><span className="amount">£{plan.priceGbp}</span><span className="per">/month</span></>
                    : <span className="per">pricing coming soon</span>}
                </div>
                <p className="ct-pricecard-desc">{plan.description}</p>
                <ul className="ct-pricecard-list">
                  {features(plan).map((f) => <li key={f}>{f}</li>)}
                </ul>
                <button className="ct-btn ct-pricecard-cta"
                  disabled={current || scheduled || busy === plan.id || !plan.priceApproved || !billing?.stripeConfigured}
                  onClick={async () => {
                    const message = await choose(plan.id);
                    if (message) setNotice(message);
                  }}>
                  {current ? "Your plan"
                    : scheduled ? "Scheduled"
                      : busy === plan.id ? "Opening…"
                        : !plan.priceApproved || !billing?.stripeConfigured ? "Not yet available"
                          : direction}
                </button>
              </div>
            );
          })}
        </div>

        <p className="ct-pricing-foot">
          Upgrades take effect immediately and you are charged only the difference for the rest of
          the billing period. Downgrades take effect at the end of the period you have already paid
          for. Cancel any time from Settings → Billing.
        </p>
      </div>
    </div>
  );
}
