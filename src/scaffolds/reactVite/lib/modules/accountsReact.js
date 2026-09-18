// React bindings for the accounts, authorization and admin modules — platform infrastructure.
// State and functions only; no JSX. Presentation belongs to the application.

import { useEffect, useMemo } from "react";
import { useCapabilityAction, useCapabilityState } from "../capabilities/react.js";

/** The signed-in member's profile/membership state; loads on first use. */
export function useProfile(controller) {
  const state = useCapabilityState(controller);
  useEffect(() => { void controller?.ensure?.(); }, [controller]);
  return state;
}

/** { can(action, target?), allowedActions, role } re-evaluated when the account state changes. */
export function usePermissions(authorization, accountsController) {
  const account = useProfile(accountsController);
  return useMemo(() => ({
    can: (action, target = null) => authorization.can(action, target).allowed,
    explain: (action, target = null) => authorization.can(action, target),
    allowedActions: authorization.explainAllowedActions(),
    role: authorization.role(),
    status: account?.status || "idle",
  }), [authorization, account]);
}

/** { members, status, error, reload } for an administration surface; loads on first use. */
export function useAdminMembers(admin) {
  const state = useCapabilityState(admin);
  useEffect(() => { if (state?.status === "idle") admin.listMembers().catch(() => {}); }, [admin, state?.status]);
  return { ...state, reload: () => admin.listMembers() };
}

/** { run, pending, error, result } for one admin operation (inviteMember, setMemberRole, …). */
export function useAdminOperation(admin, operation) {
  return useCapabilityAction((input) => admin[operation](input));
}
