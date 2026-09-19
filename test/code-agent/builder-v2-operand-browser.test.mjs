// THE PAID FAILURE, DRIVEN.
//
// date → slot → party size, against the retained booking application, with the step that killed
// the 2026-08-12 qualification written exactly as the model wrote it:
//
//   "select a party size that does not exceed the slot's remaining capacity"
//
// Structured operands make the prose irrelevant: the step operates partySize and reads slotId, so
// the browser is asked for one control and never told to re-open the slot picker that the previous
// step consumed and unmounted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { fullBookingFlowApp } from "./fixtures/fullBookingFlowApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// The retained fixture's own field names, with the paid contract's step prose and structured
// operands. Only the first five steps: the defect was at step 5 and everything after it was
// never reached.
const CONTRACT = {
  summary: "Ember Table supper club booking", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "dateId", type: "string" }, { name: "slotId", type: "string" },
    { name: "slotLabel", type: "string" }, { name: "partySize", type: "number" },
    { name: "guestName", type: "string" }, { name: "guestEmail", type: "string" },
    { name: "guestPhone", type: "string" }] }],
  operations: [],
  journeys: [{ id: "complete-booking-lifecycle", title: "A guest books a supper club seat",
    priority: "primary", steps: [
      { action: "open the booking application", target: "/",
        expect: "the Ember Table supper club hero and the available dates are shown" },
      { action: "start the booking flow", target: "start booking control",
        expect: "the current wizard step indicator and the available dates are shown" },
      { action: "select a date with availability", target: "date selection step", operates: ["dateId"],
        expect: "timed slots for that date become visible" },
      { action: "select an available slot", target: "slot selection cards", operates: ["slotId"],
        reads: ["dateId"], expect: "the slot card displays its remaining capacity" },
      // THE STEP. Same words that failed live; the operands are what changed.
      { action: "select a party size that does not exceed the slot's remaining capacity",
        target: "party size control", operates: ["partySize"], reads: ["slotId"],
        expect: "the selected party size is displayed for this slot" },
    ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};

const SPEC = deriveBuildSpec(CONTRACT);
const CASE = "bv2-operand-browser";
let built = null;
let result = null;
let server = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...fullBookingFlowApp() }, CASE, () => {});
  if (!built.ok) return;
  const root = path.join(workDirFor(CASE), "dist");
  server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html" });
      response.end(body);
    } catch {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(await readFile(path.join(root, "index.html")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await verifyJourneys({
    previewUrl: `http://127.0.0.1:${server.address().port}`, contract: SPEC.contract, timeoutMs: 600_000,
  });
}, { timeout: 1_800_000 });

after(async () => {
  if (result) {
    const journey = result.journeys[0];
    console.log(`\n### ${journey.id} => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) {
      console.log(`  ${index + 1} ${String(step.status).toUpperCase().padEnd(12)} ${(step.detail || "").slice(0, 92)}`);
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("the booking fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("date → slot → party size all drive", { ...needsBrowser }, () => {
  const journey = result.journeys[0];
  assert.equal(journey.status, "pass", JSON.stringify(journey.steps));
});

test("the party-size step never attempts the slot control", { ...needsBrowser }, () => {
  // The live failure was `no selectable control group matched contracted field slotId` on this
  // step. The contract no longer asks for it, so the browser never looks for it.
  const partyStep = result.journeys[0].steps[4];
  assert.equal(partyStep.status, "pass", JSON.stringify(partyStep));
  const evidence = JSON.stringify(partyStep.controlEvidence || {});
  assert.equal(evidence.includes(controlIdFor("slotId")), false,
    `the slot identity appears in the party-size step's evidence: ${evidence.slice(0, 240)}`);
  assert.equal(/slotId/.test(partyStep.detail || ""), false, partyStep.detail);
  // …and the slot step itself still drove the slot.
  assert.equal(result.journeys[0].steps[3].status, "pass");
});
