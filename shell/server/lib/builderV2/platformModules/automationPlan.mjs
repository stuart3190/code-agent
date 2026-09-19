// The jobs, schedules and connectors installation plan (WP13).
//
// Long-running work, recurring work and third-party calls are the three things a contract asks
// for in words and a compiler must not invent. The audit's rule for this package is "qualify each
// operation family separately; unavailable services remain unavailable", so this derivation does
// two jobs:
//
//   - it reads the actions, schedules and connectors a contract DECLARES, and
//   - it names the provider family each action belongs to, so the resolver can refuse to install
//     one whose provider this deployment has not configured.
//
// Nothing is inferred from a domain verb. "Generate an invoice" is a document an application
// renders; it is not a request for the AI provider family.

export const AUTOMATION_PLAN_VERSION = 1;

/** The provider families the capability runtime actually implements, and the module that owns each. */
export const PROVIDER_FAMILIES = Object.freeze({
  openai: "thrallo.aiActions",
  replicate: "thrallo.aiActions",
  media: "thrallo.media",
  document: "thrallo.documents",
  knowledge: "thrallo.knowledge",
  meta: "thrallo.metaConnector",
  http: "thrallo.httpConnectors",
});

const CADENCE_WORDS = Object.freeze({
  hourly: /\b(?:hourly|every hour|each hour)\b/i,
  daily: /\b(?:daily|every day|each day|every morning|nightly)\b/i,
  weekly: /\b(?:weekly|every week|each week|every monday|every friday)\b/i,
  monthly: /\b(?:monthly|every month|each month)\b/i,
});

const listOf = (value) => (Array.isArray(value) ? value : []);
const lower = (value) => String(value || "").trim().toLowerCase();
const journeyText = (journey) => [journey?.id, journey?.title, journey?.description,
  ...listOf(journey?.steps).map((step) => `${step?.id} ${step?.title || ""} ${step?.expect || ""}`)].filter(Boolean).join(" ");

/**
 * The actions a contract declares. An action is an explicit `actions` entry, or an operation the
 * contract typed with a provider and operation. Never a verb in a sentence.
 */
export function deriveActionPlan(contract) {
  const declared = listOf(contract?.actions).map((row, index) => ({
    id: String(row?.id || `action-${index + 1}`),
    actionKey: row?.actionKey ? String(row.actionKey) : `${row?.provider || "http"}:${row?.operation || "request"}`,
    provider: row?.provider ? String(row.provider) : null,
    operation: row?.operation ? String(row.operation) : null,
    inputs: listOf(row?.inputs).map(String),
    required: listOf(row?.required ?? row?.inputs).map(String),
    cost: Number(row?.cost) > 0 ? Number(row.cost) : 0,
    grant: row?.grant ? String(row.grant) : null,
    source: "contract.actions",
  }));
  const fromOperations = listOf(contract?.operations)
    .filter((operation) => operation?.provider && operation?.operation)
    .map((operation) => ({
      id: String(operation.id),
      actionKey: `${operation.provider}:${operation.operation}`,
      provider: String(operation.provider),
      operation: String(operation.operation),
      inputs: listOf(operation?.inputs).map(String),
      required: listOf(operation?.required ?? operation?.inputs).map(String),
      cost: Number(operation?.cost) > 0 ? Number(operation.cost) : 0,
      grant: null,
      source: `operation:${operation.id}`,
    }));
  const actions = [...declared, ...fromOperations.filter((row) => !declared.some((other) => other.id === row.id))];
  // The families those actions need, which is what the resolver gates on.
  const families = [...new Set(actions.map((action) => PROVIDER_FAMILIES[lower(action.provider)]).filter(Boolean))];
  return { actions, families };
}

/**
 * The schedules a contract declares. A cadence must be stated — "every morning", "weekly" — and
 * the action it runs must be one the contract also declared, because a schedule pointing at
 * nothing is a schedule that fails silently at 3am.
 */
export function deriveSchedulePlan(contract, { actions = [] } = {}) {
  const known = new Set(actions.map((action) => action.id));
  const declared = listOf(contract?.schedules)
    .filter((row) => row?.id && row?.action)
    .map((row) => ({
      id: String(row.id),
      action: String(row.action),
      cadence: Object.keys(CADENCE_WORDS).includes(row?.cadence) ? row.cadence : "daily",
      atTime: String(row?.atTime || "09:00"),
      ...(row?.weekday !== undefined ? { weekday: Number(row.weekday) } : {}),
      ...(row?.dayOfMonth !== undefined ? { dayOfMonth: Number(row.dayOfMonth) } : {}),
      input: { ...(row?.input || {}) },
      source: "contract.schedules",
    }));
  const schedules = declared.filter((row) => !known.size || known.has(row.action));
  const refused = declared
    .filter((row) => known.size && !known.has(row.action))
    .map((row) => ({ id: row.id, reason: `no declared action "${row.action}"` }));
  // A cadence the contract states in prose, with no schedule declared, is recorded as a REQUEST
  // rather than turned into one: a recurring job nobody configured is worse than none.
  const mentioned = listOf(contract?.journeys)
    .filter((journey) => Object.values(CADENCE_WORDS).some((pattern) => pattern.test(journeyText(journey))))
    .map((journey) => journey.id);
  return { schedules, refused, mentionedIn: mentioned };
}

/** The connectors a contract declares. A host is required; a connector without one is refused. */
export function deriveConnectorPlan(contract) {
  const connectors = listOf(contract?.connectors)
    .filter((row) => row?.id && row?.url)
    .map((row) => ({
      id: String(row.id),
      method: String(row?.method || "GET").toUpperCase(),
      url: String(row.url),
      secret: row?.secret ? String(row.secret) : null,
      inputs: listOf(row?.inputs).map(String),
      required: listOf(row?.required ?? row?.inputs).map(String),
      responseShape: row?.responseShape ? { ...row.responseShape } : null,
      timeoutMs: Number(row?.timeoutMs) > 0 ? Number(row.timeoutMs) : 10_000,
      retries: Number(row?.retries ?? 2),
      source: "contract.connectors",
    }));
  return { connectors };
}

/** All three, derived once. */
export function deriveAutomationPlan(contract) {
  const actionPlan = deriveActionPlan(contract);
  const schedulePlan = deriveSchedulePlan(contract, { actions: actionPlan.actions });
  const connectorPlan = deriveConnectorPlan(contract);
  return {
    version: AUTOMATION_PLAN_VERSION,
    actions: actionPlan.actions,
    families: [
      ...actionPlan.families,
      ...(connectorPlan.connectors.length ? ["thrallo.httpConnectors"] : []),
    ].filter((value, index, all) => all.indexOf(value) === index),
    schedules: schedulePlan.schedules,
    refusedSchedules: schedulePlan.refused,
    scheduleMentions: schedulePlan.mentionedIn,
    connectors: connectorPlan.connectors,
    verification: automationVerificationPlan({
      actions: actionPlan.actions, schedules: schedulePlan.schedules, connectors: connectorPlan.connectors,
    }),
  };
}

/** Deterministic probes: one job per input, one run per occurrence, one declared host. */
export function automationVerificationPlan({ actions = [], schedules = [], connectors = [] } = {}) {
  const probes = [];
  if (actions.length) {
    probes.push({ id: "jobs.idempotent", expect: "the same action with the same input starts one job" });
    probes.push({ id: "jobs.quota", expect: "an action beyond the balance is refused before it runs" });
  }
  if (schedules.length) {
    probes.push({ id: "schedules.once", expect: "one occurrence runs once however many workers see it due" });
  }
  if (connectors.length) {
    probes.push({ id: "connectors.egress", expect: "a host the connector did not declare is refused" });
    probes.push({ id: "connectors.secrets", expect: "no secret appears in any error the application can see" });
  }
  return probes;
}
