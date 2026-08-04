// The Settings API, stubbed.
//
// Settings reads `/api/v1/settings`, and a spec that does not stub it gets a 500 — the sheet opens
// with its heading and then renders nothing, so the failure surfaces much later as "the Manage
// button never appeared". chat-shell.spec learned this and stubbed it; provider-settings.spec and
// theme-check.spec did not, and every one of their tests timed out on an empty sheet.
//
// Shared, so the next spec that opens Settings does not have to rediscover the same 500.

export const SETTINGS_FIXTURE = {
  plan: { id: "free", name: "Free", monthly: { runs: 20, managedTokens: 1_500_000, computeSeconds: 10_800 } },
  subscription: {
    plan: "free", planName: "Free", status: "active", stripeManaged: false,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z", cancelAtPeriodEnd: false, periodEndMeans: "resets",
    pendingPlan: null, pendingPlanName: null, pendingPlanAt: null,
    overrides: { runs: null, managedTokens: null, computeSeconds: null },
  },
  plans: [], stripeConfigured: false,
  capabilities: { plan: "free", retentionDays: 7, errorReporting: false, buildHistory: false, export: false, multiDomain: false },
  ownerAccount: false, previewPlan: null, unlimited: false, pastDue: false,
  period: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
  budgets: {
    runs: { used: 0, limit: 20, remaining: 20 },
    managedTokens: { used: 250_000, limit: 1_500_000, remaining: 1_250_000 },
    computeSeconds: { used: 0, limit: 10_800, remaining: 10_800 },
  },
  tokens: [], notifications: { unread: 0, channels: {}, vapidPublicKey: "" },
  counts: { projects: 1, liveSites: 0, deployments: 0 },
};

/** Route `/api/v1/settings`, optionally overriding parts of the fixture. */
export async function stubSettings(page, overrides = {}) {
  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({ json: { ...SETTINGS_FIXTURE, ...overrides } }));
}
