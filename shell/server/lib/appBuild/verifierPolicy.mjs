/**
 * Builder V2 browser-verification policies.
 *
 * Historical builds keep the policy that produced their verdict. New Builder V2 work is pinned
 * to the deliberately conservative contract-only policy until richer diagnostics are promoted
 * individually with their own calibration evidence.
 */
export const LEGACY_RICH_VERIFIER_POLICY = "legacy_rich_v1";
export const MINIMAL_CONTRACT_VERIFIER_POLICY = "minimal_contract_v1";

export const VERIFICATION_RESULT_CLASS = Object.freeze({
  PASS: "PASS",
  APP_FUNCTIONAL_FAILURE: "APP_FUNCTIONAL_FAILURE",
  PERSISTENCE_FAILURE: "PERSISTENCE_FAILURE",
  FATAL_RUNTIME_FAILURE: "FATAL_RUNTIME_FAILURE",
  PLATFORM_INCONCLUSIVE: "PLATFORM_INCONCLUSIVE",
});

export function isMinimalContractVerifier(policy) {
  return policy === MINIMAL_CONTRACT_VERIFIER_POLICY;
}

export function statusForVerificationClass(classification) {
  if (classification === VERIFICATION_RESULT_CLASS.PASS) return "pass";
  if (classification === VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE) return "undriveable";
  return "fail";
}

export function isAppRepairableVerificationClass(classification) {
  return [
    VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
    VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE,
    VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE,
  ].includes(classification);
}

export function verificationVerdict(classification, detail, extra = {}) {
  return {
    ...extra,
    classification,
    status: statusForVerificationClass(classification),
    detail,
  };
}
