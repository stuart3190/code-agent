export const FIXTURE_CLOCK = "2026-08-08T12:00:00.000Z";
export const DEFAULT_FIXTURE_SEED = "thrallo-desktop-d1-seed";

export const FIXTURE_SCENARIOS = Object.freeze({
  idle: Object.freeze({
    state: "idle",
    events: Object.freeze([
      Object.freeze({ type: "state", payload: Object.freeze({ state: "idle" }), terminal: true }),
    ]),
  }),
  running: Object.freeze({
    state: "running",
    events: Object.freeze([
      Object.freeze({ type: "queued", payload: Object.freeze({ progress: 0 }), terminal: false }),
      Object.freeze({ type: "running", payload: Object.freeze({ progress: 35 }), terminal: false }),
      Object.freeze({ type: "running", payload: Object.freeze({ progress: 70 }), terminal: false }),
    ]),
  }),
  success: Object.freeze({
    state: "succeeded",
    events: Object.freeze([
      Object.freeze({ type: "queued", payload: Object.freeze({ progress: 0 }), terminal: false }),
      Object.freeze({ type: "running", payload: Object.freeze({ progress: 50 }), terminal: false }),
      Object.freeze({ type: "succeeded", payload: Object.freeze({ progress: 100 }), terminal: true }),
    ]),
  }),
  failure: Object.freeze({
    state: "failed",
    error: Object.freeze({ code: "fixture_failure", message: "The deterministic fixture failed.", retryable: true }),
    events: Object.freeze([
      Object.freeze({ type: "running", payload: Object.freeze({ progress: 45 }), terminal: false }),
      Object.freeze({ type: "failed", payload: Object.freeze({ code: "fixture_failure" }), terminal: true }),
    ]),
  }),
  cancellation: Object.freeze({
    state: "cancelled",
    events: Object.freeze([
      Object.freeze({ type: "running", payload: Object.freeze({ progress: 20 }), terminal: false }),
      Object.freeze({ type: "cancelled", payload: Object.freeze({ reason: "fixture-user-request" }), terminal: true }),
    ]),
  }),
  recovery: Object.freeze({
    state: "recovered",
    events: Object.freeze([
      Object.freeze({ type: "interrupted", payload: Object.freeze({ checkpoint: "fixture-checkpoint-0001" }), terminal: false }),
      Object.freeze({ type: "recovering", payload: Object.freeze({ progress: 50 }), terminal: false }),
      Object.freeze({ type: "recovered", payload: Object.freeze({ progress: 100 }), terminal: true }),
    ]),
  }),
  "waiting-approval": Object.freeze({
    state: "waiting-approval",
    events: Object.freeze([
      Object.freeze({ type: "plan_ready", payload: Object.freeze({ planId: "fixture-plan-0001" }), terminal: false }),
      Object.freeze({ type: "waiting_approval", payload: Object.freeze({ planId: "fixture-plan-0001" }), terminal: false }),
    ]),
  }),
  "budget-warning": Object.freeze({
    state: "budget-warning",
    events: Object.freeze([
      Object.freeze({ type: "usage", payload: Object.freeze({ remainingPercent: 12 }), terminal: false }),
      Object.freeze({ type: "budget_warning", payload: Object.freeze({ remainingPercent: 12 }), terminal: true }),
    ]),
  }),
  "unsupported-capability": Object.freeze({
    state: "unsupported",
    forceUnsupportedMutations: true,
    events: Object.freeze([
      Object.freeze({ type: "capability_unavailable", payload: Object.freeze({ code: "capability_unavailable" }), terminal: true }),
    ]),
  }),
  conflict: Object.freeze({
    state: "conflict",
    conflict: true,
    events: Object.freeze([
      Object.freeze({ type: "conflict", payload: Object.freeze({ code: "base_snapshot_conflict" }), terminal: true }),
    ]),
  }),
  "offline-reconnect": Object.freeze({
    state: "reconnected",
    events: Object.freeze([
      Object.freeze({ type: "running", payload: Object.freeze({ connection: "initial" }), terminal: false }),
      Object.freeze({ type: "offline", payload: Object.freeze({ cursorPreserved: true }), terminal: false }),
      Object.freeze({ type: "reconnected", payload: Object.freeze({ cursorPreserved: true }), terminal: false }),
      Object.freeze({ type: "succeeded", payload: Object.freeze({ connection: "resumed" }), terminal: true }),
    ]),
  }),
  "expired-session": Object.freeze({
    state: "expired-session",
    expiredSession: true,
    events: Object.freeze([
      Object.freeze({ type: "authentication_expired", payload: Object.freeze({ code: "authentication_expired" }), terminal: true }),
    ]),
  }),
});

export const FIXTURE_SCENARIO_NAMES = Object.freeze(Object.keys(FIXTURE_SCENARIOS));
