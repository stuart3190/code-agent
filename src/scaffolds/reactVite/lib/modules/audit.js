// Audit/history module v1 — platform infrastructure, do not edit or reimplement.
//
// An audit event is an APPEND-ONLY fact about who did what to which resource (audit §7.2). Two
// rules make it worth having:
//
//   1. Events are appended by the platform, never by generated application code. Nothing here
//      writes: this module reads authorised history and redacts it. An application that could
//      write its own history could also write a false one.
//   2. Sensitive values never enter an event. `redactEvent` is applied on the server before a row
//      is stored AND here before anything is rendered, so a field declared sensitive cannot leak
//      through an event even if an older row already contains it.

export const AUDIT_MODULE_VERSION = "1.0.0";

export const AUDIT_REDACTED = "[redacted]";

/** Field names that are never recorded in an event, whatever an application calls them. */
export const ALWAYS_SENSITIVE = Object.freeze([
  "password", "authPassword", "passwordHash", "passcode", "token", "authToken", "sessionToken",
  "accessToken", "refreshToken", "resetToken", "secret", "apiKey", "creditCard", "cardNumber", "cvv",
]);

const normalise = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sensitiveSet = (extra = []) => new Set([...ALWAYS_SENSITIVE, ...extra].map(normalise).filter(Boolean));

/** Redact the sensitive fields of one value map, recursively, without changing its shape. */
export function redactValues(values, sensitive = new Set()) {
  if (!values || typeof values !== "object") return values;
  if (Array.isArray(values)) return values.map((entry) => redactValues(entry, sensitive));
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (sensitive.has(normalise(key))) out[key] = AUDIT_REDACTED;
    else if (value && typeof value === "object") out[key] = redactValues(value, sensitive);
    else out[key] = value;
  }
  return out;
}

/**
 * Redact one event. `sensitiveFields` comes from the application's declared schema; the always-
 * sensitive names apply on top of it and cannot be switched off.
 */
export function redactEvent(event, { sensitiveFields = [] } = {}) {
  const sensitive = sensitiveSet(sensitiveFields);
  return Object.freeze({
    ...event,
    before: event?.before ? Object.freeze(redactValues(event.before, sensitive)) : null,
    after: event?.after ? Object.freeze(redactValues(event.after, sensitive)) : null,
  });
}

/** The fields that changed between two value maps, with sensitive values already redacted. */
export function changedFields(event) {
  const before = event?.before || {};
  const after = event?.after || {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/**
 * @param {object} options
 * @param {object} options.transport { list({ resource, resourceId, limit, cursor }) } — the
 *   authorised history surface. There is deliberately no append: the platform owns that.
 * @param {string[]} [options.sensitiveFields]
 */
export function createHistoryController({ transport, sensitiveFields = [] } = {}) {
  if (!transport || typeof transport.list !== "function") throw new Error("createHistoryController: a history transport is required");
  const listeners = new Set();
  let state = Object.freeze({ status: "idle", events: Object.freeze([]), nextCursor: null, error: null });
  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => { state = Object.freeze({ ...state, ...patch }); emit(); return state; };
  let generation = 0;

  async function load(query = {}, { append = false } = {}) {
    const mine = ++generation;
    set({ status: "loading", error: null });
    try {
      const page = await transport.list(query);
      if (generation !== mine) return state;
      const events = (page?.events || []).map((event) => redactEvent(event, { sensitiveFields }));
      const all = append ? [...state.events, ...events] : events;
      return set({ status: all.length ? "ready" : "empty", events: Object.freeze(all), nextCursor: page?.nextCursor || null, error: null });
    } catch (error) {
      if (generation !== mine) return state;
      return set({ status: "error", error: { code: error?.code || "history_unavailable", message: String(error?.message || error) } });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Authorised history, newest first. The server decides what this actor may see. */
    load: (query = {}) => load(query),
    more() { return state.nextCursor ? load({ cursor: state.nextCursor }, { append: true }) : Promise.resolve(state); },
    changedFields,
  };
}
