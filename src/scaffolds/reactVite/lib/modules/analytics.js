// Analytics module v1 — platform infrastructure, do not edit or reimplement.
//
// TWO different things wear the word "analytics", and conflating them is the defect the audit
// names (§7.1, WP11 "separate telemetry from domain metrics"):
//
//   TELEMETRY is how the product is used — page views, errors, feature clicks. It belongs to the
//   platform, it is sampled, it is subject to consent, and it must never carry personal data.
//
//   DOMAIN METRICS are what the application is about — revenue this month, bookings per room,
//   average install hours. They are answers about the customer's own records, they must be
//   authorised like any other read, and they must be EXACT.
//
// Generated code mixed them: it tracked domain values into telemetry (leaking customer data into
// a product-usage stream), and it computed domain metrics by fetching a page of records and
// reducing it in the browser — which silently answered "revenue" as "revenue of the 50 rows that
// happened to load". Both halves are owned here, separately.
//
// Headless: functions and state only.

export const ANALYTICS_MODULE_VERSION = "1.0.0";

export const ANALYTICS_ERROR = Object.freeze({
  UNKNOWN_EVENT: "analytics_event_unknown",
  PROPERTY_NOT_ALLOWED: "analytics_property_not_allowed",
  PERSONAL_DATA: "analytics_personal_data_refused",
  UNKNOWN_METRIC: "metric_unknown",
  FIELD_NOT_ALLOWED: "metric_field_not_allowed",
  UNAVAILABLE: "analytics_unavailable",
});

export class AnalyticsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
// Property names that carry a person rather than a measurement. A telemetry stream is retained,
// exported and read by whoever operates the product; a customer's email has no business in it.
const PERSONAL_WORDS = new Set(["email", "mail", "phone", "mobile", "address", "postcode", "zip", "name",
  "surname", "firstname", "lastname", "dob", "birth", "birthday", "ssn", "nino", "card", "iban",
  "password", "token", "secret", "user", "customer", "person"]);
/** Every word of a property name, camelCase and snake_case alike. "customerEmail" is two words. */
const wordsOf = (value) => String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  .match(/[a-z0-9]+/g) || [];
const PERSONAL_PROPERTY = { test: (value) => wordsOf(value).some((word) => PERSONAL_WORDS.has(word)) };
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── telemetry ────────────────────────────────────────────────────────────────

/**
 * Compile the declared telemetry events.
 *   events: [{ id, properties: ["plan", "step"] }]
 * An event that was never declared is refused, and a property outside its allow-list is dropped
 * with a reason. Allow-listing is the only mechanism that keeps a stream honest over time: any
 * "just send the whole object" path eventually sends something personal.
 */
export function compileAnalyticsEvents(events = [], { consentRequired = true, retentionDays = 365 } = {}) {
  const definitions = {};
  for (const row of listOf(events)) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    const properties = listOf(row?.properties).map(String).filter((property) => !PERSONAL_PROPERTY.test(property));
    definitions[id] = freeze({ id, properties: freeze(properties) });
  }
  return freeze({
    version: ANALYTICS_MODULE_VERSION,
    definitions: freeze(definitions),
    ids: freeze(Object.keys(definitions)),
    consentRequired: consentRequired !== false,
    retentionDays: Number(retentionDays) > 0 ? Number(retentionDays) : 365,
  });
}

/** Strip everything not allow-listed, and refuse anything that looks like a person. */
export function sanitiseProperties(definition, properties = {}) {
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(properties || {})) {
    if (!definition.properties.includes(key)) { dropped.push({ key, reason: ANALYTICS_ERROR.PROPERTY_NOT_ALLOWED }); continue; }
    if (PERSONAL_PROPERTY.test(key) || (typeof value === "string" && EMAIL_VALUE.test(value))) {
      dropped.push({ key, reason: ANALYTICS_ERROR.PERSONAL_DATA });
      continue;
    }
    kept[key] = typeof value === "object" && value !== null ? JSON.stringify(value).slice(0, 200) : value;
  }
  return { properties: kept, dropped };
}

/**
 * @param {object} options
 * @param {object} options.schema compileAnalyticsEvents() output
 * @param {object} options.transport the SDK analytics surface { track, page }
 * @param {() => boolean} [options.hasConsent] whether telemetry may be sent at all
 */
export function createTelemetry({ schema, transport, hasConsent = null, quotaPerMinute = 60, now = () => Date.now() } = {}) {
  if (!schema?.definitions) throw new AnalyticsError(ANALYTICS_ERROR.UNAVAILABLE, "createTelemetry needs a compiled event schema");
  const sent = [];
  const refusals = [];
  const allowed = () => (schema.consentRequired ? hasConsent?.() === true : true);

  return {
    schema,
    /** What was refused and why. A dropped property should be visible, not silent. */
    refusals: () => freeze(refusals.map((row) => freeze({ ...row }))),

    async track(eventId, properties = {}) {
      const definition = schema.definitions[eventId];
      if (!definition) {
        refusals.push({ event: eventId, reason: ANALYTICS_ERROR.UNKNOWN_EVENT });
        throw new AnalyticsError(ANALYTICS_ERROR.UNKNOWN_EVENT,
          `no telemetry event "${eventId}" is declared`, { events: [...schema.ids] });
      }
      // Consent gates the SEND, not the declaration: an application still says what it would
      // send, and sends nothing until someone agrees.
      if (!allowed()) { refusals.push({ event: eventId, reason: "consent_absent" }); return { ok: false, reason: "consent_absent" }; }
      // A quota, because a tracking call inside a render loop is a bill, not a signal.
      const minuteAgo = now() - 60_000;
      while (sent.length && sent[0] < minuteAgo) sent.shift();
      if (sent.length >= quotaPerMinute) { refusals.push({ event: eventId, reason: "quota_exceeded" }); return { ok: false, reason: "quota_exceeded" }; }
      const { properties: safe, dropped } = sanitiseProperties(definition, properties);
      for (const row of dropped) refusals.push({ event: eventId, ...row });
      sent.push(now());
      try {
        await transport?.track?.(eventId, safe);
        return { ok: true, event: eventId, properties: safe, dropped };
      } catch (error) {
        refusals.push({ event: eventId, reason: ANALYTICS_ERROR.UNAVAILABLE, message: String(error?.message || error) });
        // Telemetry failing must never fail the thing being measured.
        return { ok: false, reason: ANALYTICS_ERROR.UNAVAILABLE };
      }
    },
  };
}

// ── domain metrics ───────────────────────────────────────────────────────────

export const AGGREGATIONS = Object.freeze(["count", "sum", "avg", "min", "max"]);
export const BUCKETS = Object.freeze(["day", "week", "month", "year"]);

/**
 * Compile the declared metrics.
 *   metrics: [{ id, entity, aggregation, field?, filters?, groupBy?, bucket?, grant? }]
 * A metric names the entity it reads and the field it aggregates, both checked against the schema,
 * so a metric can never be computed over a field that does not exist or a field the query layer
 * would not allow.
 */
export function compileMetrics(metrics = [], { schema = null } = {}) {
  const definitions = {};
  for (const row of listOf(metrics)) {
    const id = String(row?.id || "").trim();
    const entity = String(row?.entity || "").trim();
    if (!id || !entity) continue;
    const aggregation = AGGREGATIONS.includes(row?.aggregation) ? row.aggregation : "count";
    const field = row?.field ? String(row.field) : null;
    const fields = schema?.entities?.[entity]?.fields || null;
    if (fields && field && !Object.hasOwn(fields, field)) {
      throw new AnalyticsError(ANALYTICS_ERROR.FIELD_NOT_ALLOWED,
        `metric "${id}" aggregates ${entity}.${field}, which the schema does not declare`, { entity, field });
    }
    if (aggregation !== "count" && !field) {
      throw new AnalyticsError(ANALYTICS_ERROR.FIELD_NOT_ALLOWED, `metric "${id}" is a ${aggregation} with no field`);
    }
    definitions[id] = freeze({
      id, entity, aggregation, field,
      filters: freeze({ ...(row?.filters || {}) }),
      groupBy: row?.groupBy ? String(row.groupBy) : null,
      bucket: BUCKETS.includes(row?.bucket) ? row.bucket : null,
      grant: row?.grant ? String(row.grant) : null,
    });
  }
  return freeze({ version: ANALYTICS_MODULE_VERSION, definitions: freeze(definitions), ids: freeze(Object.keys(definitions)) });
}

const bucketOf = (value, bucket) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (bucket === "year") return `${year}`;
  if (bucket === "month") return `${year}-${month}`;
  if (bucket === "week") {
    const start = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
    return start.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
};

/** Aggregate records exactly. Exported so the arithmetic is testable against a known fixture. */
export function aggregate(definition, records = []) {
  const rows = listOf(records).map((record) => ({ ...(record?.values || record), createdAt: record?.createdAt ?? record?.values?.createdAt }));
  const key = (record) => {
    if (definition.bucket) return bucketOf(record[definition.groupBy || "createdAt"], definition.bucket);
    return definition.groupBy ? String(record[definition.groupBy] ?? "unknown") : "all";
  };
  const groups = new Map();
  for (const record of rows) {
    const bucket = key(record);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(record);
  }
  const compute = (values) => {
    if (definition.aggregation === "count") return values.length;
    // An absent value is ABSENT, not zero. Number(null) is 0, and letting that through turns
    // "the average of what we know" into a number that is simply wrong — quietly, and in a
    // direction that always looks lower than reality.
    const numbers = values
      .map((record) => record[definition.field])
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(Number)
      .filter((value) => Number.isFinite(value));
    if (!numbers.length) return definition.aggregation === "sum" ? 0 : null;
    if (definition.aggregation === "sum") return numbers.reduce((total, value) => total + value, 0);
    if (definition.aggregation === "avg") return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    if (definition.aggregation === "min") return Math.min(...numbers);
    return Math.max(...numbers);
  };
  const series = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, values]) => ({ key: bucket, value: compute(values), count: values.length }));
  return freeze({
    metric: definition.id,
    value: definition.groupBy || definition.bucket ? null : compute(rows),
    series: freeze(series),
    total: rows.length,
  });
}

/**
 * @param {object} options
 * @param {object} options.metrics compileMetrics() output
 * @param {(entity: string, filters: object) => Promise<any[]>} options.read reads ALL matching
 *   records for a metric — never one page. A metric computed over a page is a wrong answer
 *   presented with confidence, which is the defect this replaces.
 * @param {(grant: string) => Promise<boolean>|boolean} [options.authorize]
 */
export function createMetrics({ metrics, read, authorize = null } = {}) {
  if (!metrics?.definitions) throw new AnalyticsError(ANALYTICS_ERROR.UNAVAILABLE, "createMetrics needs compiled metrics");
  if (typeof read !== "function") throw new AnalyticsError(ANALYTICS_ERROR.UNAVAILABLE, "createMetrics needs a read adapter");
  const listeners = new Set();
  let state = { status: "idle", results: {}, error: null };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, results: freeze({ ...state.results }) });
    return snapshot;
  };

  return {
    metrics,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    definition: (id) => metrics.definitions[id] || null,

    /** One metric, computed over every matching record. Authorised first when it names a grant. */
    async value(id, { filters = {} } = {}) {
      const definition = metrics.definitions[id];
      if (!definition) {
        throw new AnalyticsError(ANALYTICS_ERROR.UNKNOWN_METRIC,
          `no metric "${id}" is declared for this application`, { metrics: [...metrics.ids] });
      }
      if (definition.grant && authorize && (await authorize(definition.grant)) === false) {
        commit({ status: "error", error: { code: "forbidden", message: `not allowed to read ${id}` } });
        return { ok: false, reason: "forbidden", metric: id };
      }
      commit({ status: "loading", error: null });
      try {
        const records = await read(definition.entity, { ...definition.filters, ...filters });
        const result = aggregate(definition, records);
        commit({ status: "ready", results: { ...state.results, [id]: result }, error: null });
        return { ok: true, ...result };
      } catch (error) {
        commit({ status: "error", error: { code: ANALYTICS_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: ANALYTICS_ERROR.UNAVAILABLE, metric: id };
      }
    },

    /** Several metrics at once, for a dashboard that should not fire six sequential reads. */
    async report(ids = [], options = {}) {
      const results = await Promise.all(listOf(ids).map((id) => this.value(id, options)));
      return freeze(Object.fromEntries(listOf(ids).map((id, index) => [id, results[index]])));
    },
  };
}
