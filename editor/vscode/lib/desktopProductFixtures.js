// Deterministic D9 presentation scenarios. These describe fixture UI state only;
// provider data still comes from the versioned D1 and D3 fixture providers.

"use strict";

const D9_FIXTURE_SEED = "thrallo-desktop-d9-foundation";
const D9_FIXTURE_CLOCK = "2032-08-09T14:00:00.000Z";

const BASE = Object.freeze({
  accessScenario: "authenticated-paid",
  providerScenario: "idle",
  homeState: "ready",
  initialNavigation: "home",
  buildState: "not_started",
  planState: "pending",
  selectedModel: "fixture-balanced",
  parallelAgents: false,
  canceledAgent: false,
  modelUnavailable: false,
  localOffline: false,
  futureCloudState: "integration_pending",
});

const VARIANTS = Object.freeze({
  "first-launch": { accessScenario: "signed-out-free", homeState: "first_launch" },
  "signed-out": { accessScenario: "signed-out-free", homeState: "signed_out" },
  "authenticated-free": { accessScenario: "authenticated-free" },
  "authenticated-paid": {},
  "recent-local-workspace": {},
  "fixture-thrallo-project": { initialNavigation: "projects" },
  "idle-conversation": { initialNavigation: "conversation" },
  "active-build-run": { providerScenario: "running", buildState: "running", initialNavigation: "conversation" },
  "waiting-plan-approval": { providerScenario: "waiting-approval", buildState: "waiting_approval", planState: "pending", initialNavigation: "conversation" },
  "approved-plan": { providerScenario: "success", buildState: "queued", planState: "approved", initialNavigation: "conversation" },
  "requested-changes": { providerScenario: "waiting-approval", buildState: "planning", planState: "changes_requested", initialNavigation: "conversation" },
  "failed-build": { providerScenario: "failure", buildState: "failed", initialNavigation: "conversation" },
  "recovering-build": { providerScenario: "recovery", buildState: "recovering", initialNavigation: "conversation" },
  "verifying-build": { providerScenario: "running", buildState: "verifying", initialNavigation: "conversation" },
  "repairing-build": { providerScenario: "recovery", buildState: "repairing", initialNavigation: "conversation" },
  "completed-build": { providerScenario: "success", buildState: "completed", initialNavigation: "conversation" },
  "parallel-fixture-agents": { providerScenario: "running", buildState: "running", parallelAgents: true, initialNavigation: "agents" },
  "canceled-agent": { providerScenario: "cancellation", buildState: "canceled", canceledAgent: true, initialNavigation: "agents" },
  "budget-80": { accessScenario: "usage-warning-80", initialNavigation: "usage" },
  "budget-90": { accessScenario: "usage-warning-90", providerScenario: "budget-warning", initialNavigation: "usage" },
  "exhausted-budget": { accessScenario: "exhausted-ai-budget", providerScenario: "budget-warning", initialNavigation: "usage" },
  "model-unavailable": { modelUnavailable: true, initialNavigation: "conversation" },
  "offline-local-project": { accessScenario: "offline-cached", providerScenario: "offline-reconnect", localOffline: true },
  "stale-entitlement-usage": { accessScenario: "stale-usage", initialNavigation: "usage" },
  "future-cloud-unavailable": { accessScenario: "cloud-desktop-unavailable", providerScenario: "unsupported-capability", futureCloudState: "capability_unavailable" },
  "plan-expired": { providerScenario: "waiting-approval", buildState: "waiting_approval", planState: "expired", initialNavigation: "conversation" },
  "capability-unavailable": { providerScenario: "unsupported-capability", buildState: "capability_unavailable", planState: "unavailable", initialNavigation: "conversation" },
});

const D9_SCENARIOS = Object.freeze(Object.keys(VARIANTS));

function getD9Scenario(name = "authenticated-paid") {
  if (!D9_SCENARIOS.includes(name)) throw new TypeError(`Unknown D9 fixture scenario: ${name}`);
  return Object.freeze({ name, ...BASE, ...VARIANTS[name] });
}

function createD9FixtureActionProvider({ seed = D9_FIXTURE_SEED, scenario = "authenticated-paid" } = {}) {
  const definition = getD9Scenario(scenario);
  const calls = [];
  let sequence = 0;
  function record(operation, input = {}) {
    sequence += 1;
    const requestId = `fixture-d9-${digest(`${seed}:${scenario}:${operation}:${sequence}`)}`;
    const call = Object.freeze({
      sequence,
      operation,
      requestId,
      observedAt: new Date(Date.parse(D9_FIXTURE_CLOCK) + sequence * 1000).toISOString(),
      input: Object.freeze(sanitizeInput(operation, input)),
    });
    calls.push(call);
    if (definition.providerScenario === "unsupported-capability") {
      return Object.freeze({ ok: false, code: "capability_unavailable", state: "capability_unavailable", requestId, sideEffects: false, source: "fixture" });
    }
    return Object.freeze({ ok: true, state: "fixture_recorded", requestId, sideEffects: true, source: "fixture", revision: `fixture-d9-r${sequence}` });
  }
  return Object.freeze({
    recordConversation: (input) => record("recordConversation", input),
    decidePlan: (input) => record("decidePlan", input),
    controlAgent: (input) => record("controlAgent", input),
    selectModel: (input) => record("selectModel", input),
    getCalls: () => Object.freeze(calls.map((call) => Object.freeze({ ...call, input: Object.freeze({ ...call.input }) }))),
  });
}

function sanitizeInput(operation, input) {
  if (operation === "recordConversation") return { conversationId: boundedId(input.conversationId), textLength: String(input.text || "").length };
  if (operation === "decidePlan") return { planId: boundedId(input.planId), decision: boundedId(input.decision), commentLength: String(input.comment || "").length, source: "explicit_typed_fixture_action" };
  if (operation === "controlAgent") return { runId: boundedId(input.runId), agentId: boundedId(input.agentId), control: boundedId(input.control) };
  return { modelId: boundedId(input.modelId), source: "explicit_fixture_selection" };
}

function boundedId(value) { return String(value || "").replace(/[^a-z0-9_.:-]/gi, "").slice(0, 120); }
function digest(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

module.exports = {
  D9_FIXTURE_SEED,
  D9_FIXTURE_CLOCK,
  D9_SCENARIOS,
  getD9Scenario,
  createD9FixtureActionProvider,
};
