// React bindings for the identity/session module — platform infrastructure, do not edit.
//
// Domain-neutral and JSX-free: these hooks return STATE and FUNCTIONS. Where the sign-in form
// lives, what it looks like and what the signed-in surface shows remain entirely the
// application's design.

import { useEffect } from "react";
import { useCapabilityAction, useCapabilityState } from "../capabilities/react.js";
import { identityGuard } from "./identity.js";

/** The live session state of a controller; establishes the session on first use. */
export function useIdentityState(controller) {
  const state = useCapabilityState(controller);
  useEffect(() => { void controller?.ensure?.(); }, [controller]);
  return state;
}

/** { run, pending, error, result } for one identity operation (signIn, signUp, signOut, …). */
export function useIdentityAction(controller, operation) {
  return useCapabilityAction((input) => controller[operation](input));
}

/**
 * { allowed, reason, pending, state } for a route or surface that needs "member", "visitor" or
 * "any". A visitor never passes a member requirement.
 */
export function useIdentityGuard(controller, requirement = "member") {
  const state = useIdentityState(controller);
  const guard = identityGuard(state, requirement);
  return { ...guard, pending: guard.pending === true || state?.status === "initializing", state };
}
