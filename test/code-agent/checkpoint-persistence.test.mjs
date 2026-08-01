// Persistent checkpoints, BYOK safeguards and rolling daily BYOK spend (2026-08-01).
//
// Closes the three limitations left open by #119/#120: the checkpoint ring was in-memory
// (lost on restart), maxDailySpend was enforced but always received 0, and the BYOK
// controls had no UI or save path.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpointStore, restoreCheckpointStore, checkpointWriter, loadCheckpointRows,
  releaseLifecycleCheckpoints, sweepCheckpoints, restoreCheckpoint, scrubTree,
  checkpointRetentionHours, CHECKPOINT_TABLE,
} from "../../shell/server/lib/appBuild/buildCheckpoints.mjs";
import { shouldRestore, recoverInterruptedLifecycles } from "../../shell/server/lib/appBuild/checkpointRecovery.mjs";
import { dailyWindow, dailyByokSpend, dailyVerdict, dailyWarningMessage } from "../../shell/server/lib/appBuild/byokSpend.mjs";
import {
  normalizeByokSafety, normalizeByokSafetyDocument, validateByokSafetyInput,
  byokDispatchCheck, byokControlsEnabled, BYOK_CONTROLS,
} from "../../shell/server/lib/appBuild/byokSafety.mjs";

// ── A tiny in-memory stand-in for the two tables these features touch ───────────────────

function fakeDb() {
  const tables = { [CHECKPOINT_TABLE]: [], ai_requests: [], projects: [], build_jobs: [] };
  let autoId = 0;
  const build = (name) => {
    const state = { name, filters: [], order: null, limitN: null, selecting: false };
    const rows = () => tables[name].filter((row) =>
      state.filters.every(({ op, column, value }) => {
        if (op === "eq") return row[column] === value;
        if (op === "in") return value.includes(row[column]);
        if (op === "lt") return row[column] != null && row[column] < value;
        if (op === "gte") return row[column] != null && row[column] >= value;
        return true;
      }));
    const api = {
      eq: (column, value) => { state.filters.push({ op: "eq", column, value }); return api; },
      in: (column, value) => { state.filters.push({ op: "in", column, value }); return api; },
      lt: (column, value) => { state.filters.push({ op: "lt", column, value }); return api; },
      gte: (column, value) => { state.filters.push({ op: "gte", column, value }); return api; },
      order: (column, { ascending = true } = {}) => { state.order = { column, ascending }; return api; },
      limit: (n) => { state.limitN = n; return api; },
      select: () => { state.selecting = true; return api; },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => ({ data: rows()[0] || null, error: null }),
      insert: (row) => {
        const list = [].concat(row);
        for (const item of list) {
          autoId += 1;
          tables[name].push({ id: item.id || `row-${autoId}`, ...item });
        }
        return { error: null, then: (fn) => Promise.resolve(fn({ error: null })) };
      },
      update: (patch) => {
        const target = { ...api, then: undefined };
        const applier = {
          eq: (column, value) => { state.filters.push({ op: "eq", column, value }); return applier; },
          then: undefined,
        };
        // Two .eq() calls then resolve — matches the pipeline's owner+id update shape.
        let applied = false;
        const finish = () => {
          if (applied) return { error: null };
          applied = true;
          for (const row of rows()) Object.assign(row, patch);
          return { error: null };
        };
        applier.eq = (column, value) => {
          state.filters.push({ op: "eq", column, value });
          return { ...applier, ...finish(), eq: applier.eq };
        };
        void target;
        return applier;
      },
      delete: () => {
        const deleter = {
          eq: (column, value) => { state.filters.push({ op: "eq", column, value }); return deleter; },
          in: (column, value) => { state.filters.push({ op: "in", column, value }); return deleter; },
          lt: (column, value) => { state.filters.push({ op: "lt", column, value }); return deleter; },
          limit: (n) => { state.limitN = n; return deleter; },
          select: async () => {
            const doomed = rows();
            tables[name] = tables[name].filter((row) => !doomed.includes(row));
            return { data: doomed, error: null };
          },
          // Awaiting the chain without .select() deletes too, like the real client.
          then: (resolve) => {
            const doomed = rows();
            tables[name] = tables[name].filter((row) => !doomed.includes(row));
            return Promise.resolve(resolve({ data: doomed, error: null }));
          },
        };
        return deleter;
      },
      then: (resolve) => {
        let out = rows();
        if (state.order) {
          const { column, ascending } = state.order;
          out = out.slice().sort((a, b) => (ascending ? 1 : -1) * ((a[column] > b[column]) ? 1 : (a[column] < b[column]) ? -1 : 0));
        }
        if (state.limitN != null) out = out.slice(0, state.limitN);
        return Promise.resolve(resolve({ data: out, error: null }));
      },
    };
    return api;
  };
  return { tables, from: (name) => build(name) };
}

const OWNER = "owner-1";
const OTHER = "owner-2";

// ── 1. Persistence + restart recovery ───────────────────────────────────────────────────

test("checkpoints are written through to durable storage", async () => {
  const db = fakeDb();
  const store = createCheckpointStore({
    persist: checkpointWriter({ client: db, owner: OWNER, projectId: "p1", buildId: "b1" }),
  });
  store.create({ tree: { "src/App.jsx": "v1" }, attempt: 1, compileOk: true, previewOk: true });
  store.create({ tree: { "src/App.jsx": "v2" }, attempt: 2, compileOk: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(db.tables[CHECKPOINT_TABLE].length, 2);
  const [first] = db.tables[CHECKPOINT_TABLE];
  assert.equal(first.mark, "preview-ready");
  assert.equal(first.owner, OWNER);
  assert.equal(first.build_id, "b1");
  assert.ok(first.expires_at, "retention is stamped at write time");
});

test("a simulated server restart resumes and restores the last known good checkpoint", async () => {
  const db = fakeDb();
  // Round 1 reached preview-ready; round 2 broke the build. Then the process dies.
  const before = createCheckpointStore({
    persist: checkpointWriter({ client: db, owner: OWNER, projectId: "p1", buildId: "b1" }),
  });
  before.create({ tree: { "src/App.jsx": "working" }, attempt: 1, compileOk: true, previewOk: true });
  before.create({ tree: { "src/App.jsx": "broken" }, attempt: 2, compileOk: false });
  await new Promise((r) => setTimeout(r, 10));

  // NEW PROCESS: nothing in memory. The store rebuilds itself from durable rows.
  const resumed = await restoreCheckpointStore({ client: db, owner: OWNER, buildId: "b1" });
  assert.equal(resumed.size(), 2, "both checkpoints survived the restart");
  const good = resumed.lastKnownGood();
  assert.equal(good.mark, "preview-ready");
  assert.deepEqual(good.tree, { "src/App.jsx": "working" }, "the good tree survived in full");
  assert.ok(resumed.betterThanLatest(), "a better state than the latest is available to restore");

  // And it can be put back as the project's current state.
  db.tables.projects.push({ id: "p1", owner: OWNER, tree: { "src/App.jsx": "broken" } });
  const result = await restoreCheckpoint(resumed.betterThanLatest(), { client: db, owner: OWNER, projectId: "p1" });
  assert.equal(result.restored, true);
  assert.deepEqual(db.tables.projects[0].tree, { "src/App.jsx": "working" });
});

test("boot recovery restores a project left worse by an interrupted build", async () => {
  const db = fakeDb();
  db.tables.build_jobs.push({ id: "j1", owner: OWNER, project_id: "p1", status: "interrupted", updated_at: "2026-08-01T10:00:00Z" });
  db.tables.projects.push({ id: "p1", owner: OWNER, tree: { "src/App.jsx": "broken" } });
  db.tables[CHECKPOINT_TABLE].push(
    { id: "c1", owner: OWNER, build_id: "b1", project_id: "p1", seq: 1, mark: "preview-ready", tree: { "src/App.jsx": "working" }, file_count: 1 },
    { id: "c2", owner: OWNER, build_id: "b1", project_id: "p1", seq: 2, mark: "generated", tree: { "src/App.jsx": "broken" }, file_count: 1 },
  );
  const recovered = await recoverInterruptedLifecycles({ client: db });
  assert.equal(recovered, 1);
  assert.deepEqual(db.tables.projects[0].tree, { "src/App.jsx": "working" }, "last known good put back after restart");
});

test("boot recovery leaves an already-good project alone", async () => {
  const rows = [
    { id: "c1", seq: 1, mark: "compiled", tree: { a: "1" } },
    { id: "c2", seq: 2, mark: "verification-passed", tree: { a: "2" } },
  ];
  // The best checkpoint IS the latest — nothing to roll back to.
  assert.equal(shouldRestore({ rows, currentTree: { a: "2" } }), null);
  // And when the project already holds the good tree, no write is needed.
  const worse = [
    { id: "c1", seq: 1, mark: "verification-passed", tree: { a: "good" } },
    { id: "c2", seq: 2, mark: "verification-failed", tree: { a: "bad" } },
  ];
  assert.equal(shouldRestore({ rows: worse, currentTree: { a: "good" } }), null);
  assert.equal(shouldRestore({ rows: worse, currentTree: { a: "bad" } })?.id, "c1");
});

test("checkpoint data is tenant-isolated", async () => {
  const db = fakeDb();
  db.tables[CHECKPOINT_TABLE].push(
    { id: "c1", owner: OWNER, build_id: "b1", project_id: "p1", seq: 1, mark: "compiled", tree: { mine: "1" } },
    { id: "c2", owner: OTHER, build_id: "b2", project_id: "p1", seq: 1, mark: "compiled", tree: { theirs: "1" } },
  );
  const mine = await loadCheckpointRows({ client: db, owner: OWNER, projectId: "p1" });
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].tree, { mine: "1" }, "another tenant's checkpoint is never returned");
  const theirs = await loadCheckpointRows({ client: db, owner: OTHER, projectId: "p1" });
  assert.equal(theirs.length, 1);
  assert.deepEqual(theirs[0].tree, { theirs: "1" });
});

test("the checkpoints table is service-role only with RLS on and no policies", async () => {
  const fs = await import("node:fs");
  const sql = await fs.promises.readFile(
    new URL("../../supabase/migrations/20260801160000_persistent_build_checkpoints.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.build_checkpoints enable row level security/i);
  assert.match(sql, /revoke all on table public\.build_checkpoints from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table public\.build_checkpoints\s+to service_role/i);
  assert.doesNotMatch(sql, /create policy[\s\S]*build_checkpoints/i, "no policy may open this table to a browser role");
  // Comments and COMMENT ON text may explain why the repo-agent table is separate; the
  // executable DDL must never reference it. Strip line comments and string literals first.
  const ddl = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(ddl, /ca_checkpoints/, "must not touch the repo-agent checkpoint table");
});

test("no secret or key material can enter a checkpoint payload", () => {
  const scrubbed = scrubTree({
    "src/App.jsx": "export default function App(){return null}",
    ".env": "VITE_SUPABASE_ANON_KEY=sk-live-abcdef123456",
    "src/config.js": "export const config = { apiKey: 'sk-live-secret-value', name: 'app' };",
    "keys/server.pem": "-----BEGIN PRIVATE KEY-----",
  });
  assert.ok(!(".env" in scrubbed.tree), "env files are dropped entirely");
  assert.ok(!("keys/server.pem" in scrubbed.tree), "key material is dropped entirely");
  assert.equal(scrubbed.tree["src/App.jsx"], "export default function App(){return null}", "ordinary code is untouched");
  assert.doesNotMatch(scrubbed.tree["src/config.js"], /sk-live-secret-value/, "inline secrets are redacted");
  assert.match(scrubbed.tree["src/config.js"], /\[redacted\]/);

  // And the store applies it — a checkpoint never holds what scrubTree removes.
  const store = createCheckpointStore();
  const entry = store.create({ tree: { ".env": "KEY=sk-live-1", "a.js": "ok" }, attempt: 1 });
  assert.ok(!(".env" in entry.tree));
  assert.equal(entry.fileCount, 1);
});

test("retention is bounded: expired rows sweep and a finished lifecycle releases all but its best", async () => {
  assert.ok(checkpointRetentionHours() > 0);
  const db = fakeDb();
  db.tables[CHECKPOINT_TABLE].push(
    { id: "old", owner: OWNER, build_id: "b0", project_id: "p1", seq: 1, mark: "compiled", tree: {}, expires_at: "2020-01-01T00:00:00Z" },
    { id: "fresh", owner: OWNER, build_id: "b0", project_id: "p1", seq: 2, mark: "compiled", tree: {}, expires_at: "2999-01-01T00:00:00Z" },
  );
  assert.equal(await sweepCheckpoints({ client: db }), 1);
  assert.deepEqual(db.tables[CHECKPOINT_TABLE].map((r) => r.id), ["fresh"]);

  const db2 = fakeDb();
  db2.tables[CHECKPOINT_TABLE].push(
    { id: "a", owner: OWNER, build_id: "b1", project_id: "p1", seq: 1, mark: "generated", tree: {} },
    { id: "b", owner: OWNER, build_id: "b1", project_id: "p1", seq: 2, mark: "verification-passed", tree: {} },
    { id: "c", owner: OWNER, build_id: "b1", project_id: "p1", seq: 3, mark: "verification-failed", tree: {} },
  );
  assert.equal(await releaseLifecycleCheckpoints({ client: db2, owner: OWNER, buildId: "b1" }), 2);
  assert.deepEqual(db2.tables[CHECKPOINT_TABLE].map((r) => r.id), ["b"], "the best checkpoint is kept as the safety net");
});

// ── 2. Rolling daily BYOK spend ─────────────────────────────────────────────────────────

const DAY = "2026-08-01T12:00:00Z";

function seedRequests(db, rows) {
  for (const row of rows) db.tables.ai_requests.push({ owner: OWNER, byok: true, ...row });
}

test("the daily window is a clearly defined UTC day by default", () => {
  const window = dailyWindow({ now: new Date(DAY) });
  assert.equal(window.timezone, "UTC");
  assert.equal(window.start.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-08-02T00:00:00.000Z");
  // A configured timezone shifts the window and never throws on a bad value.
  assert.equal(dailyWindow({ now: new Date(DAY), timezone: "Australia/Sydney" }).timezone, "Australia/Sydney");
  assert.equal(dailyWindow({ now: new Date(DAY), timezone: "Not/AZone" }).timezone, "UTC");
});

test("daily spend aggregates real BYOK usage, split by provider", async () => {
  const db = fakeDb();
  seedRequests(db, [
    { provider: "openai", cost: 1.5, created_at: "2026-08-01T09:00:00Z" },
    { provider: "openai", cost: 2.0, created_at: "2026-08-01T11:00:00Z" },
    { provider: "xai", cost: 0.5, created_at: "2026-08-01T11:30:00Z" },
  ]);
  const all = await dailyByokSpend({ client: db, owner: OWNER, now: new Date(DAY) });
  assert.equal(all.available, true);
  assert.equal(all.total, 4);
  assert.deepEqual(all.byProvider, { openai: 3.5, xai: 0.5 });
  const scoped = await dailyByokSpend({ client: db, owner: OWNER, provider: "openai", now: new Date(DAY) });
  assert.equal(scoped.total, 3.5, "per-provider totals stay separate");
});

test("managed usage, other tenants, other days and uncharged requests are all excluded", async () => {
  const db = fakeDb();
  seedRequests(db, [
    { provider: "openai", cost: 5, created_at: "2026-08-01T09:00:00Z" },
    { provider: "openai", cost: 99, created_at: "2026-08-01T09:00:00Z", byok: false },   // managed
    { provider: "openai", cost: 99, created_at: "2026-07-31T23:59:00Z" },                 // yesterday
    { provider: "openai", cost: 99, created_at: "2026-08-02T00:00:01Z" },                 // tomorrow
    { provider: "openai", cost: null, created_at: "2026-08-01T10:00:00Z" },               // failed request
    { provider: "openai", cost: 0, created_at: "2026-08-01T10:00:00Z" },                  // nothing charged
  ]);
  db.tables.ai_requests.push({ owner: OTHER, byok: true, provider: "openai", cost: 99, created_at: "2026-08-01T09:00:00Z" });
  const spend = await dailyByokSpend({ client: db, owner: OWNER, now: new Date(DAY) });
  assert.equal(spend.total, 5, "only this tenant's charged BYOK requests inside today's window");
});

test("retries and provider switches are counted once, under the right provider", async () => {
  const db = fakeDb();
  // One lifecycle: initial build, a repair, and a fallback switch to xai. Each row is one
  // real charged request — repairs SHOULD count; nothing is double-counted.
  seedRequests(db, [
    { provider: "openai", cost: 2, build_id: "b1", created_at: "2026-08-01T09:00:00Z" },
    { provider: "openai", cost: 1, build_id: "b1", created_at: "2026-08-01T09:05:00Z" },
    { provider: "xai", cost: 0.4, build_id: "b1", created_at: "2026-08-01T09:10:00Z" },
  ]);
  const spend = await dailyByokSpend({ client: db, owner: OWNER, now: new Date(DAY) });
  assert.equal(spend.total, 3.4);
  assert.deepEqual(spend.byProvider, { openai: 3, xai: 0.4 });
  const afterSwitch = await dailyByokSpend({ client: db, owner: OWNER, provider: "xai", now: new Date(DAY) });
  assert.equal(afterSwitch.total, 0.4, "a switch does not re-count the previous provider's spend");
});

test("daily enforcement happens only when the user set a limit, and fails open", async () => {
  const spend = { available: true, total: 12, window: { end: new Date(DAY) } };
  assert.equal(dailyVerdict({ spend, limit: null }).enforced, false, "no limit -> never enforced");
  assert.equal(dailyVerdict({ spend, limit: 20 }).blocked, false);
  assert.equal(dailyVerdict({ spend, limit: 10 }).blocked, true);
  const warned = dailyVerdict({ spend, limit: 20, warnAt: 10 });
  assert.equal(warned.warn, true);
  assert.match(dailyWarningMessage(warned), /warning level you set/i);
  // Accounting unavailable: never block the user's own paid capacity.
  const broken = dailyVerdict({ spend: { available: false, total: 0 }, limit: 1 });
  assert.equal(broken.enforced, false);
  assert.equal(broken.blocked, false);
  assert.equal(broken.reason, "accounting_unavailable");
});

test("an accounting outage returns unavailable rather than throwing", async () => {
  const broken = { from: () => { throw new Error("connection reset"); } };
  const spend = await dailyByokSpend({ client: broken, owner: OWNER, now: new Date(DAY) });
  assert.equal(spend.available, false);
  assert.equal(spend.total, 0);
  assert.equal(spend.reason, "accounting_unavailable");
});

test("the daily limit blocks a dispatch only once real spend reaches it", () => {
  assert.equal(byokDispatchCheck({ maxDailySpend: 10 }, { dailySpend: 4 }).ok, true);
  assert.equal(byokDispatchCheck({ maxDailySpend: 10 }, { dailySpend: 10 }).reason, "max_daily_spend");
  // With the control off, no amount of daily spend blocks.
  assert.equal(byokDispatchCheck(null, { dailySpend: 999_999 }).ok, true);
});

// ── 3. Settings: schema, validation, provider scoping ───────────────────────────────────

test("BYOK controls still default to disabled in every shape", () => {
  for (const stored of [null, {}, { global: {} }, { providers: {} }, { maxCostPerBuild: 0 }]) {
    const settings = normalizeByokSafety(stored);
    for (const key of BYOK_CONTROLS) assert.equal(settings[key], null, `${key} must default to off`);
    assert.equal(byokControlsEnabled(stored), false);
  }
});

test("per-provider safeguards override global defaults independently", () => {
  const doc = {
    global: { maxCostPerBuild: 10, maxRepairJobs: 2 },
    providers: { xai: { maxCostPerBuild: 3 }, openai: { maxCostPerBuild: null } },
  };
  assert.equal(normalizeByokSafety(doc, { provider: "xai" }).maxCostPerBuild, 3, "provider value wins");
  assert.equal(normalizeByokSafety(doc, { provider: "xai" }).maxRepairJobs, 2, "unset controls fall back to global");
  assert.equal(normalizeByokSafety(doc, { provider: "openai" }).maxCostPerBuild, null, "an explicit null turns it off for that provider");
  assert.equal(normalizeByokSafety(doc, { provider: "anthropic" }).maxCostPerBuild, 10, "unlisted providers use the global default");
  // Legacy flat documents keep working.
  assert.equal(normalizeByokSafety({ maxDailySpend: 7 }).maxDailySpend, 7);
});

test("the settings document normalises to numbers-or-null and carries a timezone", () => {
  const doc = normalizeByokSafetyDocument({
    global: { maxCostPerBuild: "5", maxDailySpend: "", warnThreshold: -1 },
    providers: { xai: { maxRepairJobs: "2" }, gemini: {} },
    timezone: "Europe/London",
  }, { providers: ["xai"] });
  assert.equal(doc.global.maxCostPerBuild, 5);
  assert.equal(doc.global.maxDailySpend, null);
  assert.equal(doc.global.warnThreshold, null, "negatives disable rather than block everything");
  assert.equal(doc.providers.xai.maxRepairJobs, 2);
  assert.ok(!("gemini" in doc.providers), "an empty provider entry is not stored");
  assert.equal(doc.timezone, "Europe/London");
});

test("invalid safeguard input is rejected before it reaches storage", () => {
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: 5 } }).ok, true);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: null } }).ok, true, "disabling is always valid");
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: "" } }).ok, true);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: -5 } }).ok, false);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: "abc" } }).ok, false);
  assert.equal(validateByokSafetyInput({ global: { maxRepairJobs: 1.5 } }).ok, false, "repair jobs must be whole");
  assert.equal(validateByokSafetyInput({ global: { nonsense: 1 } }).ok, false);
  assert.equal(validateByokSafetyInput({ timezone: "Not/AZone" }).ok, false);
  assert.equal(validateByokSafetyInput({ timezone: "Europe/London" }).ok, true);
  assert.equal(validateByokSafetyInput({ providers: { xai: { maxDailySpend: 0 } } }).ok, false);
});

test("the safeguards document never carries key material", async () => {
  const doc = normalizeByokSafetyDocument({
    global: { maxCostPerBuild: 5 },
    providers: { openai: { maxDailySpend: 20 } },
    // A hostile or careless caller cannot smuggle anything through: unknown keys are dropped
    // by normalisation and rejected by validation.
    secret_encrypted: "sk-live-should-never-appear",
    key: "sk-live-nope",
  });
  const serialized = JSON.stringify(doc);
  assert.doesNotMatch(serialized, /sk-live|secret|key/i);
  assert.deepEqual(Object.keys(doc).sort(), ["global", "providers", "timezone"]);
});

test("the settings UI explains that BYOK is uncapped and offers every control", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../shell/web/src/manage/AiSettings.jsx", import.meta.url), "utf8");
  assert.match(source, /Optional spending safeguards/);
  assert.match(source, /does not cap usage on your own/i, "the copy must say Thrallo does not cap BYOK");
  for (const [key, label] of [
    ["maxCostPerBuild", "Maximum cost per build"],
    ["maxDailySpend", "Maximum daily API spend"],
    ["warnThreshold", "Warning threshold"],
    ["approvalThreshold", "Approval threshold"],
    ["maxRepairJobs", "Maximum automatic repair jobs"],
  ]) {
    assert.match(source, new RegExp(key), `${key} control missing`);
    assert.match(source, new RegExp(label), `${label} label missing`);
  }
  assert.match(source, /Thrallo credits/, "the active currency is shown");
  assert.match(source, /Remove all limits/, "limits can be removed at any time");
  assert.match(source, /placeholder="Off"/, "an unset control reads as Off");
});
