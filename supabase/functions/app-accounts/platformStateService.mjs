// Settings and audit history — the server half of WP8.
//
// Pure ESM over a storage seam, like the account service, so the same logic runs in the Edge
// Function (service-role Supabase storage) and in the shell/tests (memory twin). Two rules the
// audit calls for hold here rather than in generated code:
//
//   - A setting has an explicit SCOPE. An application-wide value is administration and needs the
//     settings.write grant; a member's own preference needs no grant beyond being a member; a
//     workspace value is administration of that workspace. No scope is inferred from a name.
//   - History is APPEND-ONLY and the service never exposes a way to write it from an application.
//     Values are redacted before they are stored, so a sensitive field cannot reach a row at all.

import { evaluate } from "./policy.js";
import { redactEvent } from "./audit.js";

export const PLATFORM_STATE_SERVICE_VERSION = 1;

export class PlatformStateError extends Error {
  constructor(code, message, status = 403, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

const SCOPES = new Set(["app", "user", "workspace"]);

/** In-memory storage twin (tests, shell previews). */
export function memoryPlatformStateStorage({ settings = [], events = [], config = {} } = {}) {
  const state = { settings: [...settings], events: [...events], config: { ...config } };
  return {
    state,
    async getSettings(appId, scope, target) {
      return state.settings.filter((row) => row.appId === appId && row.scope === scope && (row.scopeTarget || null) === (target || null))
        .reduce((all, row) => ({ ...all, [row.key]: row.value }), {});
    },
    async setSetting(row) {
      const index = state.settings.findIndex((candidate) => candidate.appId === row.appId && candidate.scope === row.scope
        && (candidate.scopeTarget || null) === (row.scopeTarget || null) && candidate.key === row.key);
      const next = { ...(index >= 0 ? state.settings[index] : {}), ...row, version: ((index >= 0 ? state.settings[index].version : 0) || 0) + 1 };
      if (index >= 0) state.settings[index] = next; else state.settings.push(next);
      return { ...next };
    },
    async appendEvent(row) { state.events.push({ ...row, id: `event-${state.events.length + 1}` }); return state.events.at(-1); },
    async listEvents(appId, { resource = null, resourceId = null, limit = 50, cursor = null } = {}) {
      const rows = state.events.filter((row) => row.appId === appId
        && (!resource || row.resource === resource) && (!resourceId || row.resourceId === resourceId))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      const page = rows.slice(start, start + limit);
      return { events: page.map((row) => ({ ...row })), nextCursor: start + limit < rows.length ? page.at(-1)?.id || null : null };
    },
    async getAuditConfig(appId) { return state.config[appId] || null; },
  };
}

/**
 * @param {object} options
 * @param {object} options.storage the storage seam
 * @param {object} options.policy the application's account policy
 * @param {object} [options.settingsSchema] { definitions: { key: { scope, sensitive } } } as compiled by the settings module
 * @param {string[]} [options.sensitiveFields]
 */
export function createPlatformStateService({ storage, policy, settingsSchema = null, sensitiveFields = [], now = () => new Date().toISOString() } = {}) {
  if (!storage) throw new Error("createPlatformStateService: storage is required");

  const require = (actor, action, appId) => {
    if (actor && appId && actor.appId !== appId) throw new PlatformStateError("unauthenticated", "Sign in to this application first.", 401, { action });
    const decision = evaluate(policy, actor, action);
    if (!decision.allowed) {
      throw new PlatformStateError(decision.reason || "forbidden", `Not allowed: ${action} (${decision.reason})`, decision.reason === "unauthenticated" ? 401 : 403, { action });
    }
    return decision;
  };
  const definitionFor = (key) => {
    const definition = settingsSchema?.definitions?.[key];
    if (!definition) throw new PlatformStateError("setting_unknown", `no setting "${key}" is declared for this application`, 400, { keys: Object.keys(settingsSchema?.definitions || {}) });
    return definition;
  };

  async function record(appId, actor, event) {
    const config = await storage.getAuditConfig(appId);
    if (!config?.enabled) return null;
    const redacted = redactEvent({ ...event, before: event.before || null, after: event.after || null },
      { sensitiveFields: [...sensitiveFields, ...(config.sensitiveFields || [])] });
    return storage.appendEvent({
      appId, actorUserId: actor?.userId || null, actorEmail: actor?.email || null,
      action: redacted.action, resource: redacted.resource || null, resourceId: redacted.resourceId || null,
      before: redacted.before, after: redacted.after, createdAt: now(),
    });
  }

  return {
    version: PLATFORM_STATE_SERVICE_VERSION,

    /** Every stored value of one scope. Defaults are the module's job, not the store's. */
    async settings(appId, actor, { scope = "app", target = null } = {}) {
      if (!SCOPES.has(scope)) throw new PlatformStateError("setting_scope_invalid", `scope must be one of ${[...SCOPES].join(", ")}`, 400);
      require(actor, "settings.read", appId);
      // A member's own preferences are keyed by that member; nobody can read another's by asking.
      const scopeTarget = scope === "user" ? actor.userId : target || null;
      if (scope === "workspace" && !scopeTarget) throw new PlatformStateError("setting_scope_target_required", "a workspace scope needs its record id", 400);
      return storage.getSettings(appId, scope, scopeTarget);
    },

    async setSetting(appId, actor, { key, value, target = null } = {}) {
      const definition = definitionFor(key);
      // Writing one's own preference is not administration; writing an application-wide or
      // workspace value is, and the policy decides it.
      require(actor, definition.scope === "user" ? "settings.read" : "settings.write", appId);
      const scopeTarget = definition.scope === "user" ? actor.userId : definition.scope === "workspace" ? target : null;
      if (definition.scope === "workspace" && !scopeTarget) throw new PlatformStateError("setting_scope_target_required", `${key} is scoped to a workspace and needs its id`, 400);
      const before = await storage.getSettings(appId, definition.scope, scopeTarget);
      const saved = await storage.setSetting({
        appId, scope: definition.scope, scopeTarget: scopeTarget || null, key, value,
        updatedBy: actor.userId, updatedAt: now(),
      });
      await record(appId, actor, {
        action: "settings.set", resource: "setting", resourceId: key,
        before: definition.sensitive ? null : { [key]: before[key] ?? null },
        after: definition.sensitive ? null : { [key]: value },
      });
      return { key, value: saved.value, scope: definition.scope, version: saved.version };
    },

    /** Authorised history, newest first. There is deliberately no public append. */
    async history(appId, actor, query = {}) {
      require(actor, "history.read", appId);
      const page = await storage.listEvents(appId, query);
      // Redaction on READ uses the same field list a write would have used, including the
      // application's declared sensitive keys, so a row stored before a field was declared
      // sensitive is still redacted rather than served as it was written.
      const config = await storage.getAuditConfig(appId);
      const fields = [...sensitiveFields, ...(config?.sensitiveFields || [])];
      return {
        events: (page.events || []).map((event) => redactEvent(event, { sensitiveFields: fields })),
        nextCursor: page.nextCursor || null,
      };
    },

    /** Platform-internal append, used by the account and settings commands themselves. */
    record,
  };
}
