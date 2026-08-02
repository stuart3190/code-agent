// Settings → Billing.
//
// Free accounts get the one thing they can act on: upgrading. Paid accounts get the facts they
// might actually need — what they are on, whether payment is healthy, when it renews — and a route
// into Stripe's Customer Portal, which is where cancellation and card changes live.

import React, { useState } from "react";
import { billingPortal } from "../lib/codeAgentApi.js";
import { formatBillingDate as formatDate } from "./planState.js";

const STATUS_TEXT = {
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
};

export default function BillingSettings({ planState, onUpgrade }) {
  const { billing, subscription } = planState;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Until billing has loaded there is nothing truthful to show, and guessing "Free" would be
  // wrong for exactly the people who care most.
  if (!subscription) return null;

  const planName = billing?.plans?.find((p) => p.id === subscription.plan)?.name || subscription.plan;
  const isFree = subscription.plan === "free";
  const renews = formatDate(subscription.currentPeriodEnd);
  const changesOn = formatDate(subscription.pendingPlanAt);

  async function openPortal() {
    setBusy(true); setError("");
    try {
      const { url } = await billingPortal();
      window.location.href = url;
    } catch (e) {
      setError(e.message || "Could not open the billing portal. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="ct-set-group">
      <div className="ct-set-label">Billing</div>

      <div className="ct-set-row">
        <div>
          {planName} plan
          <div className="ct-hint">
            {isFree
              ? "No payment details held. Upgrade any time."
              : subscription.pendingPlan
                ? `Changes to ${subscription.pendingPlanName || subscription.pendingPlan}${changesOn ? ` on ${changesOn}` : ""}.`
                : renews ? `Renews ${renews}.` : "Managed by Stripe."}
          </div>
        </div>
        {isFree
          ? <button className="ct-btn" onClick={onUpgrade}>Upgrade</button>
          : (
            <button className="ct-btn-quiet" disabled={busy} onClick={openPortal}>
              {busy ? "Opening…" : "Manage Subscription"}
            </button>
          )}
      </div>

      {!isFree && (
        <div className="ct-set-row">
          <div>
            Status
            <div className="ct-hint">
              {subscription.status === "past_due"
                ? "We could not take the last payment. Update your card in the billing portal to avoid losing access."
                : "Cancel, change your card or download invoices in the billing portal."}
            </div>
          </div>
          <span className="mg-pill">
            <span className="dot" style={{ background: subscription.status === "active" ? "var(--good)" : "var(--warn)" }} />
            {STATUS_TEXT[subscription.status] || subscription.status}
          </span>
        </div>
      )}

      {error && <div className="mg-error">{error}</div>}
    </div>
  );
}
