// The files, notifications and realtime installation plan (WP10).
//
// All three of these are things a contract ASKS FOR rather than things a compiler should guess.
// An application that never mentioned uploads should not get an upload surface; one that never
// mentioned live updates should not open a socket. So every claim here is keyed on a declared
// field type, a declared requirement signal, or the contract's own vocabulary — and where the
// contract is silent the plan is empty, not defaulted.
//
// The file POLICY is the part worth deriving carefully. A field declared as an image is an image
// field; the maximum size and the per-subject count come from what the field says it holds, and
// where the contract says nothing the platform's own conservative defaults apply and are recorded
// as defaults, so a reader can tell a declared limit from a fallback one.

export const DELIVERY_PLAN_VERSION = 1;

const FILE_FIELD_TYPE = /^(?:file|image|photo|picture|avatar|attachment|document|upload|media|video|audio)s?$/i;
const FILE_FIELD_NAME = /(?:^|[-_ ])(?:file|image|photo|picture|avatar|attachment|document|upload|logo|thumbnail|banner)s?(?:[-_ ]|$)/i;
const IMAGE_HINT = /(?:image|photo|picture|avatar|logo|thumbnail|banner)/i;
const DOCUMENT_HINT = /(?:document|attachment|pdf|report|invoice|contract|file)/i;
const VIDEO_HINT = /(?:video|clip|footage)/i;
const AUDIO_HINT = /(?:audio|sound|recording|podcast)/i;
// Live updates are a claim about other people's changes arriving without a reload. A contract
// makes that claim in its own words; nothing else implies it, because a socket nobody asked for is
// a cost nobody agreed to.
const REALTIME_VOCABULARY = /\b(?:real[-\s]?time|live(?:ly)?[-\s]?updates?|in real time|as (?:they|it) happens?|without (?:a )?refresh|automatically updates?|see (?:each )?other(?:'s)? changes|collaborat\w*)\b/i;
const NOTIFY_VOCABULARY = /\b(?:notif\w*|alert\w*|remind\w*|inbox|is (?:emailed|notified)|let(?:s)? (?:them|him|her|us) know)\b/i;

const MB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ image: 5 * MB, document: 10 * MB, video: 100 * MB, audio: 25 * MB });

const lower = (value) => String(value || "").trim().toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value : []);
const textOf = (contract) => [
  contract?.summary,
  ...listOf(contract?.journeys).map((journey) => [journey?.id, journey?.title, journey?.description,
    ...listOf(journey?.steps).map((step) => `${step?.id} ${step?.title || ""} ${step?.expect || ""}`)].join(" ")),
  ...listOf(contract?.operations).map((operation) => `${operation?.id} ${operation?.description || ""}`),
].filter(Boolean).join(" ");

/** Is this declared field a file reference rather than ordinary data? */
export function isFileField(field) {
  const name = String(field?.name || field);
  const type = String(field?.type || "");
  return FILE_FIELD_TYPE.test(type) || (FILE_FIELD_NAME.test(name) && !/id$/i.test(name));
}

function kindOfField(field) {
  const text = `${field?.name || field} ${field?.type || ""}`;
  if (VIDEO_HINT.test(text)) return "video";
  if (AUDIO_HINT.test(text)) return "audio";
  if (DOCUMENT_HINT.test(text)) return "document";
  if (IMAGE_HINT.test(text)) return "image";
  return "document";
}

/**
 * The file policy a contract declares. Fields that hold files name their subject entity, so the
 * metadata is scoped to the record it belongs to and removing that record removes its files.
 */
export function deriveFilePlan(contract, { entitySchema = null } = {}) {
  const durable = new Set(listOf(entitySchema?.entities).map(lower));
  const subjects = [];
  const kinds = new Set();
  for (const entity of listOf(contract?.entities)) {
    if (entity?.platform) continue;
    const fileFields = listOf(entity.fields).filter(isFileField);
    if (!fileFields.length) continue;
    for (const field of fileFields) kinds.add(kindOfField(field));
    subjects.push({
      subject: String(entity.name),
      durable: durable.has(lower(entity.name)),
      fields: fileFields.map((field) => ({ name: String(field?.name || field), kind: kindOfField(field) })),
    });
  }
  const signalled = listOf(contract?.buildProfile?.requirementSignals).includes("file_uploads");
  if (!subjects.length && !signalled) return { subjects: [], policy: null };
  const declaredKinds = kinds.size ? [...kinds] : ["image", "document"];
  const maxBytes = Math.max(...declaredKinds.map((kind) => DEFAULT_LIMITS[kind] || DEFAULT_LIMITS.document));
  return {
    subjects,
    policy: {
      kinds: declaredKinds,
      maxBytes,
      maxPerSubject: 10,
      signedUrlSeconds: 900,
      // Recorded so a reader can tell a limit the contract asked for from one the platform chose.
      defaults: ["maxBytes", "maxPerSubject", "signedUrlSeconds"],
    },
    ...(signalled && !subjects.length ? { source: "signal:file_uploads" } : {}),
  };
}

/**
 * The notification events a contract declares. An event exists because a journey says someone is
 * told something; a message nobody described is not composed, because an inbox full of messages
 * the application never meant to send is worse than an empty one.
 */
export function deriveNotificationPlan(contract) {
  const events = [];
  const seen = new Set();
  for (const journey of listOf(contract?.journeys)) {
    for (const step of listOf(journey?.steps)) {
      const text = `${step?.id || ""} ${step?.title || ""} ${step?.expect || ""}`;
      if (!NOTIFY_VOCABULARY.test(text)) continue;
      const id = `${journey.id}.${step.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({
        id,
        title: String(step?.title || step?.expect || `${journey.title}`).slice(0, 120),
        body: "",
        // A message about the actor's own action is theirs to receive. Anything describing what
        // the SYSTEM did — a security alert, an administrative change — is server-triggered, so a
        // visitor cannot forge it.
        recipient: /\b(?:security|password|administrator|admin|system|automatic\w*)\b/i.test(text) ? "server" : "self",
        channel: /\bemail\w*\b/i.test(text) ? "email" : "inbox",
        source: `${journey.id}:${step.id}`,
      });
    }
  }
  const signalled = listOf(contract?.buildProfile?.requirementSignals).includes("notifications");
  return { events, ...(signalled && !events.length ? { source: "signal:notifications" } : {}) };
}

/**
 * The realtime topics a contract declares. Only durable entities can be watched — a topic over
 * something with no rows has nothing to resync from — and only where the contract actually claims
 * live behaviour.
 */
export function deriveRealtimePlan(contract, { entitySchema = null } = {}) {
  const text = textOf(contract);
  const signalled = listOf(contract?.buildProfile?.requirementSignals).includes("realtime");
  if (!signalled && !REALTIME_VOCABULARY.test(text)) return { topics: [] };
  const durable = listOf(entitySchema?.entities);
  const named = durable.filter((entity) => new RegExp(`\\b${entity}s?\\b`, "i").test(text));
  const watched = named.length ? named : durable;
  return {
    topics: watched.map((entity) => ({ id: entity, entity, resync: true })),
    source: signalled ? "signal:realtime" : "contract_vocabulary",
  };
}

/** All three, derived once. */
export function deriveDeliveryPlan(contract, { entitySchema = null } = {}) {
  const files = deriveFilePlan(contract, { entitySchema });
  const notifications = deriveNotificationPlan(contract);
  const realtime = deriveRealtimePlan(contract, { entitySchema });
  return {
    version: DELIVERY_PLAN_VERSION,
    files,
    notifications,
    realtime,
    verification: deliveryVerificationPlan({ files, notifications, realtime }),
  };
}

/** Deterministic probes: a refusal before upload, one delivery per event, a closed reconnect gap. */
export function deliveryVerificationPlan({ files = {}, notifications = {}, realtime = {} } = {}) {
  const probes = [];
  if (files?.policy) {
    probes.push({ id: "files.refuse", expect: "a file outside the declared type or size is refused before it is sent" });
    probes.push({ id: "files.cleanup", expect: "removing the record removes its files" });
  }
  if ((notifications?.events || []).length) {
    probes.push({ id: "notifications.once", expect: "the same event about the same subject appears once" });
    probes.push({ id: "notifications.read", expect: "a read receipt survives a reload" });
  }
  if ((realtime?.topics || []).length) {
    probes.push({ id: "realtime.resync", expect: "a change made while disconnected is present after reconnect" });
  }
  return probes;
}
