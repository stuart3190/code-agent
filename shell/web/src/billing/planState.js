// Shared plan state for the dashboard banner and the pricing page.
//
// Both surfaces need the same answer to "what is this account on, and is anything scheduled?", and
// both act on it by calling the same endpoint. Keeping it in one hook means the banner cannot
// disagree with the pricing page after a change.

import { useCallback, useEffect, useState } from "react";
import { billingOverview, selectPlan } from "../lib/codeAgentApi.js";

export const PAID_PLANS = ["starter", "pro"];

// Billing dates render in UTC, deliberately. Stripe defines period boundaries in UTC and they land
// on midnight, so rendering in local time shows the PREVIOUS day to anyone west of Greenwich — a
// renewal date that disagrees with the Stripe invoice is a support ticket. The locale is pinned for
// the same reason the amounts are: everyone must see the same billing fact.
export function formatBillingDate(iso, { year = true } = {}) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}

export function usePlanState() {
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setBilling(await billingOverview());
    } catch {
      // Billing is informational here. A failed load must never block the dashboard, so the
      // banner simply stays hidden rather than showing a broken state.
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Returns the message to show, or null when the browser is being sent to Stripe Checkout.
  const choose = useCallback(async (planId) => {
    setBusy(planId); setError("");
    try {
      const result = await selectPlan(planId);
      if (result.url) { window.location.href = result.url; return null; }
      setBilling(result);
      return result.planChange?.message || `You are on the ${planId} plan.`;
    } catch (e) {
      setError(e.message || "That did not go through. Please try again.");
      return null;
    } finally {
      setBusy("");
    }
  }, []);

  const subscription = billing?.subscription || null;
  return {
    billing,
    subscription,
    plan: subscription?.plan || null,
    isFree: subscription?.plan === "free",
    pendingPlan: subscription?.pendingPlan || null,
    busy,
    error,
    choose,
    refresh,
  };
}
