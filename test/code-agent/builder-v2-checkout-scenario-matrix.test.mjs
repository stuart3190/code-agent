// PHASE 1 — the scenario architecture on a NON-BOOKING lifecycle.
//
// Everything proved on the retained booking contract has to hold for an order: scenario
// classification, journey prerequisites, durable lifecycle keying, cross-journey recovery,
// flow_start/flow_advance, validity intent and blocked progression. If any of it needed booking
// vocabulary or makeBookingSystem, it would show up here as a red row.
//
// Real path throughout: authored contract → deriveBuildSpec → interaction/scenario derivation →
// journeyVerifier's public entry point → compiled React/Vite → real Chromium. No hand-picked
// locators, no simplified stand-in for the verifier.

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
import { checkoutScenarioApp, CHECKOUT_CONTRACT } from "./fixtures/checkoutScenarioApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(CHECKOUT_CONTRACT);
const CONTRACT = SPEC.contract;
const CASE = "bv2-checkout-scenario-matrix";

let server = null;
let built = null;
let result = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...checkoutScenarioApp() }, CASE, () => {});
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

test("the checkout fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("derivation classifies the order lifecycle without booking vocabulary", () => {
  assert.equal(SPEC.verdict.ok, true, JSON.stringify(SPEC.verdict.problems));
  const scenarios = SPEC.interactionContract.scenarios;
  assert.equal(scenarios["place-order"].role, "produces");
  assert.equal(scenarios["recover-existing-order"].role, "consumes");
  assert.equal(scenarios["cancel-order"].role, "consumes");
  assert.equal(scenarios["buyer-validation"].role, "independent");
  // One lifecycle identity shared by producer and consumers — never per-step capability.
  const lifecycles = new Set(SPEC.interactionContract.flows
    .filter((flow) => flow.durableLifecycle).map((flow) => flow.durableLifecycle));
  assert.equal(lifecycles.size, 1, `one durable lifecycle, got ${[...lifecycles]}`);
  assert.equal([...lifecycles][0].includes("booking"), false, "no booking capability in an order contract");

  const kinds = SPEC.interactionContract.flows.map((flow) => `${flow.journeyId}:${flow.stepIndex}:${flow.kind}`);
  assert.ok(kinds.includes("place-order:1:flow_start"), `flow_start derived: ${kinds.join(" ")}`);
  assert.ok(kinds.includes("buyer-validation:0:flow_advance"), `flow_advance derived: ${kinds.join(" ")}`);
  const invalid = SPEC.interactionContract.flows.find((flow) => flow.control?.validity === "invalid");
  assert.equal(invalid?.control.logicalField, "buyerEmail", "the invalid-input intent is on the email field");
});

const line = (step) => `${String(step.status).toUpperCase().padEnd(12)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n").slice(0, 110)}`;
const journeyOf = (id) => result.journeys.find((journey) => journey.id === id);

test("CHECKOUT MATRIX — every contracted journey", { ...needsBrowser, timeout: 1_200_000 }, () => {
  const lines = [];
  for (const journey of result.journeys) {
    lines.push(`\n### ${journey.id} [${journey.priority}] => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) lines.push(`  ${index + 1} ${line(step)}`);
  }
  console.log(lines.join("\n"));
  console.log(`\nconsoleErrors: ${JSON.stringify(result.consoleErrors)}`);

  const transcript = lines.join("\n");
  // Lifecycle: create → confirmation/reference → recover → cancel → cancelled-state recovery.
  assert.equal(journeyOf("place-order").status, "pass", transcript);
  assert.equal(journeyOf("recover-existing-order").status, "pass", transcript);
  assert.equal(journeyOf("cancel-order").status, "pass", transcript);
  // Independent validation: invalid rejected, progression blocked, valid correction recovers.
  assert.equal(journeyOf("buyer-validation").status, "pass", transcript);
});

test("the confirmed order is recovered by durable state, not by copy", { ...needsBrowser }, () => {
  const reload = journeyOf("place-order").steps.at(-1);
  assert.equal(reload.status, "pass");
  assert.match(reload.detail, /same durable state after recovery/,
    "recovery must be judged on the record, not on the words the page uses");
});

test("the independent validation scenario did not inherit terminal order state", { ...needsBrowser }, () => {
  const validation = journeyOf("buyer-validation");
  // It runs AFTER the order was confirmed and cancelled. If it had inherited that browser state
  // there would be no wizard to advance and its first step could not have passed.
  assert.equal(validation.steps[0].status, "pass", JSON.stringify(validation.steps[0]));
  assert.match(validation.steps[0].detail, /the flow advanced to the contracted next state/);
  const invalid = validation.steps[1];
  assert.equal(invalid.status, "pass", JSON.stringify(invalid));
  assert.match(String(invalid.controlEvidence?.blockedProgression || ""), /disabled|stayed on this step/,
    "an invalid value must be proved to block progression, not merely to complain");
});
