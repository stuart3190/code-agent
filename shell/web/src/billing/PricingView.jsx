// The /pricing page.
//
// Starter and Pro only — Free is where the visitor already is, and there is nothing to buy there.
// Every number shown comes from the server's plan catalogue, so the page cannot drift from what
// Stripe actually charges (scripts/stripe-live-check.mjs enforces that the catalogue matches Stripe).

import React, { useState } from "react";
import { PAID_PLANS } from "./planState.js";
import PlanBanner from "./PlanBanner.jsx";
import { formatNumber, formatCompact } from "../manage/shared.jsx";

const RANK = { free: 0, starter: 1, pro: 2 };

// Pro is the plan most teams end up on, so it is marked. The accent is a border and a faint tint —
// enough to draw the eye without the page reading as an advert.
const HIGHLIGHTED = "pro";

// One source for both the card bullets and the comparison table, so they can never disagree.
// `bullet` reads as a sentence; `label`/`value` are the column form.
const COMPARISON = [
  {
    label: "Builds per month",
    value: (p) => formatNumber(p.monthly.runs),
    bullet: (p) => `${formatNumber(p.monthly.runs)} builds a month`,
  },
  {
    label: "Managed AI tokens",
    value: (p) => formatCompact(p.monthly.managedTokens),
    bullet: (p) => `${formatCompact(p.monthly.managedTokens)} managed AI tokens`,
  },
  {
    label: "Sandbox compute",
    value: (p) => `${Math.round(p.monthly.computeSeconds / 3600)} hours`,
    bullet: (p) => `${Math.round(p.monthly.computeSeconds / 3600)} hours of sandbox compute`,
  },
];

export default function PricingView({ planState, onBack }) {
  const { billing, subscription, busy, error, choose } = planState;
  const [notice, setNotice] = useState("");
  const all = billing?.plans || [];
  const plans = all.filter((p) => PAID_PLANS.includes(p.id));
  const currentName = all.find((p) => p.id === subscription?.plan)?.name || subscription?.plan;

  // What the button on a given card should say. A paid subscriber can move in either direction and
  // must be told which way they are going; nobody may buy the plan they already have.
  function cta(planId) {
    if (subscription?.plan === planId) return { label: "Current Plan", disabled: true };
    if (subscription?.pendingPlan === planId) return { label: "Scheduled", disabled: true };
    if (busy === planId) return { label: "Opening…", disabled: true };
    const plan = plans.find((p) => p.id === planId);
    if (!plan?.priceApproved || !billing?.stripeConfigured) return { label: "Not yet available", disabled: true };
    if (!subscription || subscription.plan === "free") return { label: "Choose Plan", disabled: false };
    return RANK[planId] > RANK[subscription.plan]
      ? { label: "Upgrade", disabled: false }
      : { label: "Downgrade", disabled: false };
  }

  return (
    <div className="ct-pricing">
      <div className="ct-pricing-inner">
        <button className="ct-back" onClick={onBack} aria-label="Back to your projects">
          <span aria-hidden="true">←</span> Projects
        </button>

        <h1 className="ct-pricing-title">Choose your plan</h1>
        {subscription && (
          <div className="ct-pricing-current">
            Current Plan: <strong>{currentName}</strong>
          </div>
        )}
        <p className="ct-pricing-sub">
          Every plan runs the same agents on the same models. What changes is how much you can do
          each month.
        </p>

        {/* A scheduled downgrade is the one fact the cards cannot show, and the page it matters
            most on is this one. */}
        <PlanBanner planState={planState} showFreeUpgrade={false} />

        {error && <div className="mg-error">{error}</div>}
        {notice && <div className="mg-ok">{notice}</div>}

        {!billing && <div className="mg-card"><div className="ct-hint">Loading plans…</div></div>}

        <div className="ct-pricing-grid">
          {plans.map((plan) => {
            const action = cta(plan.id);
            const highlighted = plan.id === HIGHLIGHTED;
            const current = subscription?.plan === plan.id;
            return (
              <div className={`ct-pricecard ${current ? "current" : ""} ${highlighted ? "featured" : ""}`} key={plan.id}>
                {highlighted && <span className="ct-pricecard-badge">Most Popular</span>}
                <div className="ct-pricecard-head">
                  <span className="ct-pricecard-name">{plan.name}</span>
                  {current && <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />current</span>}
                  {subscription?.pendingPlan === plan.id && <span className="mg-pill"><span className="dot" style={{ background: "var(--warn)" }} />scheduled</span>}
                </div>
                <div className="ct-pricecard-price">
                  {plan.priceApproved
                    ? <><span className="amount">£{plan.priceGbp}</span><span className="per">/month</span></>
                    : <span className="per">pricing coming soon</span>}
                </div>
                <p className="ct-pricecard-desc">{plan.description}</p>
                <ul className="ct-pricecard-list">
                  {COMPARISON.map((row) => <li key={row.label}>{row.bullet(plan)}</li>)}
                </ul>
                <button className="ct-btn ct-pricecard-cta" disabled={action.disabled}
                  onClick={async () => {
                    const message = await choose(plan.id);
                    if (message) setNotice(message);
                  }}>
                  {action.label}
                </button>
              </div>
            );
          })}
        </div>

        {plans.length === 2 && (
          <div className="ct-compare">
            <div className="mg-label">Side by side</div>
            <table className="ct-compare-table">
              <thead>
                <tr>
                  <th scope="col"><span className="ct-hint">Each month</span></th>
                  {plans.map((p) => <th scope="col" key={p.id}>{p.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {plans.map((p) => <td key={p.id}>{row.value(p)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="ct-pricing-foot">
          Upgrades take effect immediately and you are charged only the difference for the rest of
          the billing period. Downgrades take effect at the end of the period you have already paid
          for. Cancel any time from Settings → Billing.
        </p>
      </div>
    </div>
  );
}
