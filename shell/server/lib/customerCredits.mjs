import { createBudgetLedger } from "./appBuild/budgetLedger.mjs";
import { serviceClient } from "./supabase.mjs";
import { thralloTopupConfigured } from "./subscriptionBilling.mjs";

export async function customerCredits(owner, {
  client = serviceClient(),
  balanceResolver = (id) => createBudgetLedger({ client }).getBalance(id),
} = {}) {
  const balance = await balanceResolver(owner);
  const holds = { included: 0, purchased: 0 };
  for (const table of [
    "bv2_model_reservations",
    "ca_lead_model_reservations",
    "ca_direct_model_reservations",
  ]) {
    const { data, error } = await client.from(table)
      .select("included_reserved_credits,purchased_reserved_credits")
      .eq("owner", owner).eq("state", "held");
    if (error) throw new Error(`read ${table} customer holds: ${error.message}`);
    for (const row of data || []) {
      holds.included += Number(row.included_reserved_credits || 0);
      holds.purchased += Number(row.purchased_reserved_credits || 0);
    }
  }
  const includedRemaining = Math.max(0, Number(balance.included ?? balance.bundle ?? 0) - holds.included);
  const purchasedRemaining = Math.max(0, Number(balance.purchased ?? balance.topup ?? 0) - holds.purchased);
  return {
    includedRemaining,
    purchasedRemaining,
    reserved: holds.included + holds.purchased,
    totalAvailable: includedRemaining + purchasedRemaining,
    purchaseAvailable: thralloTopupConfigured(),
  };
}
