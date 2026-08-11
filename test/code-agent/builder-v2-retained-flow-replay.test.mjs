// Drive the WHOLE retained contract, offline, to find blockers before another paid run.
//
// The 2026-08-10T22:20Z qualification stopped at step 3 of its primary journey. Seven contracted
// steps and four entire secondary journeys have therefore never been exercised by any verifier
// version. Each one is a place a paid run can die one step at a time.
//
// This drives all five retained journeys through the real verifyJourneys against real Chromium.
// It is a REPLAY OF THE CONTRACT, not of the model's code: the generated source is not retained
// (working snapshots erased by cleanup, bv2_patches stores paths only), and persistence here is
// sessionStorage rather than the durable backend. What it can prove is whether the platform can
// drive these journeys at all; it cannot prove durable persistence.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { fullBookingFlowApp } from "./fixtures/fullBookingFlowApp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const RUN5 = JSON.parse(await readFile(
  path.join(HERE, "fixtures", "live-booking-2026-08-10T2220Z-run5.json"), "utf8"));
// Re-derived with the CURRENT production derivation: the retained row embeds the interaction
// contract as it was on the day, and this harness exists to test what derivation does now.
const CONTRACT = deriveBuildSpec({ ...RUN5.contract, interactionContract: undefined }).contract;
const CASE = "bv2-retained-flow-replay";

let server = null;
let baseUrl = "";
let built = null;
let result = null;

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
      // Client-side routing, exactly as the real preview serves it.
      try {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(await readFile(path.join(root, "index.html")));
      } catch { response.writeHead(404); response.end("not found"); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 600_000 });
}, { timeout: 1_800_000 });

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

test("the whole-contract fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("REPLAY — every retained journey, every contracted step", { ...needsBrowser, timeout: 1_200_000 }, () => {
  const lines = [];
  for (const journey of result.journeys) {
    lines.push(`\n### ${journey.id} [${journey.priority}] => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) {
      lines.push(`  ${String(index + 1).padStart(2)} ${String(step.status).toUpperCase().padEnd(12)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n").slice(0, 120)}`);
    }
  }
  console.log(lines.join("\n"));
  console.log(`\nconsoleErrors: ${JSON.stringify(result.consoleErrors)}`);
  console.log(`failedRequests: ${JSON.stringify(result.failedRequests)}`);

  // The primary journey is the one the paid run could not get past step 3 of.
  const primary = result.journeys.find((j) => j.priority === "primary");
  const statuses = primary.steps.map((s) => s.status);
  assert.equal(statuses[2], "pass", `the auto-advancing date step must pass:\n${lines.join("\n")}`);
  assert.equal(statuses.filter((s) => s === "pass").length >= 8, true,
    `the primary journey must now be driveable end to end:\n${lines.join("\n")}`);
});

test("REPLAY — the secondary journeys the paid run never reached", { ...needsBrowser, timeout: 60_000 }, () => {
  const byId = new Map(result.journeys.map((j) => [j.id, j]));
  for (const id of ["recover-existing-booking", "cancel-booking", "capacity-protection", "contact-validation"]) {
    const journey = byId.get(id);
    assert.ok(journey, `${id} must have been driven`);
    assert.notEqual(journey.status, "skipped", `${id} must not be skipped`);
  }
});
