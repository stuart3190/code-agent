// Dashboard plan banner.
//
// Free accounts see where they stand and a one-click route to upgrading. Paid accounts see
// nothing at all — except when a downgrade is scheduled, where the point is the opposite: tell
// them before the day it lands, and make undoing it a single button.

import React, { useState } from "react";
import { formatBillingDate } from "./planState.js";

// Product copy, kept in one place so it can be changed without hunting through markup.
//
// NOTE: "faster builds" is not currently backed by anything in the product — every plan runs at
// MAX_CONCURRENT_BUILDS_PER_USER = 1 with no plan-based priority or queueing. Plans differ in
// runs, managed tokens and compute hours. Confirm this line before real customers see it.
const FREE_MESSAGE = "You're currently on the Free plan. Upgrade to Starter or Pro to unlock "
  + "higher limits, faster builds and more AI usage.";

export default function PlanBanner({ planState, onOpenPricing }) {
  const { subscription, isFree, pendingPlan, busy, choose, billing } = planState;
  const [notice, setNotice] = useState("");

  // Confirming an action outranks describing the state. Cancelling a scheduled change removes the
  // reason this banner existed, so without this the banner would simply vanish and the user would
  // be left unsure whether the click did anything.
  if (notice) {
    return (
      <div className="ct-planbar info" role="status">
        <div className="ct-planbar-text">{notice}</div>
      </div>
    );
  }

  // Nothing renders until the real state is known — a banner that appears and then vanishes is
  // worse than one that arrives a moment late.
  if (!subscription) return null;

  if (pendingPlan) {
    const currentName = billing?.plans?.find((p) => p.id === subscription.plan)?.name || subscription.plan;
    const when = subscription.pendingPlanAt
      ? formatBillingDate(subscription.pendingPlanAt, { year: false })
      : "your next billing date";
    return (
      <div className="ct-planbar info" role="status">
        <div className="ct-planbar-text">
          Your plan changes to <strong>{subscription.pendingPlanName || pendingPlan}</strong> on {when}. You keep {currentName} until then.
        </div>
        <button className="ct-btn" disabled={busy === subscription.plan}
          onClick={async () => {
            const message = await choose(subscription.plan);
            if (message) setNotice(message);
          }}>
          Keep Current Plan
        </button>
      </div>
    );
  }

  if (!isFree) return null;

  return (
    <div className="ct-planbar" role="status">
      <div className="ct-planbar-text">{FREE_MESSAGE}</div>
      <button className="ct-btn" onClick={onOpenPricing}>Upgrade Now</button>
    </div>
  );
}
