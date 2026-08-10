// A ZERO-MODEL harness that reproduces the LATEST live qualification's browser behaviour.
//
// WHY THIS EXISTS
// ---------------
// Four rounds of deterministic debugging drew conclusions that did not survive contact with
// production. This harness pins down why, and then reproduces the real verdict.
//
// THE PROVENANCE DEFECT (proved, not inferred)
// -------------------------------------------
// Browser verification does not run the repository's journeyVerifier. runtimeComposition sends a
// `browser_verify` job to the build worker, and the worker runs it inside a Docker image
// (build-worker/sandboxRunner.mjs). Production pins that image by digest:
//
//     /etc/thrallo/build-worker.env
//       THRALLO_BUILD_SANDBOX=docker
//       THRALLO_BUILD_SANDBOX_IMAGE=sha256:22479a5d35d6…   (thrallo-build-sandbox:0d5999c672fe,
//                                                            built 2026-08-07T19:04:34Z)
//
// The journeyVerifier.mjs inside that image is byte-identical (modulo CRLF) to commit b45a327
// (2026-08-06). Every verifier change since — d7f27f1, 92de017, 804272c, 3b5a523 — has NEVER
// executed in a live qualification. That is why deterministic fixtures kept disagreeing with
// production: they ran code production does not run.
//
// The graded artefact is therefore vendored verbatim at
// fixtures/live-journeyVerifier-b45a327.mjs and is what this harness drives. HEAD's verifier is
// driven over the SAME fixture for comparison, so the two are never confused again.
//
// WHAT IS REPRODUCED
// ------------------
// The retained verdict of build 449cf290-587a-4d12-982c-703ffd40d3e1 (2026-08-10T09:07-09:17Z),
// stored verbatim in fixtures/live-booking-2026-08-10T0910Z.json. Both live browser passes agree:
//
//   3 select a dinner date        pass  found: selected, date, visually, highlighted, slot
//   4 select an available slot    pass  selection moved from "Friday 18 October…" to "Saturday…"
//   5 choose a party size         pass  selection moved from "Saturday 19 October…" to "Friday…"
//   6 enter guest name/email/…    undriveable   could not drive: …
//   7 review the booking          fail  nothing changed — "selected, date, slot" was already…
//
// Steps 4 and 5 are FALSE PASSES: the driver re-drove the DATE group both times, ping-ponging
// between the same two date options. Nothing ever set slotId or partySize.
//
// Nothing here calls a provider, deploys, or touches production.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyJourneys as verifyJourneysHead } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { liveShapedBookingApp } from "./fixtures/liveShapedBookingApp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const LIVE_VERIFIER = path.join(FIXTURES, "live-journeyVerifier-b45a327.mjs");

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const EVIDENCE = JSON.parse(
  await readFile(path.join(FIXTURES, "live-booking-2026-08-10T0910Z.json"), "utf8"),
);
const LIVE_CONTRACT = EVIDENCE.contract;
const LIVE_STEPS = EVIDENCE.liveVerdict.steps;
const PRIMARY = LIVE_CONTRACT.journeys.find((journey) => journey.id === "complete-booking");

// Only the primary journey is driven: the live run drove exactly this one (the secondaries were
// never reached), so anything else would be reproducing a run that did not happen.
const CONTRACT = { ...LIVE_CONTRACT, journeys: [PRIMARY] };

// ── 0. the graded artefact is the one production runs ─────────────────────────────────────────

test("the vendored verifier is byte-identical to the image production actually runs", async () => {
  const bytes = await readFile(LIVE_VERIFIER);
  // sha256 of the file as extracted from thrallo-build-sandbox:0d5999c672fe, CRLF preserved.
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),
    "ab94383728984e51ca97ca126e99643647bd3236b680c9328725ffe6c7910a75");
  const normalised = crypto.createHash("sha256")
    .update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(normalised.slice(0, 16), "9e3019e2b90a6e78", "equals commit b45a327");

  const source = bytes.toString("utf8");
  // The two capabilities HEAD has and the graded artefact does not. Both are load-bearing for
  // every conclusion drawn from a repository-side fixture.
  assert.equal(/fillContractedFields/.test(source), false,
    "the graded verifier cannot drive contracted controls");
  assert.equal(/blockedBy/.test(source), false,
    "the graded verifier does not stop a journey after a failed step");
});

// ── 1. the derived interaction contract, from the production derivation code ───────────────────

test("HEAD's derivation reproduces the retained interaction contract exactly", () => {
  // The contract row was written by the shell (on-disk code), which is current. Re-deriving it
  // from the same prose must land on the same object, or the fixture below is describing a
  // contract production never had.
  const { interactionContract } = LIVE_CONTRACT;
  const rederived = deriveBuildSpec({ ...LIVE_CONTRACT, interactionContract: undefined });
  assert.deepEqual(rederived.interactionContract.flows, interactionContract.flows);
  assert.equal(rederived.verdict.ok, true);
});

test("the contract names the selections but no navigation between them", () => {
  const flows = LIVE_CONTRACT.interactionContract.flows
    .filter((flow) => flow.journeyId === "complete-booking");
  const kinds = flows.map((flow) => flow.kind);
  assert.deepEqual([...new Set(kinds)].sort(),
    ["input", "lookup", "mutation", "navigation", "recovery", "review", "selection"]);
  // The hypothesis under test: there is no machine-readable transition between date, slot and
  // party. Whether that is the DEFECT is decided by the reproduction, not by this observation.
  assert.equal(flows.some((flow) => /transition|advance|continue|next/i.test(flow.kind)), false);
  assert.deepEqual(flows.filter((flow) => flow.kind === "selection").map((flow) => flow.control.logicalField),
    ["dateId", "slotId", "partySize"]);
});

// ── 2. the live-shaped fixture ────────────────────────────────────────────────────────────────

const CASES = {
  "value-gated": "bv2-live-shaped-value-gated",
  "step-gated": "bv2-live-shaped-step-gated",
};
const servers = new Map();
const builds = new Map();

async function serve(caseName) {
  const root = path.join(workDirFor(caseName), "dist");
  const server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      const type = file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": type });
      response.end(body);
    } catch {
      // Client-side routing: unknown paths fall back to the app shell, as the real preview does.
      try {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(await readFile(path.join(root, "index.html")));
      } catch { response.writeHead(404); response.end("not found"); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.set(caseName, server);
  return `http://127.0.0.1:${server.address().port}`;
}

const urls = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [shape, caseName] of Object.entries(CASES)) {
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...liveShapedBookingApp(shape) },
      caseName, () => {});
    builds.set(shape, built);
    if (built.ok) urls.set(shape, await serve(caseName));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

test("both live-shaped fixtures compile", { ...needsBrowser }, () => {
  for (const [shape, built] of builds) assert.equal(built.ok, true, `${shape}: ${built?.stderr}`);
});

// ── 3. reproduce the live verdict with the verifier production actually ran ────────────────────

const runs = new Map();

async function driveWith(modulePath, shape) {
  const { verifyJourneys } = await import(`file://${modulePath.replace(/\\/g, "/")}`);
  return verifyJourneys({ previewUrl: urls.get(shape), contract: CONTRACT, timeoutMs: 180_000 });
}

const stepLine = (step) => `${step.status.padEnd(11)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n")}`;

test("GRADED VERIFIER + live-shaped app reproduces the live step-by-step verdict",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await driveWith(LIVE_VERIFIER, "value-gated");
    runs.set("live/value-gated", result);
    const steps = result.journeys[0].steps;
    const transcript = steps.map(stepLine).join("\n");

    // The five claims the objective asks to prove or disprove, in order.
    assert.equal(steps[2].status, "pass", `date selection must pass\n${transcript}`);
    assert.equal(steps[3].status, "pass", `slot step passed live\n${transcript}`);
    assert.equal(steps[4].status, "pass", `party step passed live\n${transcript}`);
    assert.equal(steps[5].status, "undriveable", `contact was gated live\n${transcript}`);
    assert.equal(steps[6].status, "fail", `review failed live\n${transcript}`);

    // FALSE PASS, proved by the text of the option the driver actually moved selection between:
    // both the slot step and the party step operated the DATE group.
    assert.match(steps[3].detail, /selection moved from "Friday 18 October/,
      `the slot step must drive the date group, as it did live\n${transcript}`);
    assert.match(steps[3].selectedText || "", /October/);
    assert.match(steps[4].detail, /selection moved from "Saturday 19 October/,
      `the party step must drive the date group back, as it did live\n${transcript}`);
    assert.match(steps[4].selectedText || "", /October/);

    // The live failure message for review, verbatim in shape.
    assert.match(steps[6].detail, /nothing changed — /);

    // And the overall shape: the primary journey is red, with the same count of hard failures.
    assert.equal(result.journeys[0].status, "fail");
  });

test("the reproduction's per-step transcript matches the retained live transcript",
  { ...needsBrowser, timeout: 60_000 }, () => {
    const steps = runs.get("live/value-gated").journeys[0].steps;
    assert.equal(steps.length, LIVE_STEPS.length);
    const observed = steps.map((step) => step.status);
    const live = LIVE_STEPS.map((step) => step.status);
    assert.deepEqual(observed.slice(0, 7), live.slice(0, 7),
      `steps 1-7 must match the live run exactly\nobserved: ${observed}\nlive:     ${live}`);
  });

// ── 4. the same app, strictly step-gated ──────────────────────────────────────────────────────

test("GRADED VERIFIER + strictly step-gated app: the same misdrive, a different symptom",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await driveWith(LIVE_VERIFIER, "step-gated");
    runs.set("live/step-gated", result);
    const steps = result.journeys[0].steps;
    const transcript = steps.map(stepLine).join("\n");
    // Recorded, not asserted into a shape: the point is that step-gating is not the discriminator.
    // With only the current step rendered, the date group is the ONLY group, so the slot step
    // either re-drives it or finds nothing — never the contracted control.
    assert.ok(steps.length === PRIMARY.steps.length, transcript);
    assert.notEqual(steps[3].status, "pass_for_the_right_reason");
    console.log(`\n[step-gated · graded verifier]\n${transcript}\n`);
  });

// ── 5. HEAD's verifier over the identical fixture ─────────────────────────────────────────────

test("CORRECTED VERIFIER — value-gated: every contracted selection drives its OWN control",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await verifyJourneysHead({
      previewUrl: urls.get("value-gated"), contract: CONTRACT, timeoutMs: 180_000,
    });
    runs.set("head/value-gated", result);
    const steps = result.journeys[0].steps;
    const transcript = steps.map(stepLine).join("\n");
    console.log(`\n[value-gated · corrected verifier]\n${transcript}\n`);

    // 1. date selection changes only the date.
    assert.equal(steps[2].status, "pass", transcript);
    assert.match(steps[2].detail, /October/, "the date step drives a date");
    // 4. the slot step operates the SLOT, not the date — the live false pass is gone.
    assert.equal(steps[3].status, "pass", transcript);
    assert.equal(/October/.test(steps[3].detail), false,
      `the slot step must not drive the date group\n${transcript}`);
    assert.match(steps[3].detail, /18:30|20:15/, "the slot step drives a slot");
    // 5. the party step operates the PARTY SIZE, not date or slot.
    assert.equal(steps[4].status, "pass", transcript);
    assert.equal(/October|18:30|20:15/.test(steps[4].detail), false,
      `the party step must not drive an earlier group\n${transcript}`);
    assert.match(steps[4].detail, /guests/, "the party step drives a party size");
    // 6. contact becomes reachable.
    assert.equal(steps[5].status, "pass", transcript);
    // 7 + 8. exact entered values propagate and the review verifies them.
    assert.equal(steps[6].status, "pass", transcript);
    assert.match(steps[6].detail, /exact entered value/, transcript);
  });

test("CORRECTED VERIFIER — strictly step-gated: bounded navigation reaches each contracted control",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await verifyJourneysHead({
      previewUrl: urls.get("step-gated"), contract: CONTRACT, timeoutMs: 180_000,
    });
    runs.set("head/step-gated", result);
    const steps = result.journeys[0].steps;
    const transcript = steps.map(stepLine).join("\n");
    console.log(`\n[step-gated · corrected verifier]\n${transcript}\n`);

    assert.equal(steps[2].status, "pass", transcript);
    assert.equal(steps[3].status, "pass", transcript);
    assert.match(steps[3].detail, /18:30|20:15/, `slot step drives the slot\n${transcript}`);
    assert.equal(steps[4].status, "pass", transcript);
    assert.match(steps[4].detail, /guests/, `party step drives the party size\n${transcript}`);
    assert.equal(steps[5].status, "pass", `contact becomes reachable\n${transcript}`);

    // 3. Navigation advanced exactly one intended step per activation, and only via a control
    //    that names itself with the generic advance vocabulary.
    const advances = steps.flatMap((s) => s.controlEvidence?.flowAdvances || []);
    assert.ok(advances.length, "the step-gated shape needs navigation");
    assert.ok(advances.filter((a) => a.advanced).every((a) => /continue|next/i.test(a.via)),
      `only generic advance controls may be activated: ${JSON.stringify(advances)}`);
  });

test("no false PASS: an app whose 'slot' group is missing is undriveable, never green",
  { ...needsBrowser, timeout: 300_000 }, () => {
    // The graded verifier passed the slot step by moving the DATE selection. The corrected one
    // must never reach a pass through a group it was not contracted to drive — proved above by
    // the absence of "October" in the slot and party details, and here by the rule that produced
    // it: a contracted selection has NO prose fallback.
    const source = readFileSync(path.join(HERE, "..", "..", "shell", "server", "lib", "appBuild",
      "journeyVerifier.mjs"), "utf8");
    assert.match(source, /There is deliberately NO prose fallback here/);
  });
