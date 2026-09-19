// WP10 — files, notifications and realtime.
//
// All three wrap SDK surfaces that already work. What each adds is the part the generated code
// around those surfaces kept getting wrong (audit §7.1):
//
//   - files had no declared policy, so an application that wanted avatars accepted a 400MB video
//     and reported the failure as "something went wrong" halfway through the upload;
//   - notifications arrived two and three times because a retried effect sent again, and read
//     state lived in a component so the badge cleared until reload;
//   - realtime handled the happy path: a reconnect silently lost every change made while the
//     socket was down, and an unauthorised subscription looked exactly like a quiet one.
//
// The audit's required proof is ownership, reconnect, expiry, delivery/read-state and cleanup.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FILE_ERROR, FILE_STATUS, FileError, checkFile, compileFilePolicy, createFiles, fileKey, formatBytes,
} from "../../src/scaffolds/reactVite/lib/modules/files.js";
import {
  NOTIFICATION_ERROR, NotificationError, compileNotifications, createNotifications, deliveryKey, renderTemplate,
} from "../../src/scaffolds/reactVite/lib/modules/notifications.js";
import {
  REALTIME_ERROR, REALTIME_STATUS, RealtimeError, compileTopics, createRealtime,
} from "../../src/scaffolds/reactVite/lib/modules/realtime.js";
import {
  deriveDeliveryPlan, deriveFilePlan, deriveNotificationPlan, deriveRealtimePlan, isFileField,
} from "../../shell/server/lib/builderV2/platformModules/deliveryPlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_FILES_PATH, APP_FACADE_NOTIFICATIONS_PATH, APP_FACADE_REALTIME_PATH,
  FILES_COMPOSED_PATH, NOTIFICATIONS_COMPOSED_PATH, REALTIME_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { availabilityFromEnv, baselineDeploymentAvailability } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const IMAGES = compileFilePolicy({ kinds: ["image"], maxBytes: 1024 * 1024, maxPerSubject: 2 });

function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    async upload(file, { path }) { objects.set(path, file); return { path }; },
    async getUrl(path, seconds) { return `https://signed.test/${path}?exp=${seconds}`; },
    async remove(path) { objects.delete(path); },
  };
}

function fakeMetadata() {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    async create(values) { const id = `f${++seq}`; rows.set(id, { id, values }); return { id, values }; },
    async list({ filters = {} } = {}) {
      return [...rows.values()].filter((row) => row.values.subject === filters.subject
        && (row.values.subjectId ?? null) === (filters.subjectId ?? null));
    },
    async remove(id) { rows.delete(id); },
  };
}

test("WP10 — the file policy is declared, and a file outside it is refused BEFORE a byte is sent", async () => {
  assert.ok(IMAGES.types.includes("image/png"));
  assert.equal(IMAGES.types.includes("application/x-msdownload"), false, "an application that wanted images never accepts an executable");
  assert.equal(checkFile(IMAGES, { size: 2 * 1024 * 1024, type: "image/png" }).code, FILE_ERROR.TOO_LARGE);
  assert.equal(checkFile(IMAGES, { size: 10, type: "application/pdf" }).code, FILE_ERROR.TYPE_NOT_ALLOWED);
  assert.equal(checkFile(IMAGES, { size: 0, type: "image/png" }).code, FILE_ERROR.EMPTY);
  assert.equal(checkFile(IMAGES, { size: 10, type: "image/png" }, { held: 2 }).code, FILE_ERROR.TOO_MANY);
  assert.equal(checkFile(IMAGES, { size: 10, type: "image/png" }).ok, true);
  // The refusal carries what a screen needs to say: the limit, and what is accepted.
  assert.equal(checkFile(IMAGES, { size: 5e6, type: "image/png" }).message.includes("1MB"), true);
  assert.deepEqual(checkFile(IMAGES, { size: 10, type: "text/plain" }).details.accepted, [...IMAGES.types]);
  assert.equal(formatBytes(1024 * 1024), "1MB");

  // A policy that names neither kinds nor types accepts nothing: silence is not permission.
  assert.deepEqual(compileFilePolicy({}).types, []);

  const storage = fakeStorage();
  const files = createFiles({ policy: IMAGES, storage, metadata: fakeMetadata(), now: () => 1000 });
  const refused = await files.upload({ size: 5e6, type: "image/png", name: "big.png" }, { subject: "task", subjectId: "t1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, FILE_ERROR.TOO_LARGE);
  assert.equal(files.getState().status, FILE_STATUS.REFUSED);
  assert.equal(storage.objects.size, 0, "nothing was sent: the visitor is told before the wait, not after it");
});

test("WP10 — an accepted file is stored with its metadata, and both go when the subject does", async () => {
  const storage = fakeStorage();
  const metadata = fakeMetadata();
  const files = createFiles({ policy: IMAGES, storage, metadata, now: () => 1000 });

  const first = await files.upload({ size: 10, type: "image/png", name: "Cover Photo!.PNG" }, { subject: "task", subjectId: "t1" });
  assert.equal(first.ok, true);
  assert.equal(first.file.path, "task/t1/1000-cover-photo.png", "the key is subject-scoped and sanitised");
  assert.equal(storage.objects.size, 1);
  assert.equal(metadata.rows.size, 1, "metadata is recorded by the module, not invented in a screen");
  assert.equal(files.getState().status, FILE_STATUS.READY);

  await files.upload({ size: 10, type: "image/png", name: "b.png" }, { subject: "task", subjectId: "t1" });
  const third = await files.upload({ size: 10, type: "image/png", name: "c.png" }, { subject: "task", subjectId: "t1" });
  assert.equal(third.reason, FILE_ERROR.TOO_MANY, "the per-subject quota counts what is actually stored");

  // Another subject has its own quota and its own prefix.
  assert.equal((await files.upload({ size: 10, type: "image/png", name: "d.png" }, { subject: "task", subjectId: "t2" })).ok, true);

  // Access is a signed link with a stated expiry, so a caller cannot keep a dead one on screen.
  const link = await files.url(first.file.path, { expiresIn: 60 });
  assert.equal(link.url, "https://signed.test/task/t1/1000-cover-photo.png?exp=60");
  assert.equal(link.expiresIn, 60);
  assert.ok(link.expiresAt);
  assert.equal((await files.url(first.file.path)).expiresIn, IMAGES.signedUrlSeconds, "the policy's expiry by default");

  // Removing one file removes its metadata too: no orphan on either side.
  await files.list({ subject: "task", subjectId: "t1" });
  await files.remove(first.file.path);
  assert.equal(storage.objects.has(first.file.path), false);
  assert.equal(metadata.rows.size, 2, "one of the three rows is gone");

  // Removing the subject removes everything attached to it — the only honest moment to sweep.
  await files.removeForSubject({ subject: "task", subjectId: "t1" });
  assert.deepEqual([...metadata.rows.values()].map((row) => row.values.subjectId), ["t2"]);
  assert.equal(storage.objects.size, 1);
});

test("WP10 — negative controls: a broken storage surface is an error state, and a missing policy is a wiring error", async () => {
  assert.throws(() => createFiles({ policy: null, storage: fakeStorage() }), (error) => error instanceof FileError);
  assert.throws(() => createFiles({ policy: IMAGES, storage: {} }), (error) => error.code === FILE_ERROR.UNAVAILABLE);

  const files = createFiles({
    policy: IMAGES, metadata: fakeMetadata(),
    storage: { upload: async () => { throw new Error("bucket offline"); }, getUrl: async () => "", remove: async () => {} },
  });
  const failed = await files.upload({ size: 10, type: "image/png", name: "a.png" }, { subject: "task", subjectId: "t1" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, FILE_ERROR.UPLOAD_FAILED);
  assert.equal(files.getState().status, FILE_STATUS.ERROR);
  assert.equal(files.getState().error.message.includes("bucket offline"), true, "the cause is reported, not swallowed");
  assert.equal(fileKey({ name: "", type: "image/png", now: 1 }), "shared/unscoped/1-file.png");
});

function fakeInbox() {
  const rows = [];
  const emitted = [];
  return {
    rows, emitted,
    async list({ unreadOnly = false, limit = 50 } = {}) {
      return rows.filter((row) => !unreadOnly || !row.read_at).slice(0, limit).map((row) => ({ ...row }));
    },
    async unreadCount() { return rows.filter((row) => !row.read_at).length; },
    async markRead(id) { const row = rows.find((candidate) => candidate.id === id); if (row) row.read_at = "read"; return row; },
    async markAllRead() { for (const row of rows) row.read_at = "read"; },
    async notifySelf(message) { const row = { id: `n${rows.length + 1}`, ...message, read_at: null, created_at: "t" }; rows.unshift(row); return row; },
    async emailSelf({ subject }) { const row = { id: `e${rows.length + 1}`, title: subject, read_at: null }; rows.unshift(row); return row; },
    async emit(event, payload) { emitted.push({ event, payload }); },
  };
}

const EVENTS = compileNotifications([
  { id: "booking.confirmed", title: "Booking {reference} confirmed", body: "See you on {date}." },
  { id: "password.changed", title: "Your password was changed", recipient: "server" },
]);

test("WP10 — the same event about the same subject is delivered ONCE, however many times it is sent", async () => {
  const transport = fakeInbox();
  const notifications = createNotifications({ schema: EVENTS, transport });

  const first = await notifications.send("booking.confirmed", { id: "b1", reference: "BK-1", date: "1 October" });
  assert.equal(first.ok, true);
  assert.equal(transport.rows[0].title, "Booking BK-1 confirmed");
  assert.equal(transport.rows[0].body, "See you on 1 October.");

  // A retried effect, a double click and a job that ran twice all arrive here.
  const again = await notifications.send("booking.confirmed", { id: "b1", reference: "BK-1", date: "1 October" });
  assert.equal(again.deduplicated, true);
  assert.equal(transport.rows.length, 1, "one notification, not three");

  // A different subject is a different notification.
  await notifications.send("booking.confirmed", { id: "b2", reference: "BK-2", date: "2 October" });
  assert.equal(transport.rows.length, 2);
  assert.equal(deliveryKey("booking.confirmed", { id: "b1" }), "booking.confirmed:b1");
  assert.equal(deliveryKey("booking.confirmed", {}, "custom"), "custom");

  // A placeholder with no value leaves nothing behind rather than printing "undefined".
  assert.equal(renderTemplate("Booking {reference} confirmed", {}), "Booking confirmed");
});

test("WP10 — an undeclared event cannot be sent, and a server-only recipient is never written from the client", async () => {
  const transport = fakeInbox();
  const notifications = createNotifications({ schema: EVENTS, transport });

  await assert.rejects(() => notifications.send("made.up", {}),
    (error) => error instanceof NotificationError && error.code === NOTIFICATION_ERROR.UNKNOWN_EVENT);
  assert.equal(transport.rows.length, 0, "a message nobody wrote cannot appear");

  // A stream the visitor must not be able to forge becomes an event the server acts on.
  const security = await notifications.send("password.changed", { id: "u1" });
  assert.equal(security.delivered, "server");
  assert.equal(transport.rows.length, 0, "nothing was inserted from the client");
  assert.deepEqual(transport.emitted.map((row) => row.event), ["password.changed"]);
});

test("WP10 — the unread badge is derived from the rows the inbox renders, and a read receipt rolls back on failure", async () => {
  const transport = fakeInbox();
  await transport.notifySelf({ title: "one", body: "", data: {} });
  await transport.notifySelf({ title: "two", body: "", data: {} });
  const notifications = createNotifications({ schema: EVENTS, transport });

  await notifications.load();
  assert.equal(notifications.getState().status, "ready");
  assert.equal(notifications.getState().unread, 2);

  const id = notifications.getState().notifications[0].id;
  assert.equal((await notifications.markRead(id)).ok, true);
  assert.equal(notifications.getState().unread, 1, "the badge follows the rows: the two cannot disagree");
  assert.equal(transport.rows.find((row) => row.id === id).read_at, "read", "and the stored row is what changed");

  await notifications.markAllRead();
  assert.equal(notifications.getState().unread, 0);

  // A failed receipt is rolled back: a badge that lies is worse than one that is slow.
  const failing = createNotifications({
    schema: EVENTS,
    transport: { ...transport, markRead: async () => { throw new Error("offline"); } },
  });
  await failing.load();
  const before = failing.getState().unread;
  const rolled = await failing.markRead(failing.getState().notifications[0].id);
  assert.equal(rolled.ok, false);
  assert.equal(failing.getState().unread, before);
  assert.equal(failing.getState().error.code, NOTIFICATION_ERROR.UNAVAILABLE);

  const empty = createNotifications({ schema: EVENTS, transport: { list: async () => [] } });
  await empty.load();
  assert.equal(empty.getState().status, "empty", "empty is distinguished from ready");
});

function fakeSocket() {
  const handlers = new Map();
  let closes = 0;
  return {
    handlers,
    closes: () => closes,
    connect(definition, handler) {
      handlers.set(definition.id, handler);
      queueMicrotask(() => handler({ type: "status", status: "live" }));
      return () => { handlers.delete(definition.id); closes += 1; };
    },
    drop(topic) { handlers.get(topic)?.({ type: "status", status: "closed" }); },
    restore(topic) { handlers.get(topic)?.({ type: "status", status: "live" }); },
    push(topic, event) { handlers.get(topic)?.({ type: "event", event }); },
  };
}

const TOPICS = compileTopics([{ id: "task", entity: "task" }, { id: "comment", entity: "comment", resync: false }]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("WP10 — a reconnect RESYNCS: the changes made while the socket was down are not lost", async () => {
  const socket = fakeSocket();
  let resyncs = 0;
  const realtime = createRealtime({
    schema: TOPICS, connect: socket.connect.bind(socket),
    resync: async () => { resyncs += 1; return [{ id: "t1" }, { id: "t2" }]; },
  });
  const seen = [];
  await realtime.watch("task", (event) => seen.push(event));
  await settle();
  assert.equal(realtime.getState().topics.task, REALTIME_STATUS.LIVE);

  socket.push("task", { eventType: "INSERT", record: { id: "t1" } });
  assert.equal(seen.filter((event) => event.type === "event").length, 1);

  // The laptop lid, the tunnel, the deploy.
  socket.drop("task");
  assert.equal(realtime.getState().topics.task, REALTIME_STATUS.RECONNECTING);
  assert.equal(realtime.getState().reconnects, 1);
  socket.restore("task");
  await settle();
  assert.equal(resyncs, 1, "the gap is closed by re-reading, not by hoping");
  assert.equal(realtime.getState().resyncs, 1);
  const resync = seen.find((event) => event.type === "resync");
  assert.deepEqual(resync.records.map((row) => row.id), ["t1", "t2"]);
  assert.equal(realtime.getState().topics.task, REALTIME_STATUS.LIVE);

  // A topic that declares itself unresyncable says so rather than silently not resyncing.
  await realtime.watch("comment", () => {});
  await settle();
  socket.drop("comment");
  socket.restore("comment");
  await settle();
  assert.equal(resyncs, 1, "resync: false is respected");
  realtime.closeAll();
});

test("WP10 — one channel per topic however many screens watch, closed when the last one leaves", async () => {
  const socket = fakeSocket();
  const realtime = createRealtime({ schema: TOPICS, connect: socket.connect.bind(socket) });
  const off1 = await realtime.watch("task", () => {});
  const off2 = await realtime.watch("task", () => {});
  assert.equal(realtime.openChannels(), 1, "the second subscriber joins the first");
  assert.equal(realtime.subscriberCount("task"), 2);

  off1();
  assert.equal(realtime.openChannels(), 1, "the channel stays for the remaining subscriber");
  off1();
  assert.equal(realtime.subscriberCount("task"), 1, "releasing twice is not two releases");
  off2();
  assert.equal(realtime.openChannels(), 0);
  assert.equal(socket.closes(), 1, "the socket is actually closed, not leaked");
  assert.equal(realtime.getState().topics.task, REALTIME_STATUS.CLOSED);
});

test("WP10 — an undeclared topic and an unauthorised subscription are refused, never silently empty", async () => {
  const socket = fakeSocket();
  const realtime = createRealtime({ schema: TOPICS, connect: socket.connect.bind(socket) });
  await assert.rejects(() => realtime.watch("ghost", () => {}),
    (error) => error instanceof RealtimeError && error.code === REALTIME_ERROR.UNKNOWN_TOPIC);
  assert.equal(realtime.openChannels(), 0, "no socket is opened for a topic nobody declared");

  // An unauthorised subscriber used to see an empty stream indistinguishable from a quiet one.
  const denied = createRealtime({
    schema: TOPICS, connect: socket.connect.bind(socket), authorize: async () => false,
  });
  await assert.rejects(() => denied.watch("task", () => {}),
    (error) => error.code === REALTIME_ERROR.NOT_AUTHORIZED);
  assert.equal(denied.getState().topics.task, REALTIME_STATUS.ERROR);
  assert.equal(denied.openChannels(), 0);
  assert.throws(() => createRealtime({ schema: TOPICS }), (error) => error.code === REALTIME_ERROR.UNAVAILABLE);
});

test("WP10 — the plan is derived from declared fields and the contract's own words", () => {
  assert.equal(isFileField({ name: "coverImage", type: "image" }), true);
  assert.equal(isFileField({ name: "attachment", type: "file" }), true);
  assert.equal(isFileField({ name: "title", type: "string" }), false);
  assert.equal(isFileField({ name: "fileId", type: "string" }), false, "a reference to a file is not a file");

  const contract = {
    entities: [
      { name: "task", fields: [{ name: "title", type: "string" }, { name: "coverImage", type: "image" }, { name: "brief", type: "document" }] },
      { name: "comment", fields: [{ name: "text", type: "text" }] },
    ],
    journeys: [
      { id: "collab", title: "Team members see each other changes in real time", steps: [
        { id: "c1", operates: ["create-task"], expect: "the task appears for everyone without a refresh" },
        { id: "c2", operates: ["assign-task"], expect: "the assignee is notified" },
        { id: "c3", operates: ["reset"], expect: "a security alert is sent when the password changes" },
      ] },
    ],
    operations: [],
  };
  const schema = { entities: ["task", "comment"] };

  const files = deriveFilePlan(contract, { entitySchema: schema });
  assert.deepEqual(files.subjects.map((row) => row.subject), ["task"], "only entities with file fields are subjects");
  assert.deepEqual(files.subjects[0].fields.map((field) => field.kind).sort(), ["document", "image"]);
  assert.deepEqual([...files.policy.kinds].sort(), ["document", "image"]);
  assert.deepEqual(files.policy.defaults, ["maxBytes", "maxPerSubject", "signedUrlSeconds"],
    "a limit the platform chose is recorded as a default, not presented as a declaration");

  const notifications = deriveNotificationPlan(contract);
  assert.deepEqual(notifications.events.map((event) => event.id), ["collab.c2", "collab.c3"]);
  assert.equal(notifications.events[0].recipient, "self");
  assert.equal(notifications.events[1].recipient, "server", "a security alert is not the visitor's to write");

  const realtime = deriveRealtimePlan(contract, { entitySchema: schema });
  assert.deepEqual(realtime.topics.map((topic) => topic.id), ["task"], "the entity the contract actually names");
  assert.equal(realtime.source, "contract_vocabulary");

  // Silence claims nothing.
  const quiet = { entities: [{ name: "task", fields: [{ name: "title", type: "string" }] }], journeys: [{ id: "j", title: "Staff add a task", steps: [] }], operations: [] };
  assert.deepEqual(deriveFilePlan(quiet, { entitySchema: schema }).subjects, []);
  assert.equal(deriveFilePlan(quiet, { entitySchema: schema }).policy, null);
  assert.deepEqual(deriveNotificationPlan(quiet).events, []);
  assert.deepEqual(deriveRealtimePlan(quiet, { entitySchema: schema }).topics, []);
  assert.deepEqual(deriveDeliveryPlan(quiet, { entitySchema: schema }).verification, []);
});

const BOARD = {
  version: 2, summary: "shared team board with live updates", auth: { required: true },
  entities: [{ name: "task", fields: [
    { name: "id" }, { name: "title", type: "string", required: true }, { name: "coverImage", type: "image" },
  ] }],
  operations: [
    { id: "create-task", kind: "create", entity: "task" },
    { id: "list-tasks", kind: "list", entity: "task" },
    { id: "update-task", kind: "update", entity: "task" },
  ],
  journeys: [{ id: "collab", title: "Team members see each other changes in real time", steps: [
    { id: "c1", operates: ["create-task"], expect: "the task appears for everyone without a refresh" },
    { id: "c2", operates: ["update-task"], expect: "the assignee is notified" },
  ] }],
};

const ENABLED = availabilityFromEnv({
  SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon",
  THRALLO_APP_SERVICE_ACCOUNTS: "1", THRALLO_APP_SERVICE_STORAGE: "1", THRALLO_APP_SERVICE_NOTIFICATIONS: "1",
});

test("WP10 — a declaring contract locks all three modules and composes protected facades", () => {
  const spec = deriveBuildSpec(BOARD, { availability: ENABLED });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const locked = spec.moduleLock.modules.map((row) => row.id);
  for (const id of ["thrallo.files", "thrallo.notifications", "thrallo.realtime"]) {
    assert.ok(locked.includes(id), `${id} is locked`);
  }
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.files").reasons,
    ["declared fields hold uploaded files"]);
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.realtime").reasons,
    ["the contract claims changes appear without a reload"]);

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan,
  });
  assert.ok(tree[FILES_COMPOSED_PATH].includes("compileFilePolicy("));
  assert.ok(tree[FILES_COMPOSED_PATH].includes('"image"'), "the declared kind is embedded");
  assert.ok(tree[NOTIFICATIONS_COMPOSED_PATH].includes("compileNotifications("));
  assert.ok(tree[REALTIME_COMPOSED_PATH].includes("resync:"), "the topic knows how to close its own gap");
  assert.ok(tree[APP_FACADE_FILES_PATH].includes("export function useFiles("));
  assert.ok(tree[APP_FACADE_FILES_PATH].includes("export const fileAccept"), "the picker and the policy agree");
  assert.ok(tree[APP_FACADE_NOTIFICATIONS_PATH].includes("export function useNotifications("));
  assert.ok(tree[APP_FACADE_REALTIME_PATH].includes("export function useLive("));
  assert.ok(tree["src/lib/app/index.js"].includes('export * from "./realtime.js";'));

  for (const path of [FILES_COMPOSED_PATH, NOTIFICATIONS_COMPOSED_PATH, REALTIME_COMPOSED_PATH,
    APP_FACADE_FILES_PATH, APP_FACADE_NOTIFICATIONS_PATH, APP_FACADE_REALTIME_PATH]) {
    assert.ok(tree[path].includes("Protected deterministic foundation"));
    assert.ok(isProtectedPath(path), `${path} stays under the write guard`);
  }
  for (const path of ["src/lib/modules/files.js", "src/lib/modules/notifications.js", "src/lib/modules/realtime.js"]) {
    assert.equal(typeof REACT_VITE[path], "string", `${path} ships in the scaffold`);
    assert.ok(isProtectedPath(path));
  }
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
});

test("WP10 — storage is availability-gated: without it the build blocks rather than shipping a dead upload button", () => {
  // The source baseline ships the notification tables but NOT the storage bucket, which is
  // provisioned per deployment. A contract that wants files must have it declared.
  assert.equal(baselineDeploymentAvailability().services.notifications, true);
  assert.equal(baselineDeploymentAvailability().services.storage, false);

  const spec = deriveBuildSpec(BOARD, { availability: baselineDeploymentAvailability() });
  assert.equal(spec.verdict.ok, false);
  const problem = spec.moduleResolution.problems.find((row) => row.module === "thrallo.files");
  assert.equal(problem.code, "module_unavailable");
  assert.equal(problem.configurationRequired, true, "an operator enables the bucket; the compiler does not generate around it");
  assert.ok(spec.verdict.problems.some((row) => row.includes("thrallo.files")));

  // The manifests state the services they need, so the refusal is explainable.
  assert.ok(moduleManifest("thrallo.files").requires.services.includes("storage"));
  assert.ok(moduleManifest("thrallo.notifications").requires.services.includes("notifications"));
  assert.ok(moduleManifest("thrallo.realtime").requires.services.includes("realtime"));
  assert.equal(moduleManifest("thrallo.notifications").provides.operations.some((row) => row.id === "send"), true);
});

test("WP10 — negative control: a contract that mentions none of this composes none of it", () => {
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
  const spec = deriveBuildSpec(quiet, { availability: ENABLED });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.equal(spec.deliveryPlan.files.policy, null);
  assert.deepEqual(spec.deliveryPlan.notifications.events, []);
  assert.deepEqual(spec.deliveryPlan.realtime.topics, []);
  const locked = spec.moduleLock.modules.map((row) => row.id);
  for (const id of ["thrallo.files", "thrallo.notifications", "thrallo.realtime"]) {
    assert.equal(locked.includes(id), false, `${id} was locked for a contract that never asked`);
  }
  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan,
  });
  for (const path of [FILES_COMPOSED_PATH, NOTIFICATIONS_COMPOSED_PATH, REALTIME_COMPOSED_PATH,
    APP_FACADE_FILES_PATH, APP_FACADE_NOTIFICATIONS_PATH, APP_FACADE_REALTIME_PATH]) {
    assert.equal(path in tree, false, `${path} composed for a contract that declares none of it`);
  }
});
