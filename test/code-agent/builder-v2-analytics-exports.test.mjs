// WP11 — analytics and exports.
//
// The audit asks for one thing above all here: separate telemetry from domain metrics. They are
// different data with different rules, and generated code conflated them — tracking domain values
// into a product-usage stream, and answering "total revenue" by reducing whatever page of records
// happened to be loaded.
//
// Exports were worse. The audit records UI-only "exports" that opened a print dialogue and
// produced no file, downloads of what was on screen rather than what was asked for, and CSVs
// built by joining values with commas, which corrupt the moment a value contains one.
//
// Required proof: known-fixture aggregates, authorized export content, real downloads.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGGREGATIONS, ANALYTICS_ERROR, AnalyticsError, aggregate, compileAnalyticsEvents, compileMetrics,
  createMetrics, createTelemetry, sanitiseProperties,
} from "../../src/scaffolds/reactVite/lib/modules/analytics.js";
import {
  EXPORT_ERROR, EXPORT_FORMATS, ExportError, compileExports, createExports, escapeCell, serialize,
} from "../../src/scaffolds/reactVite/lib/modules/exports.js";
import { compileSchema } from "../../src/scaffolds/reactVite/lib/modules/schema.js";
import {
  deriveExportPlan, deriveInsightPlan, deriveMetricPlan, deriveTelemetryPlan,
} from "../../shell/server/lib/builderV2/platformModules/insightPlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_EXPORTS_PATH, APP_FACADE_METRICS_PATH, ANALYTICS_COMPOSED_PATH,
  EXPORTS_COMPOSED_PATH, METRICS_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { normalizeContractOwnership } from "../../shell/shared/contractOwnership.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const SCHEMA = compileSchema([{ name: "booking", fields: [
  { name: "room", type: "string", required: true }, { name: "amount", type: "number" },
  { name: "status", options: ["paid", "due"] }, { name: "apiToken", type: "string" },
] }]);

// A known fixture: every aggregate below is arithmetic a reader can check by hand.
const RECORDS = [
  { id: "1", createdAt: "2026-09-01T10:00:00Z", values: { room: "A", amount: 100, status: "paid" } },
  { id: "2", createdAt: "2026-09-14T12:00:00Z", values: { room: "B", amount: 250, status: "paid" } },
  { id: "3", createdAt: "2026-10-02T09:00:00Z", values: { room: "A", amount: 50, status: "due" } },
  { id: "4", createdAt: "2026-10-20T09:00:00Z", values: { room: "A", amount: null, status: "due" } },
];

test("WP11 — telemetry carries only allow-listed, impersonal properties, and sends nothing without consent", async () => {
  const schema = compileAnalyticsEvents([{ id: "quote_started", properties: ["plan", "step", "customerEmail"] }]);
  assert.deepEqual(schema.definitions.quote_started.properties, ["plan", "step"],
    "a personal property is stripped at compile time, so it cannot be sent even by mistake");

  const sent = [];
  let consent = false;
  const telemetry = createTelemetry({
    schema, transport: { track: async (id, properties) => sent.push([id, properties]) }, hasConsent: () => consent,
  });

  const before = await telemetry.track("quote_started", { plan: "pro" });
  assert.equal(before.ok, false);
  assert.equal(before.reason, "consent_absent");
  assert.equal(sent.length, 0, "nothing leaves the browser before someone agrees");

  consent = true;
  const tracked = await telemetry.track("quote_started", { plan: "pro", step: 2, notes: "hello", email: "a@b.c" });
  assert.equal(tracked.ok, true);
  assert.deepEqual(tracked.properties, { plan: "pro", step: 2 });
  assert.deepEqual(tracked.dropped.map((row) => row.key).sort(), ["email", "notes"]);
  assert.deepEqual(sent, [["quote_started", { plan: "pro", step: 2 }]]);

  // An undeclared event is refused outright: a stream whose shape drifts is a stream nobody trusts.
  await assert.rejects(() => telemetry.track("made_up", {}),
    (error) => error instanceof AnalyticsError && error.code === ANALYTICS_ERROR.UNKNOWN_EVENT);

  // Even an allow-listed property refuses a value that is plainly a person.
  const emailish = compileAnalyticsEvents([{ id: "signup", properties: ["referrer"] }]);
  assert.deepEqual(sanitiseProperties(emailish.definitions.signup, { referrer: "someone@example.com" }).dropped,
    [{ key: "referrer", reason: ANALYTICS_ERROR.PERSONAL_DATA }]);

  // A quota, because a track() inside a render loop is a bill rather than a signal.
  const noisy = createTelemetry({ schema, transport: { track: async () => {} }, hasConsent: () => true, quotaPerMinute: 2 });
  await noisy.track("quote_started", {});
  await noisy.track("quote_started", {});
  assert.equal((await noisy.track("quote_started", {})).reason, "quota_exceeded");

  // Telemetry failing must never fail the thing being measured.
  const broken = createTelemetry({ schema, transport: { track: async () => { throw new Error("down"); } }, hasConsent: () => true });
  assert.equal((await broken.track("quote_started", {})).ok, false);
  assert.equal(broken.refusals().at(-1).reason, ANALYTICS_ERROR.UNAVAILABLE);
});

test("WP11 — a metric is exact arithmetic over a known fixture, grouped and bucketed as declared", () => {
  const metrics = compileMetrics([
    { id: "revenue", entity: "booking", aggregation: "sum", field: "amount" },
    { id: "average", entity: "booking", aggregation: "avg", field: "amount" },
    { id: "largest", entity: "booking", aggregation: "max", field: "amount" },
    { id: "count", entity: "booking", aggregation: "count" },
    { id: "byRoom", entity: "booking", aggregation: "sum", field: "amount", groupBy: "room" },
    { id: "byMonth", entity: "booking", aggregation: "count", bucket: "month" },
  ], { schema: SCHEMA });

  assert.equal(aggregate(metrics.definitions.revenue, RECORDS).value, 400);
  assert.equal(aggregate(metrics.definitions.count, RECORDS).value, 4);
  assert.equal(aggregate(metrics.definitions.largest, RECORDS).value, 250);
  // The null amount is excluded from the average rather than counted as a zero, which is the
  // difference between "average of what we know" and a number that is simply wrong.
  assert.equal(aggregate(metrics.definitions.average, RECORDS).value, 400 / 3);
  assert.deepEqual(aggregate(metrics.definitions.byRoom, RECORDS).series,
    [{ key: "A", value: 150, count: 3 }, { key: "B", value: 250, count: 1 }]);
  assert.deepEqual(aggregate(metrics.definitions.byMonth, RECORDS).series,
    [{ key: "2026-09", value: 2, count: 2 }, { key: "2026-10", value: 2, count: 2 }]);
  assert.equal(aggregate(metrics.definitions.revenue, []).value, 0);
  assert.equal(aggregate(metrics.definitions.average, []).value, null, "an average of nothing is not zero");
  assert.deepEqual([...AGGREGATIONS], ["count", "sum", "avg", "min", "max"]);
});

test("WP11 — a metric over an undeclared field is refused at compile time, and an unauthorised one is refused at read", async () => {
  assert.throws(() => compileMetrics([{ id: "bad", entity: "booking", aggregation: "sum", field: "ghost" }], { schema: SCHEMA }),
    (error) => error instanceof AnalyticsError && error.code === ANALYTICS_ERROR.FIELD_NOT_ALLOWED);
  assert.throws(() => compileMetrics([{ id: "bad", entity: "booking", aggregation: "sum" }], { schema: SCHEMA }),
    (error) => error.code === ANALYTICS_ERROR.FIELD_NOT_ALLOWED, "a sum with no field is not a metric");

  const metrics = compileMetrics([
    { id: "revenue", entity: "booking", aggregation: "sum", field: "amount" },
    { id: "secret", entity: "booking", aggregation: "count", grant: "reports.read" },
  ], { schema: SCHEMA });

  let reads = 0;
  const controller = createMetrics({
    metrics,
    read: async () => { reads += 1; return RECORDS; },
    authorize: async (grant) => grant !== "reports.read",
  });

  const value = await controller.value("revenue");
  assert.equal(value.ok, true);
  assert.equal(value.value, 400);
  assert.equal(reads, 1, "one read of every matching record, not one per row");
  assert.equal(controller.getState().results.revenue.value, 400);

  const denied = await controller.value("secret");
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "forbidden");
  assert.equal(reads, 1, "an unauthorised metric never reaches the data");

  await assert.rejects(() => controller.value("nonexistent"),
    (error) => error.code === ANALYTICS_ERROR.UNKNOWN_METRIC);

  const report = await controller.report(["revenue"]);
  assert.equal(report.revenue.value, 400);

  const broken = createMetrics({ metrics, read: async () => { throw new Error("db down"); } });
  assert.equal((await broken.value("revenue")).reason, ANALYTICS_ERROR.UNAVAILABLE);
  assert.equal(broken.getState().status, "error");
});

test("WP11 — an export is a real artifact: correct quoting, neutralised formulas, declared columns", async () => {
  const definitions = compileExports([
    { id: "bookings", entity: "booking", columns: ["room", { field: "amount", label: "Amount" }, "status", "apiToken", "ghost"], filename: "bookings" },
  ], { schema: SCHEMA });
  assert.deepEqual(definitions.definitions.bookings.columns.map((column) => column.field),
    ["room", "amount", "status", "apiToken"], "a column the schema does not declare is dropped");

  // The three shapes that corrupt a hand-built CSV.
  const tricky = [
    { id: "1", values: { room: 'Room "A", north', amount: 100, status: "paid" } },
    { id: "2", values: { room: "=1+1", amount: 250, status: "due" } },
    { id: "3", values: { room: "line\nbreak", amount: null, status: "due" } },
  ];
  const controller = createExports({
    schema: definitions, read: async () => tricky, now: () => new Date("2026-09-18T00:00:00Z"),
  });
  const built = await controller.build("bookings");
  assert.equal(built.ok, true);
  const lines = built.artifact.body.split("\n");
  assert.equal(lines[0], "room,Amount,status,apiToken");
  assert.equal(lines[1], '"Room ""A"", north",100,paid,', "a comma and a quote survive the round trip");
  assert.equal(lines[2], "'=1+1,250,due,", "a leading = would otherwise become a spreadsheet formula");
  assert.equal(lines[3], '"line', "a newline is quoted rather than breaking the row");
  assert.equal(built.artifact.mediaType, "text/csv");
  assert.equal(built.artifact.filename, "bookings-2026-09-18.csv");
  assert.equal(built.artifact.rows, 3, "the artifact states its own row count, so a caller can check it");
  assert.ok(built.artifact.bytes > 0);

  assert.equal(escapeCell("plain"), "plain");
  assert.equal(escapeCell(null), "");
  assert.equal(escapeCell("a,b"), '"a,b"');
  assert.equal(escapeCell("a\tb", "\t"), '"a\tb"');
  assert.equal(escapeCell("@SUM(A1)"), "'@SUM(A1)");

  // JSON and TSV are the same declared columns in another shape.
  const asJson = await controller.build("bookings", { format: "json" });
  assert.deepEqual(Object.keys(JSON.parse(asJson.artifact.body)[0]), ["room", "amount", "status", "apiToken"]);
  assert.equal(asJson.artifact.mediaType, "application/json");
  const asTsv = await controller.build("bookings", { format: "tsv" });
  assert.equal(asTsv.artifact.body.split("\n")[0], "room\tAmount\tstatus\tapiToken");
  assert.deepEqual([...EXPORT_FORMATS], ["csv", "json", "tsv"]);
  assert.equal(serialize(definitions.definitions.bookings, []).trim(), "room,Amount,status,apiToken");
});

test("WP11 — the export reads EVERY matching record, and an unauthorised export never reaches the data", async () => {
  const definitions = compileExports([
    { id: "bookings", entity: "booking", columns: ["room", "amount"] },
    { id: "restricted", entity: "booking", columns: ["room"], grant: "exports.read" },
  ], { schema: SCHEMA });

  let requestedFilters = null;
  const controller = createExports({
    schema: definitions,
    read: async (entity, filters) => { requestedFilters = { entity, filters }; return RECORDS; },
    authorize: async (grant) => grant !== "exports.read",
  });

  const built = await controller.build("bookings", { filters: { status: "paid" } });
  assert.equal(built.artifact.rows, 4, "the artifact holds what the query matched");
  assert.deepEqual(requestedFilters, { entity: "booking", filters: { status: "paid" } },
    "the filter reaches the store: the export is re-read, not taken from a loaded page");

  const denied = await controller.build("restricted");
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, EXPORT_ERROR.NOT_AUTHORIZED);
  assert.equal(controller.getState().artifact, null, "nothing was built to leak");

  await assert.rejects(() => controller.build("ghost"),
    (error) => error instanceof ExportError && error.code === EXPORT_ERROR.UNKNOWN_EXPORT);
  await assert.rejects(() => controller.build("bookings", { format: "pdf" }),
    (error) => error.code === EXPORT_ERROR.UNKNOWN_FORMAT);

  const empty = createExports({ schema: definitions, read: async () => [] });
  const none = await empty.build("bookings");
  assert.equal(none.artifact.rows, 0);
  assert.equal(empty.getState().status, "empty", "an empty export is empty, not a failure");
  assert.throws(() => empty.download(null), (error) => error.code === EXPORT_ERROR.EMPTY);
});

test("WP11 — download produces a real file through the browser, and revokes the object URL", async () => {
  const definitions = compileExports([{ id: "bookings", entity: "booking", columns: ["room"] }], { schema: SCHEMA });
  const controller = createExports({ schema: definitions, read: async () => RECORDS });
  const { artifact } = await controller.build("bookings");

  const created = [];
  const revoked = [];
  const clicked = [];
  const appended = [];
  const element = { set href(value) { this._href = value; }, get href() { return this._href; }, click() { clicked.push(this.download); } };
  const doc = {
    createElement: () => element,
    body: { appendChild: (node) => appended.push(node), removeChild: () => {} },
  };
  const url = {
    createObjectURL: (blob) => { created.push(blob); return "blob:artifact"; },
    revokeObjectURL: (href) => revoked.push(href),
  };
  const result = controller.download(artifact, { document: doc, url });
  assert.equal(result.ok, true);
  assert.equal(result.filename, artifact.filename);
  assert.equal(created.length, 1, "real bytes, not a print dialogue");
  assert.equal(created[0].type, "text/csv;charset=utf-8");
  assert.equal(await created[0].text(), artifact.body);
  assert.deepEqual(clicked, [artifact.filename]);
  assert.equal(appended.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(revoked, ["blob:artifact"], "the object URL is released rather than leaking the file");

  // Without a document there is nothing to hand it to, and that is said rather than thrown.
  assert.deepEqual(controller.download(artifact, { document: null, url }), { ok: false, reason: "no_document" });
});

test("WP11 — telemetry is never inferred from domain prose; metrics and exports are derived from structure", () => {
  // "Track the job", "room usage", "measure the beam" are domain sentences, and every retained
  // contract contains one. Reading them as a request for product analytics would install a
  // telemetry stream into applications that never asked for one.
  const domain = {
    summary: "field service jobs",
    journeys: [{ id: "j", title: "Engineer tracks a job and measures usage on site", steps: [] }],
    operations: [], entities: [],
  };
  assert.deepEqual(deriveTelemetryPlan(domain).events, []);
  assert.deepEqual(deriveTelemetryPlan({ ...domain, buildProfile: { requirementSignals: ["analytics"] } })
    .events.map((event) => event.id), ["page_view", "j_completed"]);

  // Metrics: a count operation, a dashboard route, or an aggregate statement — not the word "per".
  const schema = { entities: ["booking"], schema: { entities: { booking: { fields: {
    room: { type: "string" }, amount: { type: "number" }, status: { type: "enum", options: ["paid", "due"] },
    apiToken: { type: "string" },
  } } } } };
  assert.deepEqual(deriveMetricPlan({ summary: "the total for this quote", journeys: [], operations: [] }, { entitySchema: schema }).metrics, [],
    "one record's own total is not a dashboard");
  const asked = deriveMetricPlan({
    summary: "owner sees total revenue across all bookings over time", journeys: [], operations: [],
  }, { entitySchema: schema });
  assert.deepEqual(asked.metrics.map((metric) => metric.id),
    ["bookingCount", "bookingAmountTotal", "bookingAmountAverage", "bookingByStatus", "bookingByMonth"]);
  assert.equal(asked.metrics.some((metric) => metric.field === "apiToken"), false, "a secret is never a metric");
  assert.equal(asked.metrics.some((metric) => metric.groupBy === "room"), false,
    "grouping by free text produces one bucket per record: a list wearing a chart's clothes");

  // Exports: an artifact-typed operation names its entity and its columns.
  const exported = deriveExportPlan({
    operations: [{ id: "export-bookings", kind: "export", entity: "booking", output: { type: "artifact" } }],
    journeys: [],
  }, { entitySchema: schema });
  assert.deepEqual(exported.exports.map((row) => row.id), ["bookingExport"]);
  assert.deepEqual(exported.exports[0].columns, ["room", "amount", "status"], "apiToken never leaves");
  assert.deepEqual(deriveExportPlan({ operations: [], journeys: [] }, { entitySchema: schema }).exports, []);
  assert.deepEqual(deriveInsightPlan({ operations: [], journeys: [], entities: [] }, { entitySchema: schema }).verification, []);
});

const STUDIO = {
  version: 2, summary: "studio owner sees total revenue across all bookings and exports them",
  auth: { required: true },
  entities: [{ name: "booking", fields: [
    { name: "id" }, { name: "room", type: "string", required: true },
    { name: "amount", type: "number" }, { name: "status", options: ["paid", "due"] },
  ] }],
  operations: [
    { id: "create-booking", kind: "create", entity: "booking" },
    { id: "list-bookings", kind: "list", entity: "booking" },
    { id: "export-bookings", kind: "export", entity: "booking",
      responsibilities: [{ type: "functional", capability: "exports", capabilityMethod: "buildExport",
        behavior: "serialise the matching bookings", reads: ["room", "amount", "status"], writes: [] }] },
  ],
  journeys: [{ id: "owner", title: "Owner reviews totals and exports the bookings", steps: [
    { id: "o1", operates: ["create-booking"], expect: "the booking is stored" },
    { id: "o2", operates: ["list-bookings"], expect: "the bookings are listed" },
    { id: "o3", operates: ["export-bookings"], expect: "a CSV downloads with every booking" },
  ] }],
};

test("WP11 — a declaring contract locks metrics and exports and composes protected facades", () => {
  const spec = deriveBuildSpec(STUDIO);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const locked = spec.moduleLock.modules.map((row) => row.id);
  assert.ok(locked.includes("thrallo.analyticsQueries"));
  assert.ok(locked.includes("thrallo.exports"));
  assert.equal(locked.includes("thrallo.analyticsEvents"), false,
    "telemetry is a separate decision and this contract never asked for it");
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.exports").reasons,
    ["an operation produces a downloadable artifact"]);

  // The artifact operation is now the exports module's, not generated serialisation.
  const requirement = normalizeContractOwnership(STUDIO).report.platformRequirements.find((row) => row.type === "exports");
  assert.deepEqual([requirement.module, requirement.status, requirement.enforcement],
    ["thrallo.exports", "resolved", "block"]);

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan, insightPlan: spec.insightPlan,
  });
  assert.ok(tree[METRICS_COMPOSED_PATH].includes("compileMetrics("));
  assert.ok(tree[METRICS_COMPOSED_PATH].includes("limit: 10000"), "every matching record, not a page");
  assert.ok(tree[EXPORTS_COMPOSED_PATH].includes("compileExports("));
  assert.ok(tree[APP_FACADE_METRICS_PATH].includes("export function useMetric("));
  assert.ok(tree[APP_FACADE_EXPORTS_PATH].includes("export function useExport("));
  assert.equal(ANALYTICS_COMPOSED_PATH in tree, false, "no telemetry was composed");
  assert.ok(tree["src/lib/app/index.js"].includes('export * from "./exports.js";'));

  for (const path of [METRICS_COMPOSED_PATH, EXPORTS_COMPOSED_PATH, APP_FACADE_METRICS_PATH, APP_FACADE_EXPORTS_PATH]) {
    assert.ok(tree[path].includes("Protected deterministic foundation"));
    assert.ok(isProtectedPath(path), `${path} stays under the write guard`);
  }
  for (const path of ["src/lib/modules/analytics.js", "src/lib/modules/exports.js"]) {
    assert.equal(typeof REACT_VITE[path], "string", `${path} ships in the scaffold`);
    assert.ok(isProtectedPath(path));
  }
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.ok(moduleManifest("thrallo.analyticsEvents").requires.services.includes("analytics"));
  assert.ok(moduleManifest("thrallo.analyticsQueries").requires.modules.some((row) => row.id === "thrallo.query"));
});

test("WP11 — negative control: a plain CRUD contract gets no metrics, no exports and no telemetry", () => {
  const quiet = {
    version: 2, summary: "customer list", auth: { required: true },
    entities: [{ name: "customer", fields: [{ name: "id" }, { name: "name", type: "string", required: true }] }],
    operations: [
      { id: "add-customer", kind: "create", entity: "customer" },
      { id: "list-customers", kind: "list", entity: "customer" },
    ],
    journeys: [{ id: "admin", title: "Staff add a customer and see the list", steps: [
      { id: "a1", operates: ["add-customer"], expect: "the customer is stored" },
      { id: "a2", operates: ["list-customers"], expect: "the list shows them" },
    ] }],
  };
  const spec = deriveBuildSpec(quiet);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.deepEqual(spec.insightPlan.metrics, []);
  assert.deepEqual(spec.insightPlan.exports, []);
  assert.deepEqual(spec.insightPlan.telemetry.events, []);
  const locked = spec.moduleLock.modules.map((row) => row.id);
  for (const id of ["thrallo.analyticsEvents", "thrallo.analyticsQueries", "thrallo.exports"]) {
    assert.equal(locked.includes(id), false, `${id} was locked for a contract that never asked`);
  }
  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan, insightPlan: spec.insightPlan,
  });
  for (const path of [ANALYTICS_COMPOSED_PATH, METRICS_COMPOSED_PATH, EXPORTS_COMPOSED_PATH,
    APP_FACADE_METRICS_PATH, APP_FACADE_EXPORTS_PATH]) {
    assert.equal(path in tree, false, `${path} composed for a contract that declares none of it`);
  }
});
