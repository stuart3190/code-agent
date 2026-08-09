export const DESKTOP_LAUNCH_ACTIONS = Object.freeze([
  "open_local_workspace",
  "open_installed_desktop_project",
  "open_cloud_workspace",
  "open_portal",
  "manage_subscription",
  "recover_billing",
  "recover_suspended_workspace",
]);

export const LAUNCH_DECISION_STATES = Object.freeze([
  "allowed",
  "blocked_entitlement",
  "blocked_auth",
  "blocked_billing",
  "capability_unavailable",
  "requires_portal",
  "requires_reauthentication",
  "unsupported",
]);

function decision(action, state, reason, portalDestination = null) {
  return Object.freeze({ action, state, allowed: state === "allowed", reason, portalDestination });
}

function authBlock(authState) {
  if (["expired", "revoked", "error"].includes(authState)) return "requires_reauthentication";
  if (["signed_out", "authorizing", "awaiting_callback", "exchanging"].includes(authState)) return "blocked_auth";
  if (authState === "offline") return "capability_unavailable";
  return null;
}

export function evaluateLaunchAction(action, { authSnapshot, hostCapabilities, entitlement, usage } = {}) {
  if (!DESKTOP_LAUNCH_ACTIONS.includes(action)) return decision(action, "unsupported", "unknown_action");
  if (!authSnapshot || !hostCapabilities || !entitlement || !usage) throw new TypeError("Launch evaluation requires composed auth, host, entitlement, and usage state");

  if (action === "open_local_workspace") {
    return hostCapabilities.localFilesystem
      ? decision(action, "allowed", "local_filesystem_available")
      : decision(action, "capability_unavailable", "local_filesystem_unavailable");
  }
  if (action === "open_portal") return decision(action, "requires_portal", "portal_owned", "account");

  const authState = authBlock(authSnapshot.state);
  if (authState) return decision(action, authState, `auth_${authSnapshot.state}`, authState === "requires_reauthentication" ? "account" : null);

  if (action === "manage_subscription") return decision(action, "requires_portal", "subscription_is_portal_owned", "billing");
  if (action === "recover_billing") {
    return entitlement.state === "past_due"
      ? decision(action, "requires_portal", "billing_recovery_required", "recovery")
      : decision(action, "unsupported", "billing_recovery_not_required");
  }
  if (action === "recover_suspended_workspace") {
    return ["suspended", "recovery_only"].includes(entitlement.state)
      ? decision(action, "requires_portal", "workspace_recovery_required", "recovery")
      : decision(action, "unsupported", "workspace_recovery_not_required");
  }

  if (entitlement.freshness !== "fresh" || entitlement.state === "unknown") {
    return decision(action, "capability_unavailable", "entitlement_not_fresh");
  }
  if (entitlement.state === "past_due") return decision(action, "blocked_billing", "billing_recovery_required", "billing");
  if (["suspended", "recovery_only"].includes(entitlement.state)) {
    return decision(action, "requires_portal", "account_recovery_required", "recovery");
  }

  const requirement = action === "open_cloud_workspace"
    ? { host: "cloudWorkspace", resource: "cloudDesktop" }
    : { host: "localFilesystem", resource: "nativeManagedServices" };
  if (hostCapabilities[requirement.host] !== true) {
    return decision(action, "capability_unavailable", `${requirement.host}_unavailable`);
  }
  const grant = entitlement.resources[requirement.resource];
  if (!grant || grant.availability === "unknown") return decision(action, "capability_unavailable", `${requirement.resource}_unknown`);
  if (grant.availability !== "available") return decision(action, "blocked_entitlement", grant.reason || `${requirement.resource}_not_included`);
  if (action === "open_cloud_workspace") {
    const workspaceUsage = usage.resources.workspaceCompute;
    if (workspaceUsage.hardLimit && workspaceUsage.freshness !== "fresh") {
      return decision(action, "capability_unavailable", "workspace_compute_usage_not_fresh");
    }
    if (workspaceUsage.hardLimitReached) {
      return decision(action, "blocked_entitlement", "workspace_compute_limit_reached");
    }
  }
  return decision(action, "allowed", "requirements_satisfied");
}

export function evaluateDesktopLaunchActions(context) {
  return Object.freeze(Object.fromEntries(DESKTOP_LAUNCH_ACTIONS.map((action) => [action, evaluateLaunchAction(action, context)])));
}
