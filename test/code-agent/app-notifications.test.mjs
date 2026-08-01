// Per-app end-user notifications (audit PR 5).
//
// The SDK has exposed `backend.notifications` since the fork against a table that never existed,
// so every call in every generated app failed. Building the table alone would have shipped an
// inert feature — nothing wrote to it — so these tests cover the whole shape: the trusted writer,
// the real event integrations, and the boundary that makes a platform notification trustworthy.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  notifyAppUser, notifyWelcome, notifyPasswordChanged, appUserByEmail,
  listAppNotifications, NOTIFICATION_SOURCES,
} from "../../shell/server/lib/appNotifications.mjs";

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A minimal stand-in for the two tables the writer touches.
function fakeDb({ users = [], failInsert = false } = {}) {
  const rows = [];
  return {
    rows,
    from(table) {
      const state = { filters: {} };
      const api = {
        select() { return api; },
        eq(column, value) { state.filters[column] = value; return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle: async () => {
          if (table !== "app_users") return { data: null, error: null };
          const match = users.find((u) =>
            u.app_id === state.filters.app_id && u.email === state.filters.email);
          return { data: match || null, error: null };
        },
        insert(row) {
          return {
            select: () => ({
              single: async () => {
                if (failInsert) return { data: null, error: { message: "write failed" } };
                const created = { id: `n${rows.length + 1}`, ...row };
                rows.push(created);
                return { data: created, error: null };
              },
            }),
          };
        },
        then: (resolve) => Promise.resolve(resolve({
          data: rows.filter((r) => r.app_id === state.filters.app_id && r.owner === state.filters.owner),
          error: null,
        })),
      };
      return api;
    },
  };
}

test("the trusted writer records a notification the user could not write themselves", async () => {
  const db = fakeDb();
  const result = await notifyAppUser({
    appId: "app-1", appUserId: "user-1", source: "app_welcome",
    title: "Welcome", body: "Your account is ready.", client: db,
  });
  assert.equal(result.delivered, true);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].source, "app_welcome");
  assert.equal(db.rows[0].owner, "user-1");
  assert.equal(db.rows[0].app_id, "app-1");
});

test("an unknown source is refused — provenance is a closed set", async () => {
  await assert.rejects(
    () => notifyAppUser({ appId: "a", appUserId: "u", source: "not_a_real_source", title: "x" }),
    /unknown notification source/,
  );
  for (const source of NOTIFICATION_SOURCES) assert.equal(typeof source, "string");
  assert.ok(NOTIFICATION_SOURCES.includes("app_welcome"));
  assert.ok(NOTIFICATION_SOURCES.includes("password_changed"));
});

test("a notification never fails the event that produced it", async () => {
  // A failed signup notification must not roll back the signup.
  const db = fakeDb({ failInsert: true });
  const result = await notifyAppUser({
    appId: "app-1", appUserId: "user-1", source: "app_welcome", title: "Welcome", client: db,
  });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, "write_failed");

  // Nor does a missing recipient.
  const empty = fakeDb({ users: [] });
  const missing = await notifyPasswordChanged({ appId: "app-1", email: "nobody@example.com", client: empty });
  assert.equal(missing.delivered, false);
  assert.equal(missing.reason, "no_recipient");
});

test("a disabled app user receives nothing", async () => {
  const db = fakeDb({ users: [{ app_id: "app-1", email: "banned@example.com", auth_user_id: "u9", status: "disabled" }] });
  assert.equal(await appUserByEmail({ appId: "app-1", email: "banned@example.com", client: db }), null);
  const result = await notifyPasswordChanged({ appId: "app-1", email: "banned@example.com", client: db });
  assert.equal(result.delivered, false);
});

test("email lookup is case- and whitespace-insensitive, matching how app-auth stores it", async () => {
  const db = fakeDb({ users: [{ app_id: "app-1", email: "person@example.com", auth_user_id: "u5", status: "active" }] });
  assert.equal(await appUserByEmail({ appId: "app-1", email: "  Person@Example.com ", client: db }), "u5");
});

test("titles and bodies are clamped rather than rejected", async () => {
  const db = fakeDb();
  await notifyAppUser({
    appId: "a", appUserId: "u", source: "app_welcome",
    title: "T".repeat(400), body: "B".repeat(5000), client: db,
  });
  assert.ok(db.rows[0].title.length <= 160);
  assert.ok(db.rows[0].body.length <= 2000);
  await assert.rejects(
    () => notifyAppUser({ appId: "a", appUserId: "u", source: "app_welcome", title: "   ", client: db }),
    /title is required/,
  );
});

test("the welcome and security notifications say the right thing", async () => {
  const db = fakeDb();
  await notifyWelcome({ appId: "a", appUserId: "u", appName: "Barber Booking", client: db });
  assert.match(db.rows[0].title, /Welcome to Barber Booking/);

  const db2 = fakeDb({ users: [{ app_id: "a", email: "p@example.com", auth_user_id: "u2", status: "active" }] });
  await notifyPasswordChanged({ appId: "a", email: "p@example.com", client: db2 });
  assert.match(db2.rows[0].title, /password was changed/i);
  assert.match(db2.rows[0].body, /wasn't you/i, "must tell the user what to do if it was not them");
  assert.equal(db2.rows[0].data.kind, "security");
});

// ── The security boundary ───────────────────────────────────────────────────────────────

test("column grants make `source` a claim only the service role can make", async () => {
  const sql = await read("../../supabase/migrations/20260801220000_app_notifications.sql");
  const ddl = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  // Both alternatives were tried against production and rejected: a single `for all` policy let
  // a client forge source='password_changed' and phish its own users; pinning `source is null`
  // in WITH CHECK then stopped users marking a PLATFORM notification as read. Column privileges
  // carry the boundary instead — `source` is simply not writable by the client.
  assert.match(ddl, /grant insert \(owner, app_id, title, body, data\) on table public\.app_notifications to authenticated/i,
    "an app may author only these columns — `source` must not be among them");
  assert.doesNotMatch(ddl, /grant insert \([^)]*source/i, "source must never be client-insertable");
  assert.match(ddl, /grant update \(read_at\) on table public\.app_notifications to authenticated/i,
    "read_at is the only field a client may update");
  assert.doesNotMatch(ddl, /grant update on table public\.app_notifications to authenticated/i);

  // Ordinary owner scoping still holds, and anon reaches nothing.
  assert.match(ddl, /using \(owner = auth\.uid\(\)\)/i);
  assert.match(ddl, /revoke all on table public\.app_notifications from public, anon, authenticated/i);
  assert.match(ddl, /grant all privileges on table public\.app_notifications to service_role/i);
});

test("the SDK writes directly under RLS instead of calling an undeployed function", async () => {
  const sdk = await read("../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js");
  const block = sdk.slice(sdk.indexOf("const notifications = {"), sdk.indexOf("const actions ="));

  // notifySelf used to POST to the `actions` Edge Function, which Thrallo never deployed.
  assert.doesNotMatch(block, /actionPost\("notify_self"/,
    "notifySelf must not depend on the undeployed actions function");
  assert.match(block, /from\("app_notifications"\)\s*\.insert/, "notifySelf inserts directly");
  assert.match(block, /session\.user\.id/, "the row is owned by the signed-in user");
  assert.match(block, /source/, "list must surface provenance so platform notifications are recognisable");
  assert.match(block, /unreadCount|markAllRead/, "the surface is usable, not minimal");
});

test("app-auth carries both real event integrations and cannot break auth", async () => {
  const fn = await read("../../supabase/functions/app-auth/index.ts");
  assert.match(fn, /async function notifyAppUser/, "the trusted writer runs where the service role is");
  assert.match(fn, /"app_welcome"/, "signup must notify");
  assert.match(fn, /"password_changed"/, "a password change must notify");

  // The writer swallows its own failures: a notification must never fail a signup or a reset.
  const writer = fn.slice(fn.indexOf("async function notifyAppUser"), fn.indexOf("async function sendResetEmail"));
  assert.match(writer, /try\s*\{[\s\S]*catch/, "the writer must never throw into the auth flow");

  // The security alert is written BEFORE the response is returned, so it cannot be skipped.
  const confirm = fn.slice(fn.indexOf('action === "reset-confirm"'));
  assert.ok(confirm.indexOf('"password_changed"') < confirm.indexOf("return json(200"),
    "the alert must be recorded before the success response");
});

test("notifications are covered by disaster recovery", async () => {
  const { CA_TABLES } = await import("../../ops/backup-thrallo.mjs");
  const { RESTORE_ORDER } = await import("../../ops/restore-thrallo.mjs");
  assert.ok(CA_TABLES.includes("app_notifications"), "app_notifications must be backed up");
  assert.ok(RESTORE_ORDER.includes("app_notifications"));
});

test("server-side read is owner- and app-scoped", async () => {
  const db = fakeDb();
  db.rows.push(
    { id: "n1", owner: "u1", app_id: "app-1", title: "Mine" },
    { id: "n2", owner: "u2", app_id: "app-1", title: "Theirs" },
    { id: "n3", owner: "u1", app_id: "app-2", title: "Other app" },
  );
  const mine = await listAppNotifications({ appId: "app-1", appUserId: "u1", client: db });
  assert.deepEqual(mine.map((r) => r.title), ["Mine"]);
});
