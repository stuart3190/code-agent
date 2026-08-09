export const CLIENT_CONTRACT_VERSION = "1.0";

export const PROVIDER_FAMILIES = Object.freeze({
  projects: Object.freeze({
    id: "project-catalogue",
    operations: Object.freeze({
      listProjects: "read",
      getProject: "read",
      createProject: "mutation",
      importProject: "mutation",
      archiveProject: "mutation",
      restoreProject: "mutation",
    }),
  }),
  conversations: Object.freeze({
    id: "conversation-events",
    operations: Object.freeze({
      getConversation: "read",
      listTurns: "read",
      subscribeConversation: "stream",
      sendInstruction: "mutation",
      cancelTurn: "mutation",
    }),
  }),
  plans: Object.freeze({
    id: "plan-decisions",
    operations: Object.freeze({
      getPlan: "read",
      subscribePlan: "stream",
      approvePlan: "mutation",
      rejectPlan: "mutation",
      requestPlanChanges: "mutation",
    }),
  }),
  agents: Object.freeze({
    id: "agent-runs",
    operations: Object.freeze({
      listAgents: "read",
      getRun: "read",
      subscribeRun: "stream",
      startRun: "mutation",
      cancelRun: "mutation",
      retryRun: "mutation",
    }),
  }),
  models: Object.freeze({
    id: "models-usage",
    operations: Object.freeze({
      listModels: "read",
      getUsage: "read",
      getBudget: "read",
      selectModel: "mutation",
    }),
  }),
  builds: Object.freeze({
    id: "build-repair-verification",
    operations: Object.freeze({
      getBuild: "read",
      subscribeBuild: "stream",
      startBuild: "mutation",
      startRepair: "mutation",
      cancelBuild: "mutation",
    }),
  }),
  snapshots: Object.freeze({
    id: "snapshots-working-sets",
    operations: Object.freeze({
      listSnapshots: "read",
      getSnapshot: "read",
      createWorkingSet: "mutation",
      checkpointWorkingSet: "mutation",
      applyWorkingSet: "mutation",
      resolveConflict: "mutation",
    }),
  }),
  preview: Object.freeze({
    id: "preview-browser-testing",
    operations: Object.freeze({
      getPreview: "read",
      subscribeDiagnostics: "stream",
      startTestSession: "mutation",
      cancelTestSession: "mutation",
    }),
  }),
  deployments: Object.freeze({
    id: "deployments-publishing",
    operations: Object.freeze({
      listDeployments: "read",
      getDeployment: "read",
      getDomainStatus: "read",
      publish: "mutation",
      updateRelease: "mutation",
      rollback: "mutation",
      unpublish: "mutation",
      connectDomain: "mutation",
    }),
  }),
  integrations: Object.freeze({
    id: "secrets-database-integrations",
    operations: Object.freeze({
      listIntegrationStates: "read",
      listSecretNames: "read",
      getDatabaseSummary: "read",
      setSecret: "mutation",
      connectIntegration: "mutation",
      applyDatabaseChange: "mutation",
    }),
  }),
});

export const PROVIDER_FAMILY_BY_ID = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_FAMILIES).map(([key, definition]) => [definition.id, Object.freeze({ key, ...definition })]),
));

export function assertProviderConformance(providerKey, provider) {
  const definition = PROVIDER_FAMILIES[providerKey];
  if (!definition) throw new TypeError(`Unknown Thrallo provider family: ${providerKey}`);
  if (!provider || typeof provider !== "object") throw new TypeError(`${providerKey} provider must be an object`);
  const missing = Object.keys(definition.operations).filter((operation) => typeof provider[operation] !== "function");
  if (missing.length) throw new TypeError(`${providerKey} provider is missing: ${missing.join(", ")}`);
  return provider;
}

export function assertProviderSuiteConformance(suite) {
  if (!suite || typeof suite !== "object") throw new TypeError("Thrallo provider suite must be an object");
  for (const key of Object.keys(PROVIDER_FAMILIES)) assertProviderConformance(key, suite[key]);
  return suite;
}
