// Post-payment confirmation.
//
// Stripe redirects the moment the card clears, but the plan is applied by the WEBHOOK, which
// arrives independently and usually a beat later. Reading the plan once on arrival would therefore
// show the customer "Free" seconds after they paid — the single worst moment to look broken.
//
// So this polls until the plan actually changes, and if it has not changed within the window it
// says so honestly rather than claiming an activation it cannot see.

import React, { useEffect, useState } from "react";
import { billingOverview } from "../lib/codeAgentApi.js";
import { formatNumber, formatCompact } from "../manage/shared.jsx";

const POLL_MS = 1_500;
const GIVE_UP_MS = 25_000;

export default function SuccessView({ onDone }) {
  const [billing, setBilling] = useState(null);
  const [settled, setSettled] = useState(false);   // the webhook has been seen
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let stop = false;
    const startedAt = Date.now();
    (async function poll() {
      while (!stop) {
        try {
          const next = await billingOverview();
          if (stop) return;
          setBilling(next);
          if (next?.subscription?.plan && next.subscription.plan !== "free") {
            setSettled(true);
            return;
          }
        } catch {
          // Keep polling; a transient failure here is not worth showing anyone.
        }
        if (Date.now() - startedAt > GIVE_UP_MS) { if (!stop) setTimedOut(true); return; }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }());
    return () => { stop = true; };
  }, []);

  const plan = billing?.plans?.find((p) => p.id === billing?.subscription?.plan);

  return (
    <div className="ct-pricing">
      <div className="ct-pricing-inner ct-success">
        {!settled && !timedOut && (
          <>
            <div className="ct-success-mark pending" aria-hidden="true" />
            <h1 className="ct-pricing-title">Confirming your payment…</h1>
            <p className="ct-pricing-sub">This usually takes a couple of seconds.</p>
          </>
        )}

        {settled && plan && (
          <>
            <div className="ct-success-mark" aria-hidden="true">✓</div>
            <h1 className="ct-pricing-title">Subscription activated</h1>
            <p className="ct-pricing-sub">
              You are now on <strong>{plan.name}</strong>
              {plan.priceApproved ? ` at £${plan.priceGbp} a month` : ""}. Your new monthly limits are
              live immediately.
            </p>
            <div className="ct-success-limits">
              <div><span className="v">{formatNumber(plan.monthly.runs)}</span><span className="k">builds a month</span></div>
              <div><span className="v">{formatCompact(plan.monthly.managedTokens)}</span><span className="k">managed AI tokens</span></div>
              <div><span className="v">{Math.round(plan.monthly.computeSeconds / 3600)}h</span><span className="k">sandbox compute</span></div>
            </div>
            <p className="ct-pricing-foot">
              A receipt is on its way from Stripe. You can change or cancel your plan any time from
              Settings → Billing.
            </p>
          </>
        )}

        {timedOut && (
          <>
            <div className="ct-success-mark" aria-hidden="true">✓</div>
            <h1 className="ct-pricing-title">Payment received</h1>
            {/* Deliberately not claiming the plan is live: this screen cannot see it yet. */}
            <p className="ct-pricing-sub">
              Your payment went through and your plan is being activated. It can take a minute to
              appear. Nothing further is needed from you — check Settings → Billing shortly, and
              contact us if it has not updated.
            </p>
          </>
        )}

        <button className="ct-btn ct-success-cta" onClick={onDone}>Return to dashboard</button>
      </div>
    </div>
  );
}
