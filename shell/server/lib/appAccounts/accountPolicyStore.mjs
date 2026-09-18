// The application account policy the shell records for a build (WP4).
//
// The app-accounts Edge Function evaluates memberships against the policy stored for the app
// (app_account_policies); with no row it falls back to the default admin/member catalogue. The
// shell derives the policy from the TYPED contract — declared roles, the profile fields an
// account-shaped entity contributed — never from a role field on a business record, and writes
// it when the contract is persisted. The table is optional on a deployment (migration
// 20260918120000): an absent table is reported once and the build continues.

import { serviceClient } from "../supabase.mjs";
import { withOptionalTable } from "../schemaCapability.mjs";
import { buildPolicy } from "../../../../supabase/functions/app-accounts/policy.js";

export const ACCOUNT_POLICY_VERSION = 1;

const unique = (values) => [...new Set((values || []).filter(Boolean).map(String))];

/** The policy input a contract implies: roles from auth.roles, self-editable fields from the profile schema. */
export function accountPolicyFromContract(contract) {
  const roles = unique((contract?.auth?.roles || []).map((role) => String(role).trim().toLowerCase()));
  const profileFields = unique((contract?.ownership?.profileSchema || []).map((field) => field?.name || field));
  const policy = buildPolicy({ roles });
  return {
    version: ACCOUNT_POLICY_VERSION,
    roles: [...policy.roles],
    defaultRole: policy.defaultRole,
    adminRoles: [...policy.adminRoles],
    grants: Object.fromEntries(Object.entries(policy.grants).map(([role, actions]) => [role, [...actions]])),
    profileFields: profileFields.length ? profileFields : ["displayName"],
  };
}

export async function persistAppAccountPolicy(appId, policy, { client = serviceClient() } = {}) {
  if (!appId || !policy) return null;
  return withOptionalTable("app_account_policies", async () => {
    const { data, error } = await client.from("app_account_policies")
      .upsert({ app_id: appId, policy, updated_at: new Date().toISOString() }, { onConflict: "app_id" })
      .select("app_id").single();
    if (error) throw new Error(`account policy persist: ${error.message}`);
    return data;
  }, null);
}
