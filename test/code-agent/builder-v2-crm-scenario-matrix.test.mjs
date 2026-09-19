// THE CRM MATRIX — the third domain, and the first whose lifecycle contains a real EDIT.
//
// Booking ends at cancellation; checkout ends at cancellation. A CRM re-opens the record it
// created and rewrites the record's own declared fields before archiving it, which is generic
// case H running in a browser rather than asserted in a derivation test: the update journey
// references an existing lead AND supplies substantive edited values, and must still be driven as
// a CONSUMER of a lead something else produced.
//
// Real path throughout: authored contract → deriveBuildSpec → interaction/scenario derivation →
// journeyVerifier's public entry point → compiled React/Vite → real Chromium. No hand-picked
// locators, no simplified stand-in for the verifier, and no CRM-specific branch anywhere in the
// production code this exercises.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { crmScenarioApp, CRM_CONTRACT } from "./fixtures/crmScenarioApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(CRM_CONTRACT);
const CONTRACT = SPEC.contract;
const CASE = "bv2-crm-scenario-matrix";

let server = null;
let built = null;
let result = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...crmScenarioApp() }, CASE, () => {});
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
      try {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(await readFile(path.join(root, "index.html")));
      } catch { response.writeHead(404); response.end("not found"); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await verifyJourneys({
    previewUrl: `http://127.0.0.1:${server.address().port}`, contract: CONTRACT, timeoutMs: 600_000,
  });
}, { timeout: 1_800_000 });

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

test("the CRM fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("derivation classifies the lead lifecycle from its declared operations", () => {
  assert.equal(SPEC.verdict.ok, true, JSON.stringify(SPEC.verdict.problems));
  const scenarios = SPEC.interactionContract.scenarios;
  assert.equal(scenarios["capture-new-lead"].role, "produces");
  assert.equal(scenarios["recover-existing-lead"].role, "consumes");
  // Generic case H, in a real application: an existing record, substantively edited, then updated.
  assert.equal(scenarios["update-existing-lead"].role, "consumes");
  assert.equal(scenarios["archive-existing-lead"].role, "consumes");
  assert.equal(scenarios["contact-validation"].role, "independent");
  assert.equal(scenarios["update-existing-lead"].startState, "inherits");
  assert.equal(scenarios["contact-validation"].startState, "fresh");

  // One lifecycle identity for the whole record, and it is neither a booking nor an order.
  const lifecycles = new Set(SPEC.interactionContract.flows
    .filter((flow) => flow.durableLifecycle).map((flow) => flow.durableLifecycle));
  assert.equal(lifecycles.size, 1, `one durable lifecycle, got ${[...lifecycles]}`);
  assert.equal([...lifecycles][0], "crud:lead");
});

test("the update journey really does supply the record's own declared fields", () => {
  // Without this the CRM would prove nothing about case H: an update that supplied no record
  // contents is trivially a consumer, and the interesting shape is the one that looks like a
  // creation.
  const declared = new Set(CRM_CONTRACT.entities[0].fields.map((field) => field.name));
  const commit = SPEC.interactionContract.flows
    .find((flow) => flow.journeyId === "update-existing-lead" && flow.kind === "mutation");
  assert.ok(commit, "the update journey derives a durable commit");
  const supplied = (commit.reads || []).map((path) => path.split(".draft.")[1])
    .filter((field) => field && declared.has(field) && !/^(reference|status)$/.test(field));
  assert.ok(supplied.length >= 2, `substantive edited fields, got ${JSON.stringify(commit.reads)}`);
});

const line = (step) => `${String(step.status).toUpperCase().padEnd(12)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n").slice(0, 110)}`;
const journeyOf = (id) => result.journeys.find((journey) => journey.id === id);

test("CRM MATRIX — every contracted journey", { ...needsBrowser, timeout: 1_200_000 }, () => {
  const lines = [];
  for (const journey of result.journeys) {
    lines.push(`\n### ${journey.id} [${journey.priority}] => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) lines.push(`  ${index + 1} ${line(step)}`);
  }
  console.log(lines.join("\n"));
  console.log(`\nconsoleErrors: ${JSON.stringify(result.consoleErrors)}`);

  const transcript = lines.join("\n");
  // create → durable reference → recover → UPDATE → archive → recover the archived state.
  assert.equal(journeyOf("capture-new-lead").status, "pass", transcript);
  assert.equal(journeyOf("recover-existing-lead").status, "pass", transcript);
  assert.equal(journeyOf("update-existing-lead").status, "pass", transcript);
  assert.equal(journeyOf("archive-existing-lead").status, "pass", transcript);
  // Independent validation: invalid rejected, progression blocked, valid correction recovers.
  assert.equal(journeyOf("contact-validation").status, "pass", transcript);
});

test("the update is judged on the durable record, not on the words the page uses", { ...needsBrowser }, () => {
  const reload = journeyOf("update-existing-lead").steps.at(-1);
  assert.equal(reload.status, "pass");
  assert.match(reload.detail, /same durable state after recovery/,
    "an edited record must be proved recovered by its durable state");
});

test("the independent validation scenario did not inherit the archived lead", { ...needsBrowser }, () => {
  const validation = journeyOf("contact-validation");
  // It runs AFTER the lead was created, edited and archived. Had it inherited that state there
  // would be no capture flow to advance and its first step could not have passed.
  assert.equal(validation.steps[0].status, "pass", JSON.stringify(validation.steps[0]));
  const invalid = validation.steps[1];
  assert.equal(invalid.status, "pass", JSON.stringify(invalid));
  assert.match(String(invalid.controlEvidence?.blockedProgression || ""), /disabled|stayed on this step/,
    "an invalid value must be proved to block progression, not merely to complain");
});
