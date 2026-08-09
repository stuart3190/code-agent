import { NATIVE_AUTH_STATES } from "../auth/states.mjs";

export const ACCOUNT_RECOVERY_STATES = Object.freeze([
  "none",
  "account_recovery_required",
  "billing_recovery_required",
  "workspace_recovery_required",
  "multiple",
]);

const AUTHENTICATED_STATES = new Set(["authenticated", "refreshing", "offline"]);

function boundedText(value, limit) {
  const text = String(value || "").trim();
  return text ? text.slice(0, limit) : null;
}

function nonNegativeCount(value) {
  return Number.isInteger(value) && value >= 0
    ? Object.freeze({ state: "known", value })
    : Object.freeze({ state: "unknown", value: null });
}

export function createAccountPresentationModel({
  authSnapshot,
  profile = null,
  device = null,
  recovery = null,
  observedAt = null,
  freshness = "unavailable",
} = {}) {
  if (!authSnapshot || !NATIVE_AUTH_STATES.includes(authSnapshot.state)) {
    throw new TypeError("Account presentation requires a D2 authentication snapshot");
  }
  if (!["fresh", "stale", "unavailable"].includes(freshness)) throw new TypeError(`Unknown account freshness: ${freshness}`);
  const signedIn = AUTHENTICATED_STATES.has(authSnapshot.state) && Boolean(authSnapshot.accountId);
  const recoveryState = ACCOUNT_RECOVERY_STATES.includes(recovery?.state) ? recovery.state : "none";
  const identity = signedIn ? Object.freeze({
    subject: "current_account",
    displayName: boundedText(profile?.displayName, 80),
    emailLabel: boundedText(profile?.emailLabel, 254),
    avatarLabel: boundedText(profile?.avatarLabel, 3),
  }) : null;

  return Object.freeze({
    schemaVersion: "1.0",
    identity,
    session: Object.freeze({
      state: authSnapshot.state,
      method: authSnapshot.method || null,
      deviceLabel: boundedText(device?.label, 80) || "This desktop",
      platform: boundedText(device?.platform, 24),
      expiresAt: authSnapshot.expiresAt || null,
      otherActiveSessions: nonNegativeCount(device?.otherActiveSessions),
    }),
    recovery: Object.freeze({
      state: recoveryState,
      accountRequired: recoveryState === "account_recovery_required" || recoveryState === "multiple",
      billingRequired: recoveryState === "billing_recovery_required" || recoveryState === "multiple",
      workspaceRequired: recoveryState === "workspace_recovery_required" || recoveryState === "multiple",
      reason: boundedText(recovery?.reason, 160),
    }),
    portalActions: Object.freeze([
      Object.freeze({ destination: "account", label: "Manage account" }),
      Object.freeze({ destination: "billing", label: "Billing and subscription" }),
      Object.freeze({ destination: "usage", label: "Usage details" }),
    ]),
    freshness,
    observedAt,
  });
}
