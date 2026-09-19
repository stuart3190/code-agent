// Realtime module v1 — platform infrastructure, do not edit or reimplement.
//
// Live updates are the one feature that looks finished in a demo and is wrong in production, and
// the audit names why (§7.1 "Realtime"): generated subscription wiring handles the happy path and
// nothing else.
//
//   - RECONNECT. A dropped socket is normal — a laptop lid, a tunnel, a deploy. Generated code
//     resubscribed and carried on, so every change that happened while it was away was lost and
//     the screen showed a stale list that looked authoritative. A reconnect here RESYNCS: the
//     subscription re-reads its own data, so the gap is closed rather than ignored.
//   - AUTHORISATION. A subscription is a read. Generated wiring subscribed to a table and let
//     row-level security decide silently, so an unauthorised subscriber saw an empty stream
//     indistinguishable from a quiet one. Here a topic is declared, and a subscription to an
//     undeclared topic is refused outright.
//   - LIFECYCLE. Two screens subscribing to one topic opened two channels, and a screen that
//     unmounted mid-flight leaked its handler. One channel per topic, reference counted, closed
//     when the last subscriber leaves.
//
// Headless: state and functions only. No socket is opened until something subscribes.

export const REALTIME_MODULE_VERSION = "1.0.0";

export const REALTIME_STATUS = Object.freeze({
  IDLE: "idle", CONNECTING: "connecting", LIVE: "live", RESYNCING: "resyncing",
  RECONNECTING: "reconnecting", CLOSED: "closed", ERROR: "error",
});

export const REALTIME_ERROR = Object.freeze({
  UNKNOWN_TOPIC: "realtime_topic_unknown",
  NOT_AUTHORIZED: "realtime_not_authorized",
  UNAVAILABLE: "realtime_unavailable",
});

export class RealtimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Compile the declared topics.
 *   topics: [{ id, entity, action?, resync? }]
 * A topic names the durable entity it watches, so the module knows what to re-read after a gap.
 * Without that, "resync" has no meaning and reconnect can only mean "hope".
 */
export function compileTopics(topics = []) {
  const definitions = {};
  for (const row of listOf(topics)) {
    const id = String(row?.id || row?.entity || "").trim();
    if (!id) continue;
    definitions[id] = freeze({
      id,
      entity: String(row?.entity || id),
      events: freeze(listOf(row?.events).length ? listOf(row.events).map(String) : ["INSERT", "UPDATE", "DELETE"]),
      // Whether a reconnect re-reads. A topic over a small working set should; one over an
      // unbounded feed says so, and its consumers know the gap is theirs to handle.
      resync: row?.resync !== false,
    });
  }
  return freeze({ version: REALTIME_MODULE_VERSION, definitions: freeze(definitions), ids: freeze(Object.keys(definitions)) });
}

/**
 * @param {object} options
 * @param {object} options.schema compileTopics() output
 * @param {(topic, handler) => () => void} options.connect opens one channel; returns unsubscribe.
 *   It may call handler({ type: "event", event }) and handler({ type: "status", status }).
 * @param {(topic) => Promise<any[]>} [options.resync] re-reads a topic's current rows after a gap
 * @param {(topic) => Promise<boolean>} [options.authorize] decides whether this actor may watch
 */
export function createRealtime({ schema, connect, resync = null, authorize = null } = {}) {
  if (!schema?.definitions) throw new RealtimeError(REALTIME_ERROR.UNAVAILABLE, "createRealtime needs compiled topics");
  if (typeof connect !== "function") throw new RealtimeError(REALTIME_ERROR.UNAVAILABLE, "createRealtime needs a connect adapter");
  const channels = new Map();
  const listeners = new Set();
  let state = { status: REALTIME_STATUS.IDLE, topics: {}, error: null, reconnects: 0, resyncs: 0 };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, topics: freeze({ ...state.topics }) });
    return snapshot;
  };
  const setTopic = (id, status) => commit({
    topics: { ...state.topics, [id]: status },
    status: Object.values({ ...state.topics, [id]: status }).some((row) => row === REALTIME_STATUS.LIVE)
      ? REALTIME_STATUS.LIVE : status,
  });

  const definitionFor = (topicId) => {
    const definition = schema.definitions[topicId];
    if (!definition) {
      throw new RealtimeError(REALTIME_ERROR.UNKNOWN_TOPIC,
        `no realtime topic "${topicId}" is declared for this application`, { topics: [...schema.ids] });
    }
    return definition;
  };

  async function open(definition) {
    // A subscription is a read: it is authorised before a socket is opened, and a refusal is an
    // explicit state rather than a stream that is silently empty.
    if (authorize && (await authorize(definition)) === false) {
      throw new RealtimeError(REALTIME_ERROR.NOT_AUTHORIZED, `not allowed to watch "${definition.id}"`);
    }
    const channel = {
      definition, subscribers: new Set(), close: null,
      status: REALTIME_STATUS.CONNECTING, everLive: false,
    };
    const deliver = (event) => { for (const subscriber of [...channel.subscribers]) subscriber(event); };
    const onMessage = async (message) => {
      if (message?.type === "status") {
        const status = String(message.status);
        if (status === "live" || status === "SUBSCRIBED") {
          const reconnected = channel.everLive;
          channel.everLive = true;
          channel.status = REALTIME_STATUS.LIVE;
          setTopic(definition.id, REALTIME_STATUS.LIVE);
          // The whole point: a gap is closed by re-reading, not by pretending it did not happen.
          if (reconnected && definition.resync && typeof resync === "function") {
            setTopic(definition.id, REALTIME_STATUS.RESYNCING);
            commit({ resyncs: state.resyncs + 1 });
            try {
              const rows = await resync(definition);
              deliver({ type: "resync", topic: definition.id, records: listOf(rows) });
            } catch (error) {
              commit({ error: { code: REALTIME_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
            }
            channel.status = REALTIME_STATUS.LIVE;
            setTopic(definition.id, REALTIME_STATUS.LIVE);
          }
          return;
        }
        if (status === "closed" || status === "CLOSED" || status === "reconnecting" || status === "CHANNEL_ERROR") {
          channel.status = REALTIME_STATUS.RECONNECTING;
          commit({ reconnects: state.reconnects + 1 });
          setTopic(definition.id, REALTIME_STATUS.RECONNECTING);
          deliver({ type: "status", topic: definition.id, status: REALTIME_STATUS.RECONNECTING });
          return;
        }
        return;
      }
      if (!definition.events.includes(String(message?.event?.eventType || message?.event?.type || "").toUpperCase())
        && definition.events.length !== 3) return;
      deliver({ type: "event", topic: definition.id, event: message?.event ?? message });
    };
    channel.close = connect(definition, onMessage);
    setTopic(definition.id, REALTIME_STATUS.CONNECTING);
    return channel;
  }

  return {
    schema,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    /**
     * Watch one declared topic. One channel per topic however many screens ask: the second
     * subscriber joins the first rather than opening a second socket, and the channel closes when
     * the last one leaves.
     */
    async watch(topicId, handler) {
      const definition = definitionFor(topicId);
      if (typeof handler !== "function") throw new RealtimeError(REALTIME_ERROR.UNAVAILABLE, "watch needs a handler");
      let channel = channels.get(definition.id);
      if (!channel) {
        try {
          channel = await open(definition);
          channels.set(definition.id, channel);
        } catch (error) {
          setTopic(definition.id, REALTIME_STATUS.ERROR);
          commit({ error: { code: error?.code || REALTIME_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
          throw error;
        }
      }
      channel.subscribers.add(handler);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        channel.subscribers.delete(handler);
        if (channel.subscribers.size === 0) {
          channel.close?.();
          channels.delete(definition.id);
          setTopic(definition.id, REALTIME_STATUS.CLOSED);
        }
      };
    },

    /** How many channels are actually open. One per watched topic, never one per subscriber. */
    openChannels: () => channels.size,
    subscriberCount: (topicId) => channels.get(topicId)?.subscribers.size || 0,

    /** Close everything. A page leaving should not hold a socket open. */
    closeAll() {
      for (const [id, channel] of channels) {
        channel.close?.();
        channels.delete(id);
      }
      return commit({ status: REALTIME_STATUS.CLOSED, topics: {} });
    },
  };
}
