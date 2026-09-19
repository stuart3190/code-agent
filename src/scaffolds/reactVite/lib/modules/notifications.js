// Notifications module v1 — platform infrastructure, do not edit or reimplement.
//
// The SDK already has an inbox table and a self-notify insert. What generated applications wrote
// around it went wrong in three ways the audit names (§7.1 "Notifications"):
//
//   1. DUPLICATES. A send inside a retried effect, a double-clicked button, or a job that ran
//      twice put the same message in the inbox two or three times. The fix is not "try harder not
//      to retry" — retries are correct — it is that a send carries a DEDUPLICATION KEY, so the
//      same event delivered twice is one notification.
//   2. Read state as a component flag. Marking read updated local state and never the row, so the
//      badge cleared until reload. Read state here is the stored row, and the unread count is
//      derived from the same list the inbox renders, so a badge and a list can never disagree.
//   3. An application sending on someone else's behalf. A notification a visitor can forge is
//      worth nothing: the recipient policy says which streams this application may write, and
//      anything beyond the signed-in member's own stream is a SERVER-triggered delivery.
//
// Headless: state and functions only.

export const NOTIFICATIONS_MODULE_VERSION = "1.0.0";

export const NOTIFICATION_ERROR = Object.freeze({
  UNKNOWN_EVENT: "notification_event_unknown",
  RECIPIENT_NOT_ALLOWED: "notification_recipient_not_allowed",
  UNAVAILABLE: "notifications_unavailable",
});

/** Who an application may write a notification to from the client. */
export const RECIPIENT = Object.freeze({ SELF: "self", SERVER: "server" });

export class NotificationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Compile the declared notification events.
 *   events: [{ id, title, body?, recipient?: "self"|"server", channel?: "inbox"|"email" }]
 * `title` and `body` are templates over the payload: "Your booking {reference} is confirmed".
 * An event the contract never declared cannot be sent, so a message nobody wrote cannot appear.
 */
export function compileNotifications(events = []) {
  const definitions = {};
  for (const row of listOf(events)) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    definitions[id] = freeze({
      id,
      title: String(row?.title || id),
      body: String(row?.body || ""),
      recipient: row?.recipient === RECIPIENT.SERVER ? RECIPIENT.SERVER : RECIPIENT.SELF,
      channel: row?.channel === "email" ? "email" : "inbox",
    });
  }
  return freeze({ version: NOTIFICATIONS_MODULE_VERSION, definitions: freeze(definitions), ids: freeze(Object.keys(definitions)) });
}

/** Fill a declared template from a payload. An absent value leaves its placeholder out entirely. */
export function renderTemplate(template, payload = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) => {
    const value = payload?.[key];
    return value === undefined || value === null ? "" : String(value);
  }).replace(/\s{2,}/g, " ").trim();
}

/**
 * The deduplication key for one delivery. Two sends of the same event about the same subject are
 * the same notification; a caller may override it where the application knows better.
 */
export function deliveryKey(eventId, payload = {}, explicit = null) {
  if (explicit) return String(explicit);
  const subject = payload?.id ?? payload?.reference ?? payload?.subjectId ?? null;
  return subject ? `${eventId}:${subject}` : eventId;
}

/**
 * @param {object} options
 * @param {object} options.schema compileNotifications() output
 * @param {object} options.transport the SDK notifications surface
 *   { list, unreadCount, markRead, markAllRead, notifySelf, emailSelf, emit }
 */
export function createNotifications({ schema, transport, now = () => new Date().toISOString() } = {}) {
  if (!schema?.definitions) throw new NotificationError(NOTIFICATION_ERROR.UNAVAILABLE, "createNotifications needs a compiled schema");
  if (typeof transport?.list !== "function") throw new NotificationError(NOTIFICATION_ERROR.UNAVAILABLE, "createNotifications needs the notifications transport");
  const listeners = new Set();
  let state = { status: "idle", notifications: [], unread: 0, error: null };
  let snapshot = null;
  let generation = 0;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => {
    const next = { ...state, ...patch };
    // The badge is DERIVED from the same rows the inbox renders, so the two cannot disagree.
    next.unread = next.notifications.filter((row) => !row.read_at && !row.readAt).length;
    state = next;
    snapshot = null;
    emit();
    return getState();
  };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, notifications: freeze(state.notifications.map((row) => freeze({ ...row }))) });
    return snapshot;
  };
  const definitionFor = (eventId) => {
    const definition = schema.definitions[eventId];
    if (!definition) {
      throw new NotificationError(NOTIFICATION_ERROR.UNKNOWN_EVENT,
        `no notification event "${eventId}" is declared for this application`, { events: [...schema.ids] });
    }
    return definition;
  };
  const isRead = (row) => Boolean(row?.read_at || row?.readAt);
  const keyOf = (row) => row?.data?.deliveryKey || row?.data?.delivery_key || null;

  return {
    schema,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    /** The inbox, newest first. A superseded load never overwrites a newer one. */
    async load({ unreadOnly = false, limit = 50 } = {}) {
      const mine = ++generation;
      commit({ status: "loading", error: null });
      try {
        const rows = await transport.list({ unreadOnly, limit });
        if (generation !== mine) return getState();
        return commit({ status: listOf(rows).length ? "ready" : "empty", notifications: listOf(rows), error: null });
      } catch (error) {
        if (generation !== mine) return getState();
        return commit({ status: "error", error: { code: NOTIFICATION_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
      }
    },

    /**
     * Send a declared event. The same event about the same subject sent twice is ONE notification:
     * a retried effect, a double click and a job that ran twice all converge here.
     */
    async send(eventId, payload = {}, { deduplicationKey = null } = {}) {
      const definition = definitionFor(eventId);
      if (definition.recipient === RECIPIENT.SERVER) {
        // A stream the visitor must not be able to forge — "your password was changed" — is
        // emitted as an event the server acts on, never written from the client.
        await transport.emit?.(eventId, payload);
        return { ok: true, delivered: "server", event: eventId };
      }
      const key = deliveryKey(eventId, payload, deduplicationKey);
      const existing = state.notifications.find((row) => keyOf(row) === key)
        || listOf(await transport.list({ limit: 50 })).find((row) => keyOf(row) === key);
      if (existing) return { ok: true, deduplicated: true, notification: existing, event: eventId };
      const message = {
        title: renderTemplate(definition.title, payload),
        body: renderTemplate(definition.body, payload),
        data: { ...payload, event: eventId, deliveryKey: key },
      };
      try {
        const saved = definition.channel === "email" && typeof transport.emailSelf === "function"
          ? await transport.emailSelf({ subject: message.title, text: message.body })
          : await transport.notifySelf(message);
        const row = saved && typeof saved === "object" ? saved : { ...message, created_at: now() };
        commit({ notifications: [row, ...state.notifications], status: "ready", error: null });
        return { ok: true, notification: row, event: eventId };
      } catch (error) {
        commit({ error: { code: NOTIFICATION_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: NOTIFICATION_ERROR.UNAVAILABLE, event: eventId, state: getState() };
      }
    },

    /** Mark one read. The stored row is what changes; the badge follows from the rows. */
    async markRead(id) {
      const before = state.notifications;
      // Optimistic, because a read receipt that waits for a round trip feels broken — and rolled
      // back on failure, because a badge that lies is worse than one that is slow.
      commit({ notifications: before.map((row) => (row.id === id ? { ...row, read_at: now() } : row)) });
      try {
        await transport.markRead(id);
        return { ok: true, state: getState() };
      } catch (error) {
        commit({ notifications: before, error: { code: NOTIFICATION_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: NOTIFICATION_ERROR.UNAVAILABLE, state: getState() };
      }
    },

    async markAllRead() {
      const before = state.notifications;
      const at = now();
      commit({ notifications: before.map((row) => (isRead(row) ? row : { ...row, read_at: at })) });
      try {
        await transport.markAllRead();
        return { ok: true, state: getState() };
      } catch (error) {
        commit({ notifications: before, error: { code: NOTIFICATION_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: NOTIFICATION_ERROR.UNAVAILABLE, state: getState() };
      }
    },

    /** The unread count, from the loaded rows. Falls back to the server's own count when empty. */
    async unreadCount() {
      if (state.notifications.length) return state.unread;
      try { return await transport.unreadCount?.() ?? 0; } catch { return 0; }
    },
  };
}
