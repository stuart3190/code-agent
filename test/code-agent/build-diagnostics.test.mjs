// Build Diagnostics: complete audit trail per build session, evidence-or-nothing failure
// explanations, retention/compression sweeps, and the guarantee that recording never
// throws into the build pipeline.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  createDiagSession, nullDiagSession, simpleLineDiff, treeChanges, unpackOutput,
  listDiagRuns, getDiagRun, getDiagStepOutput, explainBuildFailure,
  getDiagPrefs, setDiagPrefs, sweepDiagnostics, DIAG_DEFAULT_RETENTION_DAYS,
  diagnosticCapturePolicy, redactDiagnosticText, redactDiagnosticValue,
} from "../../shell/server/lib/appBuild/buildDiagnostics.mjs";

const OWNER = "owner-1";
const OTHER = "owner-2";

// Supabase-shaped in-memory fake covering diag_runs / diag_steps / diag_prefs.
function fakeDb() {
  const rows = { diag_runs: [], diag_steps: [], diag_prefs: [] };
  const from = (name) => {
    const q = { filters: [], op: null, patch: null, notFilters: [], ltFilters: [] };
    const match = (r) => q.filters.every(([k, v]) => String(r[k]) === String(v))
      && q.notFilters.every(([k, v]) => String(r[k]) !== String(v))
      && q.ltFilters.every(([k, v]) => String(r[k] ?? "") < String(v));
    const exec = () => {
      let list = rows[name].filter(match);
      if (q.order) {
        list = [...list].sort((a, b) => {
          const av = a[q.order], bv = b[q.order];
          const cmp = av > bv ? 1 : av < bv ? -1 : 0;
          return q.asc ? cmp : -cmp;
        });
      }
      if (q.limit) list = list.slice(0, q.limit);
      if (q.op === "insert") { rows[name].push(...[].concat(q.patch)); return { data: q.patch, error: null }; }
      if (q.op === "update") { list.forEach((r) => Object.assign(r, q.patch)); return { data: list, error: null }; }
      if (q.op === "upsert") {
        const existing = rows[name].find((r) => String(r.owner) === String(q.patch.owner));
        if (existing) Object.assign(existing, q.patch); else rows[name].push(q.patch);
        return { data: q.patch, error: null };
      }
      if (q.op === "delete") { rows[name] = rows[name].filter((r) => !list.includes(r)); return { data: null, error: null }; }
      return { data: list, error: null };
    };
    const chain = {
      select: () => chain, insert: (v) => { q.op = "insert"; q.patch = v; return chain; },
      update: (v) => { q.op = "update"; q.patch = v; return chain; },
      upsert: (v) => { q.op = "upsert"; q.patch = v; return chain; },
      delete: () => { q.op = "delete"; return chain; },
      eq: (k, v) => { q.filters.push([k, v]); return chain; },
      not: (k, _op, v) => { q.notFilters.push([k, v === null ? "null" : v]); return chain; },
      lt: (k, v) => { q.ltFilters.push([k, v]); return chain; },
      order: (k, opts) => { q.order = k; q.asc = opts?.ascending !== false; return chain; },
      limit: (n) => { q.limit = n; return chain; },
      maybeSingle: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: null }; },
      then: (resolve) => resolve(exec()),
    };
    // fix `not("output","is",null)` style: our .not above receives (k, op, v)
    return chain;
  };
  return { from, rows };
}

async function settle(session) { await session._chain; }

test("simpleLineDiff and treeChanges report created/modified/deleted with diffs", () => {
  const diff = simpleLineDiff("a\nb\nc", "a\nX\nc");
  assert.match(diff, /@@ line 2 @@/);
  assert.match(diff, /- b/);
  assert.match(diff, /\+ X/);
  const changes = treeChanges(
    { "keep.js": "same", "mod.js": "old", "gone.js": "x" },
    { "keep.js": "same", "mod.js": "new", "new.js": "y" },
  );
  assert.deepEqual(changes.created, ["new.js"]);
  assert.deepEqual(changes.modified, ["mod.js"]);
  assert.deepEqual(changes.deleted, ["gone.js"]);
  assert.match(changes.diffs["mod.js"], /- old/);
});

test("H13 — secrets are redacted before diagnostics persistence", async () => {
  const secret = "sk-live-super-secret-value-123456789";
  const pem = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
  const env = { OPENAI_API_KEY: secret };
  const text = redactDiagnosticText(
    `Authorization: Bearer ${secret}\nDATABASE_URL=postgres://user:password@db.example/x\n${pem}`,
    { env },
  );
  assert.doesNotMatch(text, /super-secret|:password@|abc123/);
  assert.match(text, /\[REDACTED/);
  assert.deepEqual(redactDiagnosticValue({ password: "hunter2", totalTokens: 42, nested: { token: secret } }, { env }), {
    password: "[REDACTED]", totalTokens: 42, nested: { token: "[REDACTED]" },
  });

  const db = fakeDb();
  const session = await createDiagSession({
    owner: OWNER, kind: "app_build", prompt: `build with ${secret}`, client: db, redactionEnv: env,
  });
  session.step({ kind: "terminal", label: "provider", prompt: `key=${secret}`, output: `Bearer ${secret}\n${pem}` });
  session.setPlan(`call provider with ${secret}`);
  session.setContract({ auth: { password: "hunter2" }, note: secret });
  session.finish("failed");
  await settle(session);
  const persisted = JSON.stringify(db.rows);
  assert.doesNotMatch(persisted, /super-secret|hunter2|abc123/, "raw credentials never reach the fake database");
  assert.match(persisted, /REDACTED/);
});

test("H13 — prompt and source-diff persistence can be disabled without losing runtime state", async () => {
  assert.deepEqual(diagnosticCapturePolicy({ DIAG_CAPTURE_PROMPTS: "0", DIAG_CAPTURE_SOURCE_DIFFS: "0" }), {
    prompts: false, sourceDiffs: false,
  });
  const db = fakeDb();
  const session = await createDiagSession({
    owner: OWNER, kind: "app_build", prompt: "private request", client: db,
    capturePolicy: { prompts: false, sourceDiffs: false }, redactionEnv: {},
  });
  session.setPlan("private plan");
  session.setContract({ summary: "private contract" });
  const recorder = session.recorderForJob();
  recorder.files({ "src/a.js": "old private source" }, { "src/a.js": "new private source" });
  session.finish("passed");
  await settle(session);

  assert.equal(session.contract.summary, "private contract", "runtime repair context remains available in memory");
  assert.equal(db.rows.diag_runs[0].prompt, null);
  assert.equal(db.rows.diag_runs[0].plan, null);
  assert.equal(db.rows.diag_runs[0].contract, null);
  const files = JSON.parse(unpackOutput(db.rows.diag_steps.find((row) => row.kind === "files")));
  assert.deepEqual(files.diffs, {});
  assert.deepEqual(files.modified, ["src/a.js"], "non-content audit metadata remains useful");
});

test("a session records the full trail: steps, rounds, usage, cost, terminal, files", async () => {
  const db = fakeDb();
  const session = await createDiagSession({
    owner: OWNER, projectId: "p1", conversationId: "c1", kind: "app_build",
    prompt: "Build me a CRM", client: db,
  });
  const rec = session.recorderForJob({ round: 1 });
  rec.setModel("gpt-5.6-sol");
  rec.terminal("engine: build starting");
  rec.step({ agent: "Builder", kind: "agent", label: "Initial implementation", prompt: "Build it", output: "done", usage: { inputTokens: 1000, outputTokens: 500, total: 1500 }, model: "gpt-5.6-sol" });
  rec.step({ agent: "Compiler", kind: "compiler", label: "npm run build", status: "failed", output: "src/App.jsx: Unexpected token (14:2)" });
  rec.files({ "a.js": "old" }, { "a.js": "new", "b.js": "fresh" });
  rec.jobEnd("failed");
  session.repairDispatched({ prompt: "fix the syntax error", round: 2 });
  session.step({ agent: "Verifier", kind: "verification", label: "Verification (round 2)", status: "failed", output: "Sign-up button dead", round: 2 });
  session.finish("failed");
  await settle(session);

  const run = await getDiagRun(OWNER, session.id, { client: db });
  assert.equal(run.status, "failed");
  assert.equal(run.repair_rounds, 1);
  assert.equal(run.prompt, "Build me a CRM");
  assert.equal(run.model, "gpt-5.6-sol");
  assert.ok(run.totals.totalTokens >= 1500, "token totals aggregated");
  assert.ok(run.totals.cost > 0, "cost computed per step and totalled");
  assert.ok(run.duration_ms >= 0);
  const kinds = run.steps.map((s) => s.kind);
  for (const expected of ["agent", "compiler", "files", "terminal", "repair", "verification"]) {
    assert.ok(kinds.includes(expected), `${expected} step retained`);
  }
  const compiler = run.steps.find((s) => s.kind === "compiler");
  assert.match(compiler.output, /Unexpected token \(14:2\)/, "raw compiler output kept verbatim");
  const files = JSON.parse(run.steps.find((s) => s.kind === "files").output);
  assert.deepEqual(files.created, ["b.js"]);
  assert.deepEqual(files.modified, ["a.js"]);
  const repair = run.steps.find((s) => s.kind === "repair");
  assert.equal(repair.round, 2);
  assert.match(repair.prompt, /fix the syntax error/);
});

test("large outputs are stored compressed and read back intact", async () => {
  const db = fakeDb();
  const session = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "x", client: db });
  const bigLog = "error line\n".repeat(5000);
  session.step({ kind: "compiler", label: "big", status: "failed", output: bigLog });
  session.finish("failed");
  await settle(session);
  const stored = db.rows.diag_steps.find((s) => s.label === "big");
  assert.equal(stored.output, null, "large log not stored inline");
  assert.ok(stored.output_gz, "gzip column used");
  assert.equal(gunzipSync(Buffer.from(stored.output_gz, "base64")).toString("utf8"), bigLog);
  const full = await getDiagStepOutput(OWNER, session.id, stored.seq, { client: db });
  assert.equal(full.output, bigLog, "decompressed transparently on read");
});

test("failureEvidence quotes the exact stored output; empty sessions admit the capture gap", async () => {
  const db = fakeDb();
  const session = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "x", client: db });
  session.step({ kind: "compiler", label: "npm run build", status: "failed", output: "TS2304: Cannot find name 'Stripe'." });
  // RAW form (Diagnostics/explain/operator only) quotes the exact stored line…
  const evidence = session.rawFailureEvidence();
  assert.match(evidence, /> TS2304: Cannot find name 'Stripe'\./, "exact line quoted");
  assert.match(evidence, /stored diagnostics/i);
  // …while the CONVERSATION form names the failing check and points at Diagnostics,
  // never pasting compiler output (which carries server paths) into the chat.
  const chat = session.failureEvidence();
  assert.match(chat, /npm run build/, "names which check failed");
  assert.doesNotMatch(chat, /TS2304|Cannot find name/, "no raw compiler output in the conversation");
  assert.match(chat, /Build Diagnostics/i, "points the owner at the advanced surface");

  const empty = nullDiagSession();
  assert.match(empty.failureEvidence(), /platform bug/i, "no evidence -> explicit capture-gap statement");
  assert.doesNotMatch(empty.failureEvidence(), /because|likely|probably/i, "never fabricates a cause");
});

test("explainBuildFailure quotes stored logs; without a provider it returns the raw evidence", async () => {
  const db = fakeDb();
  const session = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "build a shop", client: db });
  session.step({ kind: "compiler", label: "npm run build", status: "failed", output: "Rollup failed: 'checkout' is not exported by src/cart.js" });
  session.finish("failed");
  await settle(session);
  let balanceReads = 0;
  const { memoryDirectModelReservations } = await import("../../shell/server/lib/directModelReservations.mjs");
  const reservations = memoryDirectModelReservations({
    balanceResolver: async () => { balanceReads += 1; throw new Error("platform work cannot read customer balance"); },
  });
  let diagnosticCalls = 0;
  const fakeProvider = {
    id: "openai",
    model: "gpt-5.6-luna",
    turn: async ({ input }) => {
      diagnosticCalls += 1;
      assert.match(input, /'checkout' is not exported/, "model receives the ACTUAL stored log");
      return {
        id: `req_diagnostic_${diagnosticCalls}`,
        text: "The compiler output shows:\n```\nRollup failed: 'checkout' is not exported by src/cart.js\n```\nExport `checkout` from src/cart.js.",
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      };
    },
  };
  const explained = await explainBuildFailure(OWNER, session.id, {
    client: db,
    provider: fakeProvider,
    reservationStoreFactory: () => reservations,
  });
  assert.match(explained.explanation, /'checkout' is not exported/, "explanation quotes the stored output");
  const [reservation] = reservations.rows();
  assert.equal(balanceReads, 0);
  assert.equal(reservation.kind, "diagnostic_explanation");
  assert.equal(reservation.usageResponsibility, "platform_failure");
  assert.equal(reservation.state, "settled");
  assert.equal(reservation.includedActualCredits, 0);
  assert.deepEqual(reservation.providerRequestIds, ["req_diagnostic_1"]);
  await explainBuildFailure(OWNER, session.id, {
    client: db,
    provider: fakeProvider,
    reservationStoreFactory: () => reservations,
  });
  assert.equal(reservations.rows().length, 2,
    "each customer-requested explanation is a fresh platform-funded call identity");
  assert.ok(reservations.rows().every((row) => row.state === "settled"));

  // Failed run with NO failing steps recorded -> explicit platform-bug statement.
  const bare = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "y", client: db });
  bare.finish("failed");
  await settle(bare);
  const missing = await explainBuildFailure(OWNER, bare.id, { client: db, provider: fakeProvider });
  assert.equal(missing.missingDiagnostics, true);
  assert.match(missing.explanation, /platform bug/i);
  assert.match(missing.explanation, /won't invent a cause/i);
});

test("diagnostics are owner-scoped", async () => {
  const db = fakeDb();
  const session = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "mine", client: db });
  session.finish("passed");
  await settle(session);
  assert.equal(await getDiagRun(OTHER, session.id, { client: db }), null);
  assert.equal((await listDiagRuns(OTHER, { client: db })).length, 0);
  assert.equal((await listDiagRuns(OWNER, { client: db })).length, 1);
});

test("retention prefs validate and the sweeper purges/compresses/interrupts correctly", async () => {
  const db = fakeDb();
  assert.equal((await getDiagPrefs(OWNER, { client: db })).retentionDays, DIAG_DEFAULT_RETENTION_DAYS);
  await setDiagPrefs(OWNER, 30, { client: db });
  assert.equal((await getDiagPrefs(OWNER, { client: db })).retentionDays, 30);
  await setDiagPrefs(OWNER, null, { client: db });
  assert.equal((await getDiagPrefs(OWNER, { client: db })).retentionDays, null);
  await assert.rejects(setDiagPrefs(OWNER, 7, { client: db }), /30, 90, 365/);

  // Seed: an expired run for OTHER (default 90d), a fresh one, and a stale running one.
  const old = await createDiagSession({ owner: OTHER, kind: "app_build", prompt: "old", client: db });
  old.step({ kind: "compiler", label: "aged", output: "x".repeat(2000) });
  old.finish("failed");
  const fresh = await createDiagSession({ owner: OTHER, kind: "app_build", prompt: "fresh", client: db });
  fresh.finish("passed");
  const hung = await createDiagSession({ owner: OTHER, kind: "app_build", prompt: "hung", client: db });
  await settle(old); await settle(fresh); await settle(hung);
  const nowMs = Date.now();
  db.rows.diag_runs.find((r) => r.id === old.id).started_at = new Date(nowMs - 100 * 86_400_000).toISOString();
  db.rows.diag_runs.find((r) => r.id === hung.id).started_at = new Date(nowMs - 3 * 60 * 60_000).toISOString();

  const result = await sweepDiagnostics({ client: db, nowMs });
  assert.equal(result.purgedRuns, 1, "expired run purged per retention");
  assert.ok(result.interrupted >= 1, "stale running run marked interrupted");
  assert.equal(db.rows.diag_runs.find((r) => r.id === old.id), undefined);
  assert.ok(db.rows.diag_runs.find((r) => r.id === fresh.id), "fresh run kept");
  assert.equal(db.rows.diag_runs.find((r) => r.id === hung.id).status, "interrupted");

  // OWNER's forever pref keeps ancient runs.
  const ancient = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "ancient", client: db });
  ancient.finish("passed");
  await settle(ancient);
  db.rows.diag_runs.find((r) => r.id === ancient.id).started_at = new Date(nowMs - 1000 * 86_400_000).toISOString();
  await sweepDiagnostics({ client: db, nowMs });
  assert.ok(db.rows.diag_runs.find((r) => r.id === ancient.id), "forever retention honoured");
});

test("recording failures never propagate into the pipeline (fire-and-forget)", async () => {
  const db = fakeDb();
  const broken = { from: () => { throw new Error("storage down"); } };
  const session = await createDiagSession({ owner: OWNER, kind: "app_build", prompt: "x", client: db });
  session.db = broken;
  // None of these may throw even though every write now fails.
  session.step({ kind: "compiler", label: "x", output: "y" });
  session.repairDispatched({ prompt: "p", round: 2 });
  session.finish("failed");
  await session._chain; // chain swallows errors
  assert.ok(true);
});

test("Builder V2 strict diagnostics fail closed when required evidence cannot persist", async () => {
  const base = fakeDb();
  const client = {
    from(name) {
      if (name === "diag_steps" || name === "ai_requests") {
        return {
          insert: () => Promise.resolve({ data: null, error: { message: "diagnostic storage down" } }),
        };
      }
      return base.from(name);
    },
  };
  const session = await createDiagSession({
    owner: OWNER, kind: "app_build_v2", prompt: "x", client, strictWrites: true,
  });
  session.step({ kind: "compiler", label: "required V2 evidence", output: "failed" });
  await assert.rejects(session.flush(), /diagnostic storage down/);
});

test("unpackOutput survives corrupt compressed data honestly", () => {
  assert.match(unpackOutput({ output: null, output_gz: "not-base64-gzip!!" }), /could not be decompressed/);
  assert.equal(unpackOutput({ output: "plain" }), "plain");
});
