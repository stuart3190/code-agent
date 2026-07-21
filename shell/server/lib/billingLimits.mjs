export const MANAGED_JOB_CREDIT_LIMITS = Object.freeze({ plan: 2, iterate: 40, build: 60, redesign: 60 });
export const MANAGED_FINAL_JOB_GRACE_CREDITS = 5;

export function managedJobCreditLimit({ mode, redesign = false } = {}) {
  if (redesign) return MANAGED_JOB_CREDIT_LIMITS.redesign;
  return MANAGED_JOB_CREDIT_LIMITS[mode] ?? MANAGED_JOB_CREDIT_LIMITS.build;
}

export function managedAffordableCreditLimit({ balance, mode, redesign = false } = {}) {
  const runawayLimit = managedJobCreditLimit({ mode, redesign });
  const affordable = Math.max(0, Number(balance) || 0) + MANAGED_FINAL_JOB_GRACE_CREDITS;
  return Math.min(runawayLimit, affordable);
}
