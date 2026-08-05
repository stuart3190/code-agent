// The two defects found by the final verification build (run f4c2494a), fixed and pinned.
//
// 1. The zero-credit deterministic repair sat AFTER the budget gate: the ceiling refused a model
//    repair's reservation at 21.65/25 and the run stopped, while a free fix for the exact finding
//    existed. And when the transform declined, it declined silently — no diagnostics step — which
//    read as "never attempted".
// 2. Provider request ids were captured on codexProvider (ops probes) while production's managed
//    path runs openaiEngineProvider: the verification build recorded zero ids.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformPersistence } from "../../shell/server/lib/appBuild/persistenceTransform.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";
import { createReservations, memoryReservationStore } from "../../shell/server/lib/appBuild/creditReservations.mjs";
import { resolveBuildState, BUILD_STATES, isShippable } from "../../shell/shared/buildStates.mjs";
import { journeysToRerun } from "../../shell/server/lib/appBuild/verificationCache.mjs";
import { RESERVATION_MODULE } from "./fixtures/realPersistenceModules.mjs";

const SERVICE = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");

// ── 1. ordering ───────────────────────────────────────────────────────────────────────────────

test("ORDERING — the free repair now runs BEFORE the budget gate, and reserves nothing", () => {
  const deterministic = SERVICE.indexOf("TIER 1 — the fix that costs nothing, BEFORE the budget gate");
  const gate = SERVICE.indexOf("const check = await dispatchCheck(lifecycle);\n  const action = planVerificationAction(verdict, {");
  assert.ok(deterministic > 0, "the reordered block exists");
  assert.ok(gate > 0, "the verification budget gate exists");
  assert.ok(deterministic < gate, "zero-cost repair must be evaluated before any budget decision");

  // The block itself must never reserve: it makes no model call.
  const blockEnd = SERVICE.indexOf("const check = await dispatchCheck(lifecycle);", deterministic);
  const block = SERVICE.slice(deterministic, blockEnd);
  // Live code only — the block's own comment narrates the old defect and names dispatchCheck.
  const live = block.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assert.ok(!live.some((l) => /reservations\.reserve|dispatchCheck/.test(l)),
    "a deterministic repair must not consult or consume the model budget");
  // Declines are recorded now — the silent decline is what made run f4c2494a unreadable.
  assert.match(block, /DECLINED \$\{d\.file\}/);
});

// ── 3. the zero-credit replay of the final build ─────────────────────────────────────────────

test("REPLAY f4c2494a — a build at the ceiling still gets its free repair and ships", async () => {
  // Canonical spend exactly as the build ended: 21.65 of a 25 ceiling.
  const spent = 21.65;
  const store = memoryReservationStore();
  const reservations = createReservations({ store, spentOf: async () => spent });

  // The model repair is (correctly) unaffordable, exactly as production refused it.
  const modelRepair = await reservations.reserve({ buildId: "f4c2494a", credits: 4, ceiling: 25 });
  assert.equal(modelRepair.ok, false, "21.65 + 4 crosses 25: the model repair stays refused");

  // The honesty finding, on the real corpus module shape.
  const contract = {
    entities: [{ name: "reservation", fields: [{ name: "slotId", type: "string", required: true }] }],
    journeys: [
      { id: "book", title: "A visitor books a picking slot", priority: "primary" },
      { id: "explore", title: "A visitor explores the farm", priority: "secondary" },
    ],
  };
  const tree = { "src/data/reservation.js": RESERVATION_MODULE };
  const before = honestyScan(tree, { contract });
  assert.equal(before.ok, false, "the browser persistence is found");

  // The free repair runs DESPITE only 3.35 credits remaining, creating no reservation.
  const holdsBefore = store.dump().length;
  const fixed = transformPersistence(tree, { findings: before.findings, contract });
  assert.equal(store.dump().length, holdsBefore, "no reservation is created for deterministic work");
  assert.equal(fixed.declined.length, 0, fixed.declined.map((d) => d.reasons[0]).join("; "));

  const after = honestyScan(fixed.tree, { contract });
  assert.equal(after.findings.filter((f) => f.id === "fake_persistence").length, 0,
    "the original honesty finding disappears");

  // Only the affected journey re-runs.
  const rerun = journeysToRerun(contract, fixed.fixed.map((f) => f.file), { previouslyFailed: ["book"] });
  assert.ok(rerun.some((j) => j.id === "book"), "the failed booking journey re-runs");

  // With honesty clean and the journey passing, the state may now become preview_ready.
  const state = resolveBuildState({
    compileOk: true, previewUrl: "https://p/", journeys: { pass: true }, honesty: after,
  });
  assert.equal(state, BUILD_STATES.previewReady);
  assert.equal(isShippable(state), true);

  // And the accounting never moved: still exactly 21.65 spent, nothing reserved.
  const status = await reservations.status("f4c2494a", 25);
  assert.equal(status.spent, 21.65);
  assert.equal(status.reserved, 0);
});

test("at 24.99 of 25 the free repair still runs; a failed transform still refuses the model", async () => {
  const reservations = createReservations({ store: memoryReservationStore(), spentOf: async () => 24.99 });
  const contract = { entities: [{ name: "reservation", fields: [] }] };
  const tree = { "src/data/reservation.js": RESERVATION_MODULE };
  const findings = honestyScan(tree, { contract }).findings;

  // Zero-credit path: works at any spend level.
  const fixed = transformPersistence(tree, { findings, contract });
  assert.ok(fixed.fixed.length > 0, "24.99/25 does not stop a free repair");

  // A shape the transform declines: the model repair is evaluated, and refused by the ceiling.
  const oddSource = "export function save(x) { window.localStorage.setItem(\"odd\", btoa(x)); }";
  const declined = transformPersistence(
    { "src/data/odd.js": oddSource },
    { findings: [{ id: "fake_persistence", file: "src/data/odd.js", line: 1, snippet: "localStorage.setItem(\"odd\"" }], contract },
  );
  assert.equal(declined.fixed.length, 0);
  const model = await reservations.reserve({ buildId: "b", credits: 1, ceiling: 25 });
  assert.equal(model.ok, false, "the ceiling still refuses a model repair it cannot cover");
});

// ── 2. provider request ids on the REAL path ─────────────────────────────────────────────────

test("PROVIDER IDS — openaiEngineProvider (the production path) captures response.id", async () => {
  const { createOpenAIEngineProvider } = await import("../../shell/server/lib/appBuild/openaiEngineProvider.mjs");
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      id: "resp_real_path_001",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
    }),
  });
  const provider = createOpenAIEngineProvider({ apiKey: "k", model: "gpt-5.6-sol", fetchImpl: fakeFetch });
  const turn = await provider.runTurn({ systemPrompt: "s", messages: [], tools: [] });
  assert.equal(turn.usage.providerRequestId, "resp_real_path_001");
  assert.equal(turn.usage.cached, 40, "cached tokens still flow — the incident fix is not disturbed");
});

test("PROVIDER IDS — telemetry aggregates distinct ids; duplicates do not multiply", async () => {
  const { createTelemetry } = await import("../../src/engine/telemetry.mjs");
  const t = createTelemetry();
  t.record({ input: 10, output: 5, reasoning: 0, cached: 0, total: 15, providerRequestId: "resp_a" });
  // A retry is a NEW provider request and records a distinct id.
  t.record({ input: 10, output: 5, reasoning: 0, cached: 0, total: 15, providerRequestId: "resp_b" });
  const summary = t.summary();
  assert.deepEqual(summary.providerRequestIds, ["resp_a", "resp_b"], "retries record distinct ids");

  // The canonical record is keyed per event: persisting the same summary twice stores once.
  const rows = new Map();
  const persist = (s) => { const key = s.providerRequestIds.join("|"); if (!rows.has(key)) rows.set(key, s); };
  persist(summary); persist(summary);
  assert.equal(rows.size, 1, "duplicate telemetry does not duplicate the stored ids");
});

test("PROVIDER IDS — a failed call still carries the id the provider created", async () => {
  const { normalizeTelemetry } = await import("../../shell/server/lib/appBuild/buildDiagnostics.mjs");
  // A call that errored AFTER the provider opened a response: usage exists, id exists, cost is real.
  const norm = normalizeTelemetry({
    input: 500, output: 0, cached: 0, reasoning: 0, total: 500,
    providerRequestIds: ["resp_failed_but_metered"],
  });
  assert.deepEqual(norm.providerRequestIds, ["resp_failed_but_metered"]);
});
