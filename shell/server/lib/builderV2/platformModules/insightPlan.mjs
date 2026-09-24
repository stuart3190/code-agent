// The analytics and exports installation plan (WP11).
//
// The audit's instruction for this work package is "separate telemetry from domain metrics", and
// the separation starts here. Two plans come out of one contract:
//
//   - TELEMETRY events, from the journeys a build profile asked to measure. Never from a domain
//     noun: an application that stores invoices is not thereby asking for invoice telemetry.
//   - DOMAIN METRICS, from declared numeric fields on durable entities plus the contract's own
//     aggregate vocabulary ("total revenue", "bookings per room"). Each metric names the entity
//     and the field it reads, both checked against the compiled schema, so a metric can never be
//     computed over a field that does not exist.
//
// Exports are derived the same way: an operation typed as an artifact, or a journey step that
// says someone downloads something, names the entity and the columns to serialise.

export const INSIGHT_PLAN_VERSION = 1;

const ARTIFACT_KINDS = new Set(["export", "download", "print", "report"]);
// An aggregate STATEMENT, not an aggregate word. "Total revenue", "how many bookings", "average
// install hours" are requests for a number over many records; "the total for this quote" is one
// record's own field and must not conjure a dashboard.
const AGGREGATE_STATEMENT = /\b(?:total|sum|average|mean|number)\s+(?:\w+\s+){0,2}(?:revenue|sales|bookings|orders|records|customers|jobs|hours|across|per|by)\b|\bhow many\b|\b(?:breakdown|trend)\s+(?:by|of|over)\b|\bover time\b/i;
const EXPORT_VOCABULARY = /\b(?:export|download|csv|spreadsheet|extract|save as|report file)\b/i;
// Telemetry is NOT inferred from prose. "Track the job", "room usage", "measure the beam angle"
// are domain sentences; reading them as a request for product analytics would install a telemetry
// stream into applications that never asked for one, and every retained contract in the corpus
// contains at least one of those words. Product-usage measurement is a decision the customer
// makes, so it is taken only from the explicit build-profile signal.
const MONEY_FIELD = /(?:amount|total|price|cost|revenue|fee|charge|value|budget|rate|subtotal)/i;
const COUNT_FIELD = /(?:count|quantity|qty|hours|units|seats|people|size)/i;
const NEVER_EXPORTED = /(?:password|token|secret|api[-_ ]?key|credential|hash)/i;

const lower = (value) => String(value || "").trim().toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value : []);
const kindOf = (operation) => String(operation?.kind || operation?.type || operation?.action || operation?.id || "")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const journeyText = (journey) => [journey?.id, journey?.title, journey?.description,
  ...listOf(journey?.steps).map((step) => `${step?.id} ${step?.title || ""} ${step?.expect || ""}`)].filter(Boolean).join(" ");

/**
 * Telemetry events. Declared only where the contract or its profile asks to MEASURE something:
 * product usage is a decision someone makes, not a by-product of having journeys.
 */
export function deriveTelemetryPlan(contract) {
  const signalled = listOf(contract?.buildProfile?.requirementSignals).includes("analytics");
  if (!signalled) return { events: [], consentRequired: true };
  const events = listOf(contract?.journeys).map((journey) => ({
    id: `${journey.id}_completed`,
    // Only structural properties. A domain value in a usage stream is the leak this separates.
    properties: ["step", "outcome"],
    source: journey.id,
  }));
  return {
    events: [{ id: "page_view", properties: ["path"], source: "platform" }, ...events],
    consentRequired: true,
    retentionDays: 365,
    source: "signal:analytics",
  };
}

/**
 * Domain metrics. A numeric field on a durable entity is summable; an enum or reference field is
 * groupable. The contract's own aggregate vocabulary decides whether any of it is asked for.
 */
export function deriveMetricPlan(contract, { entitySchema = null } = {}) {
  const text = [contract?.summary, ...listOf(contract?.journeys).map(journeyText)].filter(Boolean).join(" ");
  const asked = listOf(contract?.buildProfile?.requirementSignals).includes("analytics")
    || listOf(contract?.operations).some((operation) => kindOf(operation) === "count")
    // A dashboard or report screen is a contract saying outright that it shows totals.
    || listOf(contract?.routes).some((route) => /\b(?:dashboard|report|analytics|metrics|overview)\b/i.test(`${route?.name || ""} ${route?.path || ""}`))
    || AGGREGATE_STATEMENT.test(text);
  if (!asked) return { metrics: [] };
  const metrics = [];
  for (const entity of listOf(entitySchema?.entities)) {
    const fields = entitySchema?.schema?.entities?.[entity]?.fields || {};
    metrics.push({ id: `${entity}Count`, entity, aggregation: "count" });
    for (const [name, field] of Object.entries(fields)) {
      if (NEVER_EXPORTED.test(name)) continue;
      if ((field?.type === "number" || field?.type === "integer") && (MONEY_FIELD.test(name) || COUNT_FIELD.test(name))) {
        metrics.push({ id: `${entity}${name[0].toUpperCase()}${name.slice(1)}Total`, entity, aggregation: "sum", field: name });
        metrics.push({ id: `${entity}${name[0].toUpperCase()}${name.slice(1)}Average`, entity, aggregation: "avg", field: name });
      }
      // A small closed set is what a breakdown is FOR. Grouping by a free-text field produces one
      // bucket per record, which is a list wearing a chart's clothes.
      if (field?.type === "enum" && listOf(field.options).length) {
        metrics.push({ id: `${entity}By${name[0].toUpperCase()}${name.slice(1)}`, entity, aggregation: "count", groupBy: name });
      }
    }
    if (/\b(?:over time|trend|this (?:month|week|year)|per (?:month|week|day))\b/i.test(text)) {
      metrics.push({ id: `${entity}ByMonth`, entity, aggregation: "count", bucket: "month" });
    }
  }
  return { metrics };
}

/**
 * Exports. An operation the ownership layer typed as an artifact, or a journey step that says
 * someone downloads something, becomes a declared export over the entity it names. Columns are
 * the entity's own declared fields, minus anything that must never leave.
 */
export function deriveExportPlan(contract, { entitySchema = null } = {}) {
  const durable = listOf(entitySchema?.entities);
  const wanted = new Map();
  for (const operation of listOf(contract?.operations)) {
    const artifact = operation?.output?.type === "artifact" || ARTIFACT_KINDS.has(kindOf(operation));
    if (!artifact) continue;
    const entity = durable.find((name) => lower(name) === lower(operation?.entity))
      || durable.find((name) => new RegExp(`\\b${name}s?\\b`, "i").test(`${operation?.id} ${operation?.description || ""}`));
    if (entity) wanted.set(entity, operation.id);
  }
  if (!wanted.size) {
    for (const journey of listOf(contract?.journeys)) {
      const text = journeyText(journey);
      if (!EXPORT_VOCABULARY.test(text)) continue;
      for (const entity of durable) {
        if (new RegExp(`\\b${entity}s?\\b`, "i").test(text)) wanted.set(entity, journey.id);
      }
    }
  }
  const exports = [...wanted.entries()].map(([entity, source]) => ({
    id: `${entity}Export`,
    entity,
    columns: Object.keys(entitySchema?.schema?.entities?.[entity]?.fields || {}).filter((field) => !NEVER_EXPORTED.test(field)),
    format: "csv",
    filename: `${entity}-export`,
    source,
  })).filter((row) => row.columns.length);
  return { exports };
}

/** All three, derived once. */
export function deriveInsightPlan(contract, { entitySchema = null } = {}) {
  const telemetry = deriveTelemetryPlan(contract);
  const metricPlan = deriveMetricPlan(contract, { entitySchema });
  const exportPlan = deriveExportPlan(contract, { entitySchema });
  return {
    version: INSIGHT_PLAN_VERSION,
    telemetry,
    metrics: metricPlan.metrics,
    exports: exportPlan.exports,
    verification: insightVerificationPlan({ telemetry, metrics: metricPlan.metrics, exports: exportPlan.exports }),
  };
}

/** Deterministic probes: exact aggregates and an artifact whose row count can be checked. */
export function insightVerificationPlan({ telemetry = {}, metrics = [], exports: exportDefinitions = [] } = {}) {
  const probes = [];
  if ((telemetry?.events || []).length) {
    probes.push({ id: "telemetry.consent", expect: "nothing is sent before consent is given" });
    probes.push({ id: "telemetry.allowlist", expect: "a property outside the declared list never reaches the stream" });
  }
  if (metrics.length) {
    probes.push({ id: "metric.exact", expect: "a metric equals the arithmetic over every matching record" });
  }
  if (exportDefinitions.length) {
    probes.push({ id: "export.rows", expect: "the artifact holds every row the query matched, not the page on screen" });
    probes.push({ id: "export.quoting", expect: "a value containing a comma, quote or newline survives the round trip" });
  }
  return probes;
}
