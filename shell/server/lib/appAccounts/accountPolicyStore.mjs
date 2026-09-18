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

/**
 * The policy input a contract implies: roles from auth.roles, self-editable fields from the
 * profile schema, and (WP8) the settings keys the service may validate a write against.
 */
export function accountPolicyFromContract(contract, { settingsPlan = null } = {}) {
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
    ...(settingsPlan?.declarations?.length ? { settings: settingsSchemaFromPlan(settingsPlan) } : {}),
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

// ── WP8 — settings schema and audit configuration ────────────────────────────────────────────
//
// The app-accounts function needs two more facts about an application: which settings keys are
// declared (with their scope, type and default) and whether history is captured, with which
// fields treated as sensitive. Both are derived from the same typed contract that produced the
// policy, so the service can never validate a key the build did not declare, and no scope is
// inferred from a name at request time.

/** The compiled settings definitions the service validates against, keyed by setting. */
export function settingsSchemaFromPlan(settingsPlan) {
  const definitions = {};
  for (const row of settingsPlan?.declarations || []) {
    if (!row?.key) continue;
    definitions[row.key] = {
      key: row.key,
      scope: ["app", "user", "workspace"].includes(row.scope) ? row.scope : "app",
      ...(row.options ? { type: "enum", options: [...row.options].map(String) } : { type: row.type || "string" }),
      ...(row.default !== undefined ? { default: row.default } : {}),
      ...(row.sensitive === true ? { sensitive: true } : {}),
      version: 1,
    };
  }
  return { version: SETTINGS_SCHEMA_VERSION, definitions };
}

export const SETTINGS_SCHEMA_VERSION = 1;

/** Record the audit configuration for an application. Optional table; an absent one is not fatal. */
export async function persistAppAuditConfig(appId, { enabled = false, sensitiveFields = [] } = {}, { client = serviceClient() } = {}) {
  if (!appId) return null;
  return withOptionalTable("app_audit_config", async () => {
    const { data, error } = await client.from("app_audit_config")
      .upsert({ app_id: appId, enabled: enabled === true, sensitive_fields: unique(sensitiveFields), updated_at: new Date().toISOString() },
        { onConflict: "app_id" })
      .select("app_id").single();
    if (error) throw new Error(`audit config persist: ${error.message}`);
    return data;
  }, null);
}
