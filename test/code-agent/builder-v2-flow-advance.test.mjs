// MOVING A FLOW FORWARD, WITHOUT READING THE BUTTON.
//
// The last dictionary in Builder V2's mechanical driving path was ADVANCE_ACTION_PATTERN: a list
// of English words — next, continue, proceed — used to find the control that reveals the next
// screen. A paid qualification built a correct application, labelled that button "Next to party
// size", and was graded undriveable because the phrase was not in the list. Every control on
// every later step is behind this one, so a miss here is not a partial failure, it is the journey.
//
// Advancing now has the same opaque machine identity as every other contracted control. These
// tests compile ONE application, present its forward button eleven different ways, and require
// identical behaviour — including when the label is an arrow, French, or the name of a fruit.
//
// They also require the reverse: a forward button with the WRONG identity, or none at all, must be
// reported as undriveable. The point is not that the browser always finds a way through. It is
// that it never guesses.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  ADVANCE_ACTION_ID, actionIdFor, browserPlan, controlIdFor, deriveVerificationManifest,
} from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { ADVANCE_CONTRACT, flowAdvanceApp } from "./fixtures/flowAdvanceApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(ADVANCE_CONTRACT);
const CASE = "bv2-flow-advance";

// Every one of these must drive the flow to the end. The label is not an input to that.
const DRIVEABLE = ["live", "next", "continue", "arrow", "icon", "french", "renamed", "decoy", "reordered"];
// Neither of these may be driven — and neither may be faked.
const UNDRIVEABLE = ["wrongIdentity", "missing"];

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
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...flowAdvanceApp() }, CASE, () => {});
  assert.equal(built.ok, true, `the fixture must compile: ${built.detail || ""}`);
  for (const presentation of [...DRIVEABLE, ...UNDRIVEABLE]) {
    runs.set(presentation, await drive(presentation));
  }
}, { timeout: 900_000 });

after(() => { runs.clear(); });

const journeyOf = (report) => (report?.journeys || []).find((row) => row.id === "book-a-seat");
const stepStatuses = (report) => (journeyOf(report)?.steps || []).map((row) => row.status);
// The step the paid run never reached.
const partyStep = (report) => (journeyOf(report)?.steps || [])[2] || null;

// ── the exact paid failure ─────────────────────────────────────────────────────────────────────

test('LIVE REGRESSION — a forward button labelled "Next to party size" drives the flow',
  needsBrowser, () => {
    const report = runs.get("live");
    const journey = journeyOf(report);
    assert.equal(journey.status, "pass",
      `the paid label is still undriveable: ${JSON.stringify(stepStatuses(report))} ${journey.detail || ""}`);
    // Specifically: the party-size control was reached and driven, which is what failed live.
    assert.equal(partyStep(report).status, "pass",
      `party size: ${partyStep(report).detail || ""}`);
    assert.equal(stepStatuses(report).every((status) => status === "pass"), true,
      `every step: ${JSON.stringify(stepStatuses(report))}`);
  });

// ── the label is not an input ──────────────────────────────────────────────────────────────────

for (const presentation of DRIVEABLE) {
  test(`the forward control is found regardless of its label — ${presentation}`, needsBrowser, () => {
    const report = runs.get(presentation);
    assert.deepEqual(stepStatuses(report), stepStatuses(runs.get("live")),
      `${presentation} behaved differently from the paid label: ${JSON.stringify(stepStatuses(report))}`);
    assert.equal(journeyOf(report).status, "pass", journeyOf(report).detail || "");
  });
}

// ── adversarial: wording must not be able to steer ─────────────────────────────────────────────

for (const presentation of ["decoy", "reordered"]) {
  test(`a plausible unrelated "Next" button is never clicked — ${presentation}`, needsBrowser, () => {
    // The decoy leads to a dead end the application cannot leave, so the party-size and guest-name
    // controls never mount again. Completing the journey is proof the decoy was not taken — and
    // the reordered variant proves the same with the real control FIRST in the DOM and the decoy
    // after it, so neither wording nor document order decides anything.
    const report = runs.get(presentation);
    assert.equal(journeyOf(report).status, "pass",
      `wording or DOM order redirected the driver: ${journeyOf(report).detail || ""}`);
    const text = JSON.stringify(report);
    assert.equal(/dead end/i.test(text), false, "the driver reached the decoy's dead end");
  });
}

for (const presentation of UNDRIVEABLE) {
  test(`a missing or wrong action identity is reported, not guessed around — ${presentation}`,
    needsBrowser, () => {
      const journey = journeyOf(runs.get(presentation));
      // wrongIdentity carries a button of the right shape with the right words on it. It is not
      // the declared advance control, so it is not the transition — and the legacy word list must
      // not rescue it either.
      assert.notEqual(journey.status, "pass",
        `an undeclared forward control was accepted as the transition (${presentation})`);
      assert.notEqual(partyStep(runs.get(presentation)).status, "pass",
        "the unreachable party-size step was graded green");
      const detail = JSON.stringify(journey);
      assert.equal(/dead end/i.test(detail), false, "the driver wandered off the flow");
    });
}

// ── derivation: the identity exists before any browser opens ───────────────────────────────────

test("the canonical advance identity is opaque, stable and distinct", () => {
  assert.match(ADVANCE_ACTION_ID, /^act_[0-9a-f]{8}$/);
  assert.equal(ADVANCE_ACTION_ID, actionIdFor("advance"));
  // It is one fixed identity, not one derived from what a step called the button.
  for (const wording of ["Next to party size", "Continue", "Suivant", "next step control"]) {
    assert.notEqual(actionIdFor(wording), ADVANCE_ACTION_ID);
  }
});

// A contract that names the transition explicitly: the manifest must carry it as a mechanical
// action, with the control it is expected to reveal.
const EXPLICIT = {
  ...ADVANCE_CONTRACT,
  journeys: [{ id: "book-a-seat", title: "A guest books a supper club seat", priority: "primary", steps: [
    { action: "open the booking page", target: "/", expect: "the supper club booking page is visible" },
    { action: "select an available date", target: "date picker", operates: ["dateId"],
      expect: "the selected date is highlighted" },
    { action: "continue to the next step", target: "next step control",
      expect: "the party size step is shown" },
    { action: "choose a party size", target: "party size control", operates: ["partySize"],
      primitive: "selection", expect: "the chosen party size is displayed" },
  ] }],
};

test("an explicit transition step becomes an advance action carrying the canonical identity", () => {
  const plan = buildInteractionContract(EXPLICIT);
  const advance = plan.flows.find((flow) => flow.kind === "flow_advance");
  assert.ok(advance, `no transition derived: ${JSON.stringify(plan.flows.map((f) => f.kind))}`);
  assert.equal(advance.control?.machineId, ADVANCE_ACTION_ID,
    "the transition was identified by its prose instead of the canonical identity");

  const manifest = deriveVerificationManifest(deriveBuildSpec(EXPLICIT));
  const action = manifest.actions.find((row) => row.primitive === "advance");
  assert.ok(action, `no advance action in the manifest: ${JSON.stringify(manifest.actions)}`);
  assert.equal(action.id, ADVANCE_ACTION_ID);
  assert.equal(action.action, "activate");
  assert.equal(action.expected, "state_or_route_changed");
  // What the transition is FOR: the next contracted control becomes reachable.
  assert.equal(action.expectedNextControl, controlIdFor("partySize"),
    "the advance action does not say what it should reveal");
});

test("the browser's copy of the advance action carries no wording it must match", () => {
  const plan = browserPlan(deriveVerificationManifest(deriveBuildSpec(EXPLICIT)));
  const action = plan.actions.find((row) => row.id === ADVANCE_ACTION_ID);
  assert.ok(action);
  assert.equal(action.primitive, "advance");
  assert.equal(action.expectedNextControl, controlIdFor("partySize"));
  assert.equal("journeyId" in action, false);
  // Fallback names may exist for identity-less legacy builds, but nothing here is a platform
  // dictionary: every string present came from the contract.
  for (const name of action.fallbackNames || []) {
    assert.equal(JSON.stringify(EXPLICIT).includes(name), true, `${name} is not contract-supplied`);
  }
});

test("the model is told how to declare the forward control, and is never told an id", async () => {
  const registry = await import("../../shell/server/lib/builderV2/capabilityRegistry.mjs");
  const needs = (await import("../../shell/server/lib/builderV2/interactionContract.mjs"))
    .assemblyNeeds(buildInteractionContract(ADVANCE_CONTRACT), SPEC.bindings || []);
  assert.equal(needs.flowAdvance, true, "a three-screen flow does not advertise the forward control");
  const brief = registry.preferredAssemblyBrief(needs);
  assert.match(brief, /useFlowAdvance/);
  assert.equal(brief.includes(ADVANCE_ACTION_ID), false, "the brief leaks the opaque id to the model");
  // A single-screen contract with one value step has nothing to advance through.
  const single = buildInteractionContract({ ...ADVANCE_CONTRACT, journeys: [{ id: "one", title: "one",
    priority: "primary", steps: [
      { action: "open the booking page", target: "/", expect: "the page is visible" },
      { action: "enter the guest name", target: "form", operates: ["guestName"], expect: "the name is shown" },
    ] }] });
  assert.equal((await import("../../shell/server/lib/builderV2/interactionContract.mjs"))
    .assemblyNeeds(single, []).flowAdvance, false);
});
