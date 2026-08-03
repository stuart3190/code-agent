// Settings → Billing.
//
// One place with the plan, the price, what happens next and when, and every action that changes
// any of it. Before this, upgrading lived on a pricing page, cancelling was only possible inside
// Stripe's portal, and the sheet's billing row could tell someone their plan "renews" on the exact
// date it was in fact ending.
//
// Stripe's portal is still where invoices, receipts and payment methods live — rebuilding those
// would be work for no gain. What does NOT go through the portal is cancellation: portal
// cancellation is an account-wide Stripe setting, and this Stripe account is shared with another
// product, so enabling it there would change that product too.

import React, { useState } from "react";
import { billingPortal, selectPlan, setCancellation } from "../lib/codeAgentApi.js";
import { formatBillingDate } from "../billing/planState.js";

const STATUS = {
  active: { label: "Active", tone: "good" },
  past_due: { label: "Payment overdue", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const price = (plan) => (plan.priceGbp === 0 ? "Free"
  : plan.priceGbp ? `£${plan.priceGbp}/month` : "Price to be announced");

export default function BillingTab({ data, onChanged, onConfirm, showToast }) {
  const { subscription, plans, stripeConfigured, plan } = data;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const isFree = subscription.plan === "free";
  const paid = !isFree && subscription.stripeManaged;
  const status = STATUS[subscription.status] || { label: subscription.status, tone: "muted" };
  const periodEnd = formatBillingDate(subscription.currentPeriodEnd);
  const pendingAt = formatBillingDate(subscription.pendingPlanAt);

  // What the period end MEANS is decided on the SERVER and read here, so this panel cannot say
  // "renews" about a subscription that is ending.
  const NEXT = {
    renews: periodEnd && `Renews ${periodEnd}.`,
    ends: periodEnd && `Ends ${periodEnd}. Until then nothing changes.`,
    changes: pendingAt && `Changes to ${subscription.pendingPlanName || subscription.pendingPlan} on ${pendingAt}.`,
    resets: periodEnd && `Allowances reset ${periodEnd}.`,
  };
  const next = NEXT[subscription.periodEndMeans] || null;

  const run = async (key, action) => {
    setBusy(key); setError("");
    try {
      const result = await action();
      if (result?.url) { window.location.href = result.url; return; }
      if (result) onChanged(result);
      if (result?.message) showToast(result.message);
    } catch (e) {
      setError(e.message || "That did not go through. Nothing was changed.");
    } finally {
      setBusy("");
    }
  };

  const choose = (planId) => run(planId, () => selectPlan(planId));

  const cancel = () => onConfirm({
    title: `Cancel your ${plan.name} plan?`,
    body: `You keep ${plan.name} until ${periodEnd || "the end of the paid period"}, because you have already `
      + "paid for it. After that this account moves to Free, and its allowances drop to Free limits. "
      + "Your projects and published sites are not deleted.",
    confirmLabel: "Cancel plan",
    destructive: true,
    onConfirm: () => run("cancel", () => setCancellation(true)),
  });

  return (
    <div className="st-tab">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">
            {plan.name} plan
            <span className={`mg-pill tone-${status.tone}`}>
              <span className="dot" />{status.label}
            </span>
          </div>
          <div className="ct-hint">
            {isFree ? "No payment details held." : price(plans.find((p) => p.id === subscription.plan) || plan)}
            {next ? ` ${next}` : ""}
          </div>
        </div>
      </div>

      {subscription.status === "past_due" && (
        <div className="st-notice tone-bad">
          <strong>Your last payment failed.</strong> Allowances are metered at Free limits until it
          succeeds. Update your card in the billing portal below.
        </div>
      )}
      {subscription.cancelAtPeriodEnd && (
        <div className="st-notice tone-warn">
          <strong>This plan is set to end{periodEnd ? ` on ${periodEnd}` : ""}.</strong> Nothing changes
          before then, and you can restart it at any time.
          <button className="ct-linkish" disabled={busy === "resume"}
            onClick={() => run("resume", () => setCancellation(false))}>
            {busy === "resume" ? "Restarting…" : "Keep my plan"}
          </button>
        </div>
      )}
      {subscription.pendingPlan && !subscription.cancelAtPeriodEnd && (
        <div className="st-notice">
          <strong>Moving to {subscription.pendingPlanName || subscription.pendingPlan}
            {pendingAt ? ` on ${pendingAt}` : ""}.</strong> Until then you keep {plan.name}, which you
          have already paid for.
        </div>
      )}
      {!stripeConfigured && (
        <div className="st-notice">
          Paid plans are not open for sign-up yet. Everything on Free keeps working.
        </div>
      )}

      <div className="st-section">
        <h3>Plans</h3>
        <div className="st-plans">
          {plans.map((p) => {
            const current = p.id === subscription.plan;
            const pending = p.id === subscription.pendingPlan;
            const canPick = stripeConfigured || p.id === "free";
            const rank = { free: 0, starter: 1, pro: 2 };
            const direction = rank[p.id] > rank[subscription.plan] ? "Upgrade"
              : rank[p.id] < rank[subscription.plan] ? "Downgrade" : null;
            return (
              <div key={p.id} className={`st-plan ${current ? "is-current" : ""}`}>
                <div className="st-plan-head">
                  <b>{p.name}</b>
                  {current && <span className="ct-badge tone-live">CURRENT</span>}
                  {pending && <span className="ct-badge tone-update">SCHEDULED</span>}
                </div>
                <div className="st-plan-price">{price(p)}</div>
                <p className="ct-hint">{p.description}</p>
                <ul className="st-plan-list">
                  <li>{p.monthly.runs.toLocaleString("en-GB")} builds</li>
                  <li>{(p.monthly.managedTokens / 1e6).toFixed(0)}M managed tokens</li>
                  <li>{Math.round(p.monthly.computeSeconds / 3600)}h sandbox compute</li>
                </ul>
                {current ? (
                  <span className="ct-hint st-plan-note">Your current plan</span>
                ) : direction && (
                  <button className={direction === "Upgrade" ? "ct-btn" : "ct-btn-quiet"}
                    disabled={!canPick || !!busy} onClick={() => choose(p.id)}>
                    {busy === p.id ? "Working…" : `${direction} to ${p.name}`}
                  </button>
                )}
                {/* An upgrade is immediate and prorated; a downgrade waits for the period the
                    customer has already paid for. Saying so before the click, not after. */}
                {!current && direction && (
                  <span className="ct-hint st-plan-note">
                    {direction === "Upgrade" ? "Takes effect immediately, prorated." : "Takes effect at the end of this period."}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="st-section">
        <h3>Payment</h3>
        <div className="st-rows">
          <div className="st-row">
            <div>
              Invoices, receipts and payment methods
              <div className="ct-hint">Handled by Stripe, where your card details are held.</div>
            </div>
            <button className="ct-btn-quiet" disabled={!paid || !!busy}
              onClick={() => run("portal", () => billingPortal())}>
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          </div>
          {!paid && (
            <p className="ct-hint st-note">
              There is no billing account yet — one is created with your first paid plan.
            </p>
          )}
          {paid && !subscription.cancelAtPeriodEnd && (
            <div className="st-row">
              <div>
                Cancel this plan
                <div className="ct-hint">
                  You keep {plan.name} until {periodEnd || "the end of the paid period"}. Nothing is deleted.
                </div>
              </div>
              <button className="ct-btn-quiet ct-danger" disabled={!!busy} onClick={cancel}>
                {busy === "cancel" ? "Cancelling…" : "Cancel plan"}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="mg-error">{error}</div>}
    </div>
  );
}
