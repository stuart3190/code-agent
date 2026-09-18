// The settings and audit installation plan (WP8).
//
// A contract that says "the administrator sets the default lux level" has historically produced a
// generic entity with one fabricated record and generated code guessing its defaults — the audit's
// "Settings singleton inferred from prose" (§12). This derives the explicit alternative: typed
// keys with a declared scope, a declared default and a version, plus the audit configuration.
//
// The claim is deliberately NARROW. An entity becomes platform settings only when it is genuinely
// a singleton: settings-shaped name, no create and no collection read, and no key-like field that
// would make it a keyed lookup table. A per-room-type defaults table is domain data and stays a
// domain entity, because claiming it would silently delete a real application concept.

import { isSettingsSingleton } from "../../../../shared/contractOwnership.mjs";

export const SETTINGS_PLAN_VERSION = 1;

const SENSITIVE_FIELD = /(?:secret|token|api[-_ ]?key|password|credential)/i;

// The claim itself lives in the shared ownership layer, where the contract is typed, so the
// normaliser and this plan can never disagree about what counts as the singleton.
export { isSettingsSingleton };

function declarationFor(field) {
  const name = String(field?.name || field);
  const options = Array.isArray(field?.options) ? field.options : Array.isArray(field?.enum) ? field.enum : null;
  return {
    key: name,
    scope: "app",
    ...(options ? { options: options.map(String) } : { type: normaliseType(field?.type) }),
    ...(field?.default !== undefined ? { default: field.default } : {}),
    ...(SENSITIVE_FIELD.test(name) ? { sensitive: true } : {}),
  };
}

function normaliseType(raw) {
  const key = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (["number", "numeric", "float", "decimal", "currency", "money"].includes(key)) return "number";
  if (["int", "integer", "count"].includes(key)) return "integer";
  if (["bool", "boolean", "flag"].includes(key)) return "boolean";
  if (["json", "object", "array", "list"].includes(key)) return "json";
  if (["text", "longtext", "richtext", "textarea"].includes(key)) return "text";
  return "string";
}

/**
 * @param {object} contract the typed contract
 * @param {object} [options]
 * @param {string[]} [options.requestedHistory] resources whose history the contract asks for
 */
export function deriveSettingsPlan(contract, { entitySchema = null } = {}) {
  const singletons = (contract?.entities || []).filter((entity) => entity.platform === "settings"
    || isSettingsSingleton(contract, entity));
  const declarations = singletons.flatMap((entity) => (entity.fields || [])
    .filter((field) => !/^(?:id|settings?[-_ ]?id)$/i.test(String(field?.name || field)))
    .map(declarationFor));
  // History is requested by the contract's own vocabulary: a journey that reviews changes, or an
  // administration surface that shows who changed what. Never inferred from a domain noun alone.
  const historyText = [
    ...(contract?.journeys || []).map((journey) => `${journey.id} ${journey.title}`),
    ...(contract?.operations || []).map((operation) => `${operation.id} ${operation.description || ""}`),
  ].join(" ").toLowerCase();
  const auditRequested = /\b(?:audit|history|activity log|change log|changelog|who changed)\b/.test(historyText);
  const sensitiveFields = [
    ...new Set([
      ...declarations.filter((row) => row.sensitive).map((row) => row.key),
      ...(entitySchema?.entities || []).flatMap((entity) => Object.keys(entitySchema.schema.entities[entity].fields))
        .filter((name) => SENSITIVE_FIELD.test(name)),
    ]),
  ];
  return {
    version: SETTINGS_PLAN_VERSION,
    module: "thrallo.settings",
    entities: singletons.map((entity) => entity.name),
    declarations,
    audit: { enabled: auditRequested, sensitiveFields },
    verification: settingsVerificationPlan(declarations, { auditRequested }),
  };
}

/** Deterministic probes: a declared default answers before anything is written, and scopes isolate. */
export function settingsVerificationPlan(declarations = [], { auditRequested = false } = {}) {
  const probes = [];
  if (declarations.length) {
    probes.push({ id: "settings.default", keys: declarations.map((row) => row.key), expect: "the declared default answers a read that was never written" });
    probes.push({ id: "settings.write", expect: "an administrator's change survives a reload" });
    probes.push({ id: "settings.denied", expect: "a member cannot change an application-wide value" });
  }
  if (auditRequested) {
    probes.push({ id: "history.append", expect: "an administrative change appears in history, attributed" });
    probes.push({ id: "history.redaction", expect: "no sensitive value appears in any event" });
    probes.push({ id: "history.denied", expect: "a member without the grant cannot read history" });
  }
  return probes;
}
