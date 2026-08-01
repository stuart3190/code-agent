// The error shield: users never see raw technical failure detail, the Lead Agent always
// does (privately), safe failures recover automatically, and exhausted recovery leaves a
// safe support reference. Owner-scoped advanced diagnostics.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeUserFacingText, classifyFailure, fingerprintIncident, referenceFrom,
  captureIncident, listIncidents, incidentByReference, FRIENDLY,
} from "../../shell/server/lib/errorShield.mjs";
import { isSequenceCollision, MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";
import { processConversation, MAX_RECOVERY_ATTEMPTS } from "../../shell/server/lib/leadAgentService.mjs";
import { applyEvent, emptyConversationView } from "../../shell/web/src/chat/conversationState.js";

const OWNER = "owner-1";
const OTHER = "owner-2";

// Everything a user must never see, in the shapes real failures arrive in.
const RAW_LEAKS = [
  'duplicate key value violates unique constraint "ca_conversation_events_conversation_id_sequence_key"',
  'insert or update on table "diag_runs" violates foreign key constraint "diag_runs_owner_fkey"',
  "TypeError: Cannot read properties of undefined (reading 'tree')\n    at runJob (/home/ubuntu/code-agent/shell/server/lib/buildJobs.mjs:512:19)",
  "ECONNREFUSED 10.83.7.1:8788",
  "OpenAI request failed (503): upstream overloaded",
  "sk-ant-api03-SECRETKEYMATERIAL1234567890 was rejected",
  "ENOENT: no such file or directory, open 'C:\\Users\\Administrator\\code-agent\\shell\\.env'",
  "https://zczgvcsokfafuyognvwx.supabase.co/rest/v1/ca_conversations?select=* returned 401",
];

const FORBIDDEN = /(constraint|violates|duplicate key|ca_conversation|diag_runs|supabase\.co|sk-ant|ECONNREFUSED|ENOENT|TypeError|at runJob|\/home\/ubuntu|C:\\Users|10\.83\.|\b5\d\d\b)/i;

function fakeDb(rows = { diag_incidents: [] }) {
  const from = () => {
    const q = { filters: [], op: null, patch: null };
    const match = (r) => q.filters.every(([k, v]) => String(r[k]) === String(v));
    const exec = () => {
      const list = rows.diag_incidents.filter(match);
      if (q.op === "insert") { rows.diag_incidents.push(q.patch); return { data: q.patch, error: null }; }
      if (q.op === "update") { list.forEach((r) => Object.assign(r, q.patch)); return { data: list, error: null }; }
      return { data: list, error: null };
    };
    const chain = {
      select: () => chain, insert: (v) => { q.op = "insert"; q.patch = v; return chain; },
      update: (v) => { q.op = "update"; q.patch = v; return chain; },
      eq: (k, v) => { q.filters.push([k, v]); return chain; },
      order: () => chain, limit: () => chain,
      maybeSingle: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: null }; },
      then: (resolve) => resolve(exec()),
    };
    return chain;
  };
  return { from, rows };
}

test("sanitiser strips every class of internal detail from user-facing text", () => {
  for (const raw of RAW_LEAKS) {
    const safe = sanitizeUserFacingText(raw);
    assert.doesNotMatch(safe, FORBIDDEN, `leaked from: ${raw.slice(0, 60)}`);
    assert.ok(safe.length > 0, "always yields something calm to say");
  }
  // Ordinary product sentences survive untouched.
  assert.equal(sanitizeUserFacingText("Your app is built and the preview is live."),
    "Your app is built and the preview is live.");
  // Short real answers survive too — a two-letter reply is an answer, not an empty one
  // (caught in production: "OK" was being replaced by the fallback).
  assert.equal(sanitizeUserFacingText("OK"), "OK");
  assert.equal(sanitizeUserFacingText("Yes"), "Yes");
  // Long helpful prose survives; only unpunctuated machine blobs are replaced.
  const help = "I've paused here because your allowance is used up and there's no other provider connected. Everything so far is saved. Connect another provider in Settings, raise the limit, or wait for the reset and tell me when to continue.";
  assert.equal(sanitizeUserFacingText(help), help);
  assert.equal(sanitizeUserFacingText("x".repeat(400)), "Something needed attention on our side.");
  // Genuinely empty input still yields the calm fallback.
  assert.equal(sanitizeUserFacingText("   "), "Something needed attention on our side.");
});

test("classification separates safe retries from user-actionable and unexpected failures", () => {
  assert.equal(classifyFailure({ message: "duplicate key value violates unique constraint" }).retryable, true);
  assert.equal(classifyFailure({ status: 503, message: "upstream overloaded" }).retryable, true);
  assert.equal(classifyFailure({ status: 429, message: "rate limited" }).retryable, true);
  assert.equal(classifyFailure({ message: "Your monthly managed allowance is used up" }).kind, "needs_user");
  assert.equal(classifyFailure({ message: "Cannot read properties of undefined" }).retryable, false);
});

test("captureIncident stores the FULL private record and returns only safe user copy", async () => {
  const db = fakeDb();
  const error = new Error('duplicate key value violates unique constraint "ca_conversation_events_conversation_id_sequence_key"');
  error.code = "23505";
  error.stack = "Error: duplicate key\n    at appendEvent (/home/ubuntu/code-agent/shell/server/lib/conversationStore.mjs:305:11)";
  const incident = await captureIncident({
    error, owner: OWNER, conversationId: "c1", buildId: "b1", runId: "r1",
    service: "conversation_events", agent: "Lead Agent", model: "gpt-5.6-terra",
    logs: "sequence 41 taken", retryCount: 1, client: db,
  });

  // Private record: everything required by the directive.
  const stored = db.rows.diag_incidents[0];
  for (const field of ["message", "stack", "code", "service", "agent", "model", "conversation_id", "build_id", "run_id", "logs", "retry_count", "created_at", "reference"]) {
    assert.ok(stored[field] !== undefined && stored[field] !== null, `private record keeps ${field}`);
  }
  assert.match(stored.message, /duplicate key/, "raw message preserved privately");
  assert.match(stored.stack, /conversationStore\.mjs/, "stack preserved privately");

  // User-facing: calm, actionable, and technically empty.
  assert.equal(incident.friendly, FRIENDLY.saving);
  assert.doesNotMatch(incident.friendly, FORBIDDEN);
  assert.doesNotMatch(incident.unresolvedMessage, FORBIDDEN);
  assert.match(incident.reference, /^THR-[0-9A-F]{6}$/);
  assert.match(incident.unresolvedMessage, /Error reference: THR-[0-9A-F]{6}/);
  assert.match(incident.unresolvedMessage, /Your work is safe/);

  // Lead Agent briefing: the complete truth, explicitly marked private.
  assert.match(incident.privateBriefing, /PRIVATE FAILURE REPORT/);
  assert.match(incident.privateBriefing, /duplicate key/);
  assert.match(incident.privateBriefing, /conversationStore\.mjs/);
  assert.match(incident.privateBriefing, /never repeat any of this to the user/i);
  assert.equal(incident.classification.retryable, true);
});

test("references are stable and fingerprints ignore volatile ids and numbers", () => {
  assert.equal(referenceFrom("abc"), referenceFrom("abc"));
  assert.notEqual(referenceFrom("abc"), referenceFrom("abd"));
  const a = fingerprintIncident({ code: "23505", message: "sequence 41 taken for 8f3c1a2b-0000" }, "events");
  const b = fingerprintIncident({ code: "23505", message: "sequence 99 taken for 1122aabb-9999" }, "events");
  assert.equal(a, b, "same failure, different volatile values -> same fingerprint");
  assert.notEqual(a, fingerprintIncident({ code: "23505", message: "something else entirely" }, "events"));
});

test("advanced diagnostics are owner-scoped and reachable only by reference", async () => {
  const db = fakeDb();
  const mine = await captureIncident({ error: new Error("boom"), owner: OWNER, service: "build", client: db });
  await captureIncident({ error: new Error("theirs"), owner: OTHER, service: "build", client: db });
  assert.equal((await listIncidents(OWNER, { client: db })).length, 1);
  assert.equal((await listIncidents(OTHER, { client: db })).length, 1);
  assert.ok(await incidentByReference(OWNER, mine.reference, { client: db }));
  assert.equal(await incidentByReference(OTHER, mine.reference, { client: db }), null,
    "another user cannot read someone else's technical details by reference");
});

test("the event-sequence collision is recognised and retried, never surfaced", async () => {
  assert.equal(isSequenceCollision({ code: "23505" }), true);
  assert.equal(isSequenceCollision({ message: 'duplicate key value violates unique constraint "x"' }), true);
  assert.equal(isSequenceCollision({ code: "PGRST116" }), false);

  // The store retries with a fresh sequence and succeeds — one event, no duplicates.
  const inserted = [];
  let taken = 41;
  const client = {
    from: () => {
      const q = { op: null, patch: null };
      const chain = {
        select: () => chain,
        insert: (v) => { q.op = "insert"; q.patch = v; return chain; },
        eq: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        single: async () => {
          if (q.patch.sequence === taken) {
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "ca_conversation_events_conversation_id_sequence_key"' } };
          }
          inserted.push(q.patch);
          return { data: { ...q.patch, id: q.patch.sequence }, error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve) => resolve({ data: [{ sequence: taken - 1 }], error: null }),
      };
      return chain;
    },
  };
  const { SupabaseConversationStore } = await import("../../shell/server/lib/conversationStore.mjs");
  const store = new SupabaseConversationStore(client);
  // First attempt computes 41 (collision); the retry sees a moved cursor and lands.
  const original = store.nextSequence.bind(store);
  let calls = 0;
  store.nextSequence = async (...args) => { calls += 1; return calls === 1 ? 41 : 42; };
  void original;
  const event = await store.appendEvent({ id: "c1", owner: OWNER }, "message", { role: "lead", text: "hi" });
  assert.equal(event.sequence, 42, "recovered onto a free sequence");
  assert.equal(inserted.length, 1, "exactly one event written — no duplicates");
  taken = 0;
});

test("recoverable Lead Agent failures retry automatically and continue the original task", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, { title: "build a shop" });
  await store.appendTurn(conversation, { role: "user", content: "Build me a shop" });

  let attempt = 0;
  const modelFactory = async () => ({
    turn: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('duplicate key value violates unique constraint "ca_conversation_events_pkey"');
        error.code = "23505";
        throw error;
      }
      return { text: "Shop built.", output: [], usage: {} };
    },
  });
  await processConversation(conversation, {
    store, modelFactory,
    credentialResolver: async () => ({ provider: "managed", secret: null, routing: {} }),
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 10_000 } } }),
  });

  assert.equal(attempt, 2, "retried automatically — the user never typed 'try again'");
  const events = await store.listEvents(OWNER, conversation.id, 0);
  const texts = events.filter((e) => e.type === "message").map((e) => e.payload.text);
  const all = texts.join("\n");
  assert.doesNotMatch(all, FORBIDDEN, "no raw database error reached the conversation");
  assert.ok(texts.some((t) => t === FRIENDLY.saving), "calm recovery notice shown");
  assert.ok(texts.some((t) => t === FRIENDLY.recovered), "recovery success confirmed");
  assert.ok(texts.some((t) => /Shop built/.test(t)), "the ORIGINAL task completed");
  assert.equal(events.filter((e) => e.type === "lead_error").length, 0, "no failure card on a recovered run");
  assert.ok(events.some((e) => e.type === "recovery" && e.payload.state === "recovering"));
});

test("identical repeated failures stop at the bound with a safe support reference", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, { title: "t" });
  await store.appendTurn(conversation, { role: "user", content: "go" });

  let attempts = 0;
  const modelFactory = async () => ({
    turn: async () => {
      attempts += 1;
      const error = new Error("upstream overloaded");
      error.status = 503;
      throw error;
    },
  });
  await processConversation(conversation, {
    store, modelFactory,
    credentialResolver: async () => ({ provider: "managed", secret: null, routing: {} }),
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 10_000 } } }),
  });

  assert.ok(attempts <= MAX_RECOVERY_ATTEMPTS + 1, `bounded retries (${attempts})`);
  const events = await store.listEvents(OWNER, conversation.id, 0);
  const failure = events.find((e) => e.type === "lead_error");
  assert.ok(failure, "an honest failure is shown — never silently swallowed");
  assert.match(failure.payload.message, /Your work is safe/);
  assert.match(failure.payload.reference, /^THR-[0-9A-F]{6}$/);
  assert.doesNotMatch(JSON.stringify(events), /upstream overloaded|503/, "no provider detail in the conversation");
  const row = await store.getConversation(OWNER, conversation.id);
  assert.equal(row.state, "idle", "the conversation is left usable");
});

test("the UI reducer renders only sanitised failure copy and subtle recovery states", () => {
  let view = emptyConversationView();
  view = applyEvent(view, { sequence: 1, type: "recovery", payload: { state: "recovering", message: FRIENDLY.saving } });
  assert.equal(view.recovery.state, "recovering");
  view = applyEvent(view, {
    sequence: 2, type: "lead_error",
    payload: { message: "I couldn't resolve this automatically. Your work is safe and the technical details have been saved for support.\n\nError reference: THR-8F42C1", reference: "THR-8F42C1" },
  });
  const card = view.items.find((i) => i.kind === "failure");
  assert.ok(card, "renders a failure card, not a raw error line");
  assert.equal(card.reference, "THR-8F42C1");
  assert.doesNotMatch(card.text, FORBIDDEN);
  assert.equal(view.recovery, null, "recovery state clears when it fails");
  // Legacy raw payloads still never render technical text.
  const legacy = applyEvent(emptyConversationView(), {
    sequence: 1, type: "lead_error", payload: { error: 'duplicate key violates constraint "ca_x"' },
  });
  assert.doesNotMatch(legacy.items[0].text, FORBIDDEN, "old-shape events fall back to safe copy");
});
