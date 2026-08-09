import { capabilityUnavailableResult, createHostCapabilities } from "../capabilities.mjs";
import { PROVIDER_FAMILIES, assertProviderSuiteConformance } from "../contracts.mjs";
import { redact } from "../errors.mjs";
import { DEFAULT_FIXTURE_SEED, FIXTURE_CLOCK, FIXTURE_SCENARIOS } from "./scenarios.mjs";

const FIXTURE_IDENTITIES = Object.freeze({
  ownerId: "fixture-owner-0001",
  projectId: "fixture-project-0001",
  conversationId: "fixture-conversation-0001",
  planId: "fixture-plan-0001",
  runId: "fixture-run-0001",
  buildId: "fixture-build-0001",
  snapshotId: "fixture-snapshot-green-0001",
  deploymentId: "fixture-deployment-0001",
});

const REQUIRED_CAPABILITIES = Object.freeze({
  "project-catalogue.createProject": ["builderV2Mutation"],
  "project-catalogue.importProject": ["builderV2Mutation"],
  "project-catalogue.archiveProject": ["builderV2Mutation"],
  "project-catalogue.restoreProject": ["builderV2Mutation"],
  "conversation-events.sendInstruction": ["builderV2Mutation"],
  "conversation-events.cancelTurn": ["managedBuild"],
  "plan-decisions.approvePlan": ["builderV2Mutation"],
  "plan-decisions.rejectPlan": ["builderV2Mutation"],
  "plan-decisions.requestPlanChanges": ["builderV2Mutation"],
  "agent-runs.startRun": ["builderV2Mutation"],
  "agent-runs.cancelRun": ["managedBuild"],
  "agent-runs.retryRun": ["builderV2Mutation"],
  "models-usage.selectModel": ["managedBuild"],
  "build-repair-verification.startBuild": ["managedBuild", "builderV2Mutation"],
  "build-repair-verification.startRepair": ["managedBuild", "builderV2Mutation"],
  "build-repair-verification.cancelBuild": ["managedBuild"],
  "snapshots-working-sets.createWorkingSet": ["builderV2Mutation"],
  "snapshots-working-sets.checkpointWorkingSet": ["builderV2Mutation"],
  "snapshots-working-sets.applyWorkingSet": ["builderV2Mutation"],
  "snapshots-working-sets.resolveConflict": ["builderV2Mutation"],
  "preview-browser-testing.startTestSession": ["browserDiagnostics"],
  "preview-browser-testing.cancelTestSession": ["browserDiagnostics"],
  "deployments-publishing.publish": ["publishing", "builderV2Mutation"],
  "deployments-publishing.updateRelease": ["publishing", "builderV2Mutation"],
  "deployments-publishing.rollback": ["publishing"],
  "deployments-publishing.unpublish": ["publishing"],
  "deployments-publishing.connectDomain": ["publishing"],
  "secrets-database-integrations.setSecret": ["integrations"],
  "secrets-database-integrations.connectIntegration": ["integrations"],
  "secrets-database-integrations.applyDatabaseChange": ["integrations", "builderV2Mutation"],
});

function digest(value, length = 16) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`.slice(0, length);
}

function immutableClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableClone));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableClone(item)])));
  }
  return value;
}

function fixtureData(familyId, operationId, scenario, stateRevision) {
  const common = { scenario: scenario.state, stateRevision };
  const data = {
    "project-catalogue": {
      projects: [
        { id: FIXTURE_IDENTITIES.projectId, name: "Fixture Atlas", status: scenario.state, source: "fixture" },
        { id: "fixture-project-0002", name: "Fixture Beacon", status: "idle", source: "fixture" },
      ],
      project: { id: FIXTURE_IDENTITIES.projectId, name: "Fixture Atlas", status: scenario.state, source: "fixture" },
    },
    "conversation-events": {
      conversation: { id: FIXTURE_IDENTITIES.conversationId, projectId: FIXTURE_IDENTITIES.projectId, state: scenario.state },
      turns: [
        { id: "fixture-turn-0001", role: "user", text: "Create the deterministic fixture." },
        { id: "fixture-turn-0002", role: "assistant", text: "The deterministic fixture is ready." },
      ],
    },
    "plan-decisions": {
      plan: { id: FIXTURE_IDENTITIES.planId, state: scenario.state, summary: "Deterministic fixture plan", revision: stateRevision },
    },
    "agent-runs": {
      agents: [
        { id: "fixture-agent-lead", name: "Lead", state: scenario.state },
        { id: "fixture-agent-review", name: "Reviewer", state: "idle" },
      ],
      run: { id: FIXTURE_IDENTITIES.runId, state: scenario.state, agentId: "fixture-agent-lead" },
    },
    "models-usage": {
      models: [
        { id: "fixture-balanced", label: "Fixture Balanced", available: true },
        { id: "fixture-deep", label: "Fixture Deep", available: true },
      ],
      usage: { usedUnits: 88, limitUnits: 100, remainingPercent: scenario.state === "budget-warning" ? 12 : 75 },
      budget: { state: scenario.state === "budget-warning" ? "warning" : "available", remainingPercent: scenario.state === "budget-warning" ? 12 : 75 },
    },
    "build-repair-verification": {
      build: { id: FIXTURE_IDENTITIES.buildId, projectId: FIXTURE_IDENTITIES.projectId, state: scenario.state, verified: scenario.state === "succeeded" },
    },
    "snapshots-working-sets": {
      snapshots: [{ id: FIXTURE_IDENTITIES.snapshotId, state: "green", immutable: true }],
      snapshot: { id: FIXTURE_IDENTITIES.snapshotId, state: "green", immutable: true },
    },
    "preview-browser-testing": {
      preview: { projectId: FIXTURE_IDENTITIES.projectId, state: scenario.state, fixturePath: "/fixture-preview" },
    },
    "deployments-publishing": {
      deployments: [{ id: FIXTURE_IDENTITIES.deploymentId, state: scenario.state, sourceSnapshotId: FIXTURE_IDENTITIES.snapshotId }],
      deployment: { id: FIXTURE_IDENTITIES.deploymentId, state: scenario.state, sourceSnapshotId: FIXTURE_IDENTITIES.snapshotId },
      domain: { hostname: "fixture.invalid", state: "fixture-only" },
    },
    "secrets-database-integrations": {
      integrations: [{ id: "fixture-github", state: scenario.state }],
      secretNames: ["FIXTURE_API_KEY"],
      database: { provider: "fixture", tables: 3, mutation: "disabled" },
    },
  }[familyId];

  const selected = {
    listProjects: data?.projects,
    getProject: data?.project,
    getConversation: data?.conversation,
    listTurns: data?.turns,
    getPlan: data?.plan,
    listAgents: data?.agents,
    getRun: data?.run,
    listModels: data?.models,
    getUsage: data?.usage,
    getBudget: data?.budget,
    getBuild: data?.build,
    listSnapshots: data?.snapshots,
    getSnapshot: data?.snapshot,
    getPreview: data?.preview,
    listDeployments: data?.deployments,
    getDeployment: data?.deployment,
    getDomainStatus: data?.domain,
    listIntegrationStates: data?.integrations,
    listSecretNames: data?.secretNames,
    getDatabaseSummary: data?.database,
  }[operationId];
  return immutableClone(selected === undefined ? { ...common, operationId } : selected);
}

export function createFixtureProviderSuite({
  seed = DEFAULT_FIXTURE_SEED,
  scenario = "idle",
  capabilities = {},
} = {}) {
  const scenarioDefinition = FIXTURE_SCENARIOS[scenario];
  if (!scenarioDefinition) throw new TypeError(`Unknown Thrallo fixture scenario: ${scenario}`);
  const hostCapabilities = createHostCapabilities(capabilities);
  const calls = [];
  let callSequence = 0;
  let stateRevision = 0;

  function nextIdentity(familyId, operationId) {
    callSequence += 1;
    const basis = `${seed}:${scenario}:${familyId}:${operationId}:${callSequence}`;
    return {
      requestId: `fixture-request-${digest(basis)}`,
      observedAt: new Date(Date.parse(FIXTURE_CLOCK) + callSequence * 1000).toISOString(),
      revision: `fixture-revision-${digest(`${basis}:${stateRevision}`, 12)}`,
      sequence: callSequence,
    };
  }

  function record(familyId, operationId, kind, input, identity) {
    calls.push(immutableClone({
      sequence: identity.sequence,
      familyId,
      operationId,
      kind,
      requestId: identity.requestId,
      observedAt: identity.observedAt,
      input: redact(input || {}),
    }));
  }

  function failure(identity, code, message, retryable = false, details = null) {
    return immutableClone({ ok: false, requestId: identity.requestId, code, message, retryable, details: redact(details) });
  }

  function unavailable(familyId, operationId, identity, capability) {
    return capabilityUnavailableResult({ capability, operationId: `${familyId}.${operationId}`, requestId: identity.requestId });
  }

  function invoke(familyId, operationId, kind, input = {}) {
    const identity = nextIdentity(familyId, operationId);
    record(familyId, operationId, kind, input, identity);
    if (scenarioDefinition.expiredSession) {
      return failure(identity, "authentication_expired", "The fixture session has expired.", false);
    }
    if (kind === "mutation") {
      const required = REQUIRED_CAPABILITIES[`${familyId}.${operationId}`] || ["builderV2Mutation"];
      const missing = required.find((capability) => !hostCapabilities[capability]);
      if (scenarioDefinition.forceUnsupportedMutations || missing) return unavailable(familyId, operationId, identity, missing || required[0]);
      if (scenarioDefinition.conflict && familyId === "snapshots-working-sets") {
        return failure(identity, "base_snapshot_conflict", "The deterministic base snapshot is stale.", false, {
          expected: FIXTURE_IDENTITIES.snapshotId,
          actual: "fixture-snapshot-green-0002",
        });
      }
      stateRevision += 1;
    }
    if (scenarioDefinition.error && ["build-repair-verification", "agent-runs", "preview-browser-testing"].includes(familyId)) {
      return failure(identity, scenarioDefinition.error.code, scenarioDefinition.error.message, scenarioDefinition.error.retryable);
    }
    return immutableClone({
      ok: true,
      requestId: identity.requestId,
      data: fixtureData(familyId, operationId, scenarioDefinition, stateRevision),
      observedAt: identity.observedAt,
      source: "fixture",
      revision: identity.revision,
    });
  }

  function stream(familyId, operationId, input = {}) {
    const identity = nextIdentity(familyId, operationId);
    record(familyId, operationId, "stream", input, identity);
    return (async function* fixtureStream() {
      for (let index = 0; index < scenarioDefinition.events.length; index += 1) {
        const event = scenarioDefinition.events[index];
        const eventBasis = `${seed}:${scenario}:${familyId}:${operationId}:event:${index + 1}`;
        yield immutableClone({
          streamId: `fixture-stream-${digest(`${seed}:${familyId}:${operationId}`, 12)}`,
          sequence: index + 1,
          eventId: `fixture-event-${digest(eventBasis, 12)}`,
          type: event.type,
          occurredAt: new Date(Date.parse(FIXTURE_CLOCK) + (index + 1) * 1000).toISOString(),
          payload: { ...event.payload, terminal: event.terminal },
          terminal: event.terminal,
        });
      }
    }());
  }

  const suite = {};
  for (const [providerKey, definition] of Object.entries(PROVIDER_FAMILIES)) {
    const provider = {};
    for (const [operationId, kind] of Object.entries(definition.operations)) {
      provider[operationId] = kind === "stream"
        ? (input = {}) => stream(definition.id, operationId, input)
        : async (input = {}) => invoke(definition.id, operationId, kind, input);
    }
    suite[providerKey] = Object.freeze(provider);
  }

  Object.defineProperties(suite, {
    contractVersion: { value: "1.0", enumerable: true },
    source: { value: "fixture", enumerable: true },
    seed: { value: seed, enumerable: true },
    scenario: { value: scenario, enumerable: true },
    capabilities: { value: hostCapabilities, enumerable: true },
    getCalls: { value: () => immutableClone(calls) },
    getState: { value: () => immutableClone({ stateRevision, callSequence }) },
  });

  return Object.freeze(assertProviderSuiteConformance(suite));
}

export { DEFAULT_FIXTURE_SEED, FIXTURE_CLOCK, FIXTURE_SCENARIOS, FIXTURE_SCENARIO_NAMES } from "./scenarios.mjs";
