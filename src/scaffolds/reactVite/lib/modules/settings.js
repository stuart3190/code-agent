// Settings/preferences module v1 — platform infrastructure, do not edit or reimplement.
//
// A setting is a TYPED key with an explicit scope, an explicit default and a version — never a
// record fabricated as an ordinary entity (audit §5 "Settings/defaults", §12). Three scopes:
//
//   app       one value for the whole application; only an authorised member may write it
//   user      one value per signed-in member, readable and writable by that member
//   workspace one value per durable record (a project, a team), governed by that record's policy
//
// Reading a key that was never written returns its declared default, so a screen never has to
// invent one and two screens can never disagree about it. Writing validates against the declared
// type and allowed values. The module owns the value; how it is presented is the application's.

export const SETTINGS_MODULE_VERSION = "1.0.0";

export const SETTING_SCOPES = Object.freeze(["app", "user", "workspace"]);
export const SETTING_TYPES = Object.freeze(["string", "text", "number", "integer", "boolean", "enum", "json"]);

export const SETTINGS_ERROR = Object.freeze({
  UNKNOWN_KEY: "setting_unknown",
  INVALID_VALUE: "setting_invalid_value",
  SCOPE_REQUIRED: "setting_scope_target_required",
  FORBIDDEN: "forbidden",
  UNAVAILABLE: "settings_unavailable",
});

export class SettingsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);

/**
 * Compile a settings declaration into a definition table.
 *   declarations: [{ key, scope, type, default, options?, label?, sensitive? }]
 */
export function compileSettings(declarations = []) {
  const definitions = {};
  for (const row of declarations) {
    const key = String(row?.key || "").trim();
    if (!key) continue;
    const scope = SETTING_SCOPES.includes(row?.scope) ? row.scope : "app";
    const options = Array.isArray(row?.options) ? row.options.map(String) : null;
    const type = options ? "enum" : SETTING_TYPES.includes(row?.type) ? row.type : "string";
    definitions[key] = freeze({
      key, scope, type,
      default: row?.default ?? (type === "boolean" ? false : type === "number" || type === "integer" ? 0 : options ? options[0] : ""),
      ...(options ? { options: freeze(options) } : {}),
      ...(row?.sensitive === true ? { sensitive: true } : {}),
      version: Number(row?.version) > 0 ? Number(row.version) : 1,
    });
  }
  return freeze({ version: SETTINGS_MODULE_VERSION, definitions: freeze(definitions), keys: freeze(Object.keys(definitions)) });
}

/** Validate and coerce one value against its definition. Throws SettingsError on a bad value. */
export function coerceSetting(definition, value) {
  if (!definition) throw new SettingsError(SETTINGS_ERROR.UNKNOWN_KEY, "no such setting");
  switch (definition.type) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (["true", "1", "on", "yes"].includes(String(value).toLowerCase())) return true;
      if (["false", "0", "off", "no", ""].includes(String(value).toLowerCase())) return false;
      throw new SettingsError(SETTINGS_ERROR.INVALID_VALUE, `${definition.key} expects true or false`);
    }
    case "number": case "integer": {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) throw new SettingsError(SETTINGS_ERROR.INVALID_VALUE, `${definition.key} expects a number`);
      return definition.type === "integer" ? Math.trunc(number) : number;
    }
    case "enum": {
      const text = String(value);
      if (!definition.options?.includes(text)) {
        throw new SettingsError(SETTINGS_ERROR.INVALID_VALUE, `${definition.key} expects one of ${definition.options?.join(", ")}`, { options: [...(definition.options || [])] });
      }
      return text;
    }
    case "json": {
      if (value === undefined) throw new SettingsError(SETTINGS_ERROR.INVALID_VALUE, `${definition.key} expects a value`);
      return value;
    }
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** The scope target a key needs: a workspace key needs a record id; app and user keys do not. */
export function scopeTargetFor(definition, target) {
  if (definition.scope !== "workspace") return null;
  if (!target) throw new SettingsError(SETTINGS_ERROR.SCOPE_REQUIRED, `${definition.key} is scoped to a workspace and needs its id`);
  return String(target);
}

/**
 * @param {object} options
 * @param {object} options.schema compileSettings() output
 * @param {object} options.transport { get(scope, target), set(scope, target, key, value) } — the
 *   settings service surface; values are returned as a plain key/value map per scope.
 */
export function createSettingsController({ schema, transport } = {}) {
  if (!schema?.definitions) throw new Error("createSettingsController: a compiled settings schema is required");
  if (!transport || typeof transport.get !== "function") throw new Error("createSettingsController: a settings transport is required");
  const listeners = new Set();
  const cacheKey = (scope, target) => `${scope}:${target || "-"}`;
  let state = freeze({ status: "idle", values: freeze({}), error: null });
  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => { state = freeze({ ...state, ...patch }); emit(); return state; };
  const loaded = new Map();

  const definitionFor = (key) => {
    const definition = schema.definitions[key];
    if (!definition) throw new SettingsError(SETTINGS_ERROR.UNKNOWN_KEY, `no setting "${key}" is declared for this application`, { keys: [...schema.keys] });
    return definition;
  };

  async function ensureScope(scope, target) {
    const identity = cacheKey(scope, target);
    if (loaded.has(identity)) return loaded.get(identity);
    set({ status: "loading", error: null });
    try {
      const values = await transport.get(scope, target);
      loaded.set(identity, values || {});
      set({ status: "ready", values: freeze({ ...state.values, [identity]: freeze({ ...(values || {}) }) }), error: null });
      return loaded.get(identity);
    } catch (error) {
      const classified = { code: error?.code || SETTINGS_ERROR.UNAVAILABLE, message: String(error?.message || error) };
      set({ status: "error", error: classified });
      // A settings service that is unavailable must not take the application down: declared
      // defaults still answer every read, and the error stays visible in state.
      loaded.set(identity, {});
      return {};
    }
  }

  return {
    schema,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** The declared value, or its default when nothing was ever written. Never undefined. */
    async get(key, { target = null } = {}) {
      const definition = definitionFor(key);
      const scopeTarget = scopeTargetFor(definition, target);
      const values = await ensureScope(definition.scope, scopeTarget);
      return Object.hasOwn(values, key) ? values[key] : definition.default;
    },
    /** Every declared key of one scope, defaults filled in. */
    async all({ scope = "app", target = null } = {}) {
      const values = await ensureScope(scope, target);
      return freeze(Object.fromEntries(schema.keys.filter((key) => schema.definitions[key].scope === scope)
        .map((key) => [key, Object.hasOwn(values, key) ? values[key] : schema.definitions[key].default])));
    },
    async set(key, value, { target = null } = {}) {
      const definition = definitionFor(key);
      const scopeTarget = scopeTargetFor(definition, target);
      const coerced = coerceSetting(definition, value);
      const saved = await transport.set(definition.scope, scopeTarget, key, coerced);
      const identity = cacheKey(definition.scope, scopeTarget);
      const next = { ...(loaded.get(identity) || {}), [key]: coerced };
      loaded.set(identity, next);
      set({ status: "ready", values: freeze({ ...state.values, [identity]: freeze(next) }), error: null });
      return saved ?? coerced;
    },
    /** Return a key to its declared default. */
    async reset(key, { target = null } = {}) {
      const definition = definitionFor(key);
      return this.set(key, definition.default, { target });
    },
    /** Drop the cache so the next read reaches the service again. */
    invalidate() { loaded.clear(); set({ status: "idle", values: freeze({}), error: null }); },
    definition: definitionFor,
  };
}
