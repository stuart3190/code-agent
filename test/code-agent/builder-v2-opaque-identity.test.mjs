// OPAQUE CONTROL IDENTITY, PROVEN IN A BROWSER.
//
// One compiled application, five presentations, one contract. Labels are renamed, translated,
// reduced to icons and reordered in the DOM; the controls have business names one token apart
// (guestName/guestCount, leadName/leadCount, orderCount/customerCount). If verification still
// depended on reading prose, every variant but the first would break and the near-collisions
// would swap. Targeting by opaque machine identity makes all of that irrelevant.
//
// The fifth variant strips the identity out entirely: the platform must then SAY it could not find
// the control, with the locators it tried, rather than guessing from business text.

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
import { opaqueIdentityApp, IDENTITY_CONTRACT } from "./fixtures/opaqueIdentityApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(IDENTITY_CONTRACT);
const CASE = "bv2-opaque-identity";
const PRESENTATIONS = ["plain", "renamed", "translated", "reordered", "stripped"];

let built = null;
const runs = new Map();

async function drive(presentation) {
  const root = path.join(workDirFor(CASE), "dist");
  const inject = (html) => html.replace("</head>",
    `<script>window.__PRESENTATION__=${JSON.stringify(presentation)}</script></head>`);
  const server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    const asset = /\.(js|css|svg|png|ico)$/.test(file);
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html" });
      response.end(asset ? body : inject(body.toString("utf8")));
    } catch {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(inject((await readFile(path.join(root, "index.html"))).toString("utf8")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: SPEC.contract, timeoutMs: 600_000,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...opaqueIdentityApp() }, CASE, () => {});
  if (!built.ok) return;
  for (const presentation of PRESENTATIONS) runs.set(presentation, await drive(presentation));
}, { timeout: 1_800_000 });

after(() => {
  for (const [presentation, run] of runs) {
    const journey = run.journeys[0];
    console.log(`\n### ${presentation} => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) {
      console.log(`  ${index + 1} ${String(step.status).toUpperCase().padEnd(12)} ${(step.detail || "").slice(0, 80)}`);
    }
  }
});

const journeyOf = (presentation) => runs.get(presentation).journeys.find((row) => row.id === "identity");
const fieldsOf = (presentation, stepIndex) =>
  journeyOf(presentation).steps[stepIndex].controlEvidence?.fields || [];

test("the identity fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("renaming, translating, reordering and icon-only labels change nothing", { ...needsBrowser }, () => {
  for (const presentation of ["plain", "renamed", "translated", "reordered"]) {
    assert.equal(journeyOf(presentation).status, "pass",
      `${presentation}: ${JSON.stringify(journeyOf(presentation).steps)}`);
  }
});

test("every contracted field drove the control bearing its own identity", { ...needsBrowser }, () => {
  // The strongest available statement: the element actually typed into carried the machine id the
  // contract derived, in every presentation, including the one with the DOM reversed.
  for (const presentation of ["plain", "renamed", "translated", "reordered"]) {
    for (const stepIndex of [2]) {
      for (const row of fieldsOf(presentation, stepIndex)) {
        if (row.status !== "filled") continue;
        assert.equal(row.facts?.name, row.field,
          `${presentation}: ${row.field} drove ${row.facts?.name} (${row.matchedBy})`);
        assert.match(String(row.matchedBy || ""), /^machine=ctl_/,
          `${presentation}: ${row.field} was found by prose, not identity: ${row.matchedBy}`);
      }
    }
  }
});

test("near-collisions are decided by identity, not by one token of business vocabulary", { ...needsBrowser }, () => {
  // guestName vs guestCount, leadName vs leadCount, orderCount vs customerCount.
  assert.notEqual(controlIdFor("guestName"), controlIdFor("guestCount"));
  assert.notEqual(controlIdFor("leadName"), controlIdFor("leadCount"));
  assert.notEqual(controlIdFor("orderCount"), controlIdFor("customerCount"));
  for (const presentation of PRESENTATIONS.filter((row) => row !== "stripped")) {
    const driven = [2].flatMap((stepIndex) => fieldsOf(presentation, stepIndex))
      .filter((row) => row.status === "filled");
    const pairs = driven.map((row) => `${row.field}->${row.facts?.name}`);
    for (const pair of pairs) {
      const [contracted, actual] = pair.split("->");
      assert.equal(contracted, actual, `${presentation}: cross-matched ${pair}`);
    }
  }
});

test("a control with no machine identity is REPORTED, never guessed", { ...needsBrowser }, () => {
  // Same application, identity attributes removed, labels meaningless. The honest outcome is that
  // the contracted control could not be found — with the locators that were tried — rather than a
  // confident write into whichever box happened to be nearby.
  const journey = journeyOf("stripped");
  assert.notEqual(journey.status, "pass", JSON.stringify(journey.steps));
  const step = journey.steps.find((row) => row.status === "undriveable");
  assert.ok(step, `an undriveable step is reported: ${JSON.stringify(journey.steps)}`);
  assert.match(String(step.detail || ""), /could not be driven: \w+:missing/,
    `the report must name the field and the status: ${step.detail}`);
  const attempted = (step.controlEvidence?.attemptedLocators || []).join(" ");
  assert.match(attempted, /machine=ctl_/, "the machine identity was tried and reported");
  // And nothing was written into an unrelated control.
  for (const row of step.controlEvidence?.fields || []) {
    assert.notEqual(row.status, "filled", `wrote into ${row.facts?.name} without identity`);
  }
});
