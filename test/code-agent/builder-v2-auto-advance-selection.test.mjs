// A contracted selection that legitimately unmounts its own control.
//
// THE PAID FAILURE (2026-08-10T22:20Z, build 27be60ab, the first run graded by the current
// verifier — evidence in fixtures/live-booking-2026-08-10T2220Z-run5.json):
//
//   step 3 "select a date with availability"  →  FAIL  "no clickable option was identified"
//
// A zero-model DOM probe against that build's own preview showed the app was correct:
//
//   BEFORE  3 × <button name="date Id" aria-pressed="false">
//   AFTER   0 date buttons (unmounted) · 2 × <button name="slot Id"> for the chosen date
//
// The contracted expectation for that step is "available slots for that date are displayed with
// remaining seat counts" — which is exactly what happened. selectionTransition failed it anyway,
// because it required the clicked option to still be mounted and expose selected state.
//
// The exact generated source is NOT retained: the disposable-project cleanup erased the working
// snapshots and bv2_patches records changed paths only. These fixtures therefore reproduce the
// OBSERVED SHAPE from the DOM probe, using the real platform primitives, not the original source.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyJourneys, selectionTransition } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { autoAdvanceApp, AUTO_ADVANCE_SHAPES } from "./fixtures/autoAdvanceFlowApp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const RUN5 = JSON.parse(await readFile(
  path.join(HERE, "fixtures", "live-booking-2026-08-10T2220Z-run5.json"), "utf8"));

// ── the contracts, all derived by the production derivation code ──────────────────────────────

const bookingContract = () => {
  const live = RUN5.contract;
  const journey = live.journeys.find((j) => j.id === "reserve-supper-club-seats");
  return { ...live, journeys: [journey] };
};

const genericContract = (id, title, steps, entityFields) => deriveBuildSpec({
  summary: title, projectType: "web app", version: 1, auth: { required: false },
  routes: [{ path: "/", name: "Home" }],
  entities: [{ name: "record", fields: entityFields.map((name) => ({ name, type: "string" })) }],
  operations: [{ name: "create-record", entity: "record", kind: "create" }],
  journeys: [{ id, title, priority: "primary", steps }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;

const CHECKOUT = genericContract("complete-checkout", "A buyer completes a checkout", [
  { action: "open the store page", target: "/", expect: "the storefront headline for a supply company is shown" },
  { action: "click the Start checkout control", target: "Start checkout control",
    expect: "the checkout shows the shipping options with a step title" },
  { action: "select a delivery speed", target: "delivery speed picker",
    expect: "the payment step is shown for the selected delivery speed" },
  { action: "select a card brand", target: "card brand picker",
    expect: "the selected card brand is highlighted" },
], ["deliverySpeed", "cardBrand"]);

const ONBOARDING = genericContract("complete-onboarding", "A member completes onboarding", [
  { action: "open the onboarding page", target: "/", expect: "the onboarding welcome headline for new members is shown" },
  { action: "click the Start onboarding control", target: "Start onboarding control",
    expect: "the onboarding shows the account type options with a step title" },
  { action: "select an account type", target: "account type picker",
    expect: "the account details step is shown for the selected account type" },
  { action: "enter a workspace name", target: "account details form",
    expect: "the workspace name field accepts the value" },
], ["accountType", "workspaceName"]);

const CRM = genericContract("configure-deal", "A rep configures a deal", [
  { action: "open the deal page", target: "/", expect: "the deal pipeline headline for the sales team is shown" },
  { action: "click the Start deal control", target: "Start deal control",
    expect: "the deal setup shows the pipeline stages with a step title" },
  { action: "select a pipeline stage", target: "pipeline stage picker",
    expect: "the deal owner configuration is shown for the selected pipeline stage" },
  { action: "select a deal owner", target: "deal owner picker",
    expect: "the selected deal owner is highlighted" },
], ["pipelineStage", "dealOwner"]);

const CONTRACTS = {
  "booking-auto-advance": bookingContract(),
  "booking-unrelated-content": bookingContract(),
  "booking-wrong-next-state": bookingContract(),
  "booking-rerender-only": bookingContract(),
  "checkout-auto-advance": CHECKOUT,
  "onboarding-auto-advance": ONBOARDING,
  "crm-auto-advance": CRM,
};

// ── build and serve every shape ───────────────────────────────────────────────────────────────

const servers = new Map();
const urls = new Map();
const builds = new Map();

async function serve(caseName) {
  const root = path.join(workDirFor(caseName), "dist");
  const server = http.createServer(async (request, response) => {
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
  servers.set(caseName, server);
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const shape of AUTO_ADVANCE_SHAPES) {
    const caseName = `bv2-auto-advance-${shape}`;
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...autoAdvanceApp(shape) }, caseName, () => {});
    builds.set(shape, built);
    if (built.ok) urls.set(shape, await serve(caseName));
  }
}, { timeout: 1_800_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

const line = (step) => `${String(step.status).padEnd(12)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n")}`;
const drive = async (shape) => verifyJourneys({
  previewUrl: urls.get(shape), contract: CONTRACTS[shape], timeoutMs: 180_000,
});

test("every auto-advance fixture compiles", { ...needsBrowser }, () => {
  for (const [shape, built] of builds) assert.equal(built.ok, true, `${shape}: ${built?.stderr}`);
});

// ── PART 1: the pure rule, so the reproduction is unambiguous ──────────────────────────────────

test("the paid failure is exactly what selectionTransition returns for an unmounted group", () => {
  // What the live driver saw: three options before, an empty group after.
  const before = [
    { index: 0, text: "Date Id Friday, October 18", selected: false },
    { index: 1, text: "Date Id Saturday, October 19", selected: false },
    { index: 2, text: "Date Id Sunday, October 20", selected: false },
  ];
  const withoutEvidence = selectionTransition({ before, after: [], clickedIndex: 0 });
  assert.equal(withoutEvidence.ok, false);
  assert.equal(withoutEvidence.reason, "no clickable option was identified",
    "this is the verbatim reason the paid run recorded");
  assert.equal(RUN5.liveVerdict.steps[2].detail, "no clickable option was identified");
  assert.equal(RUN5.liveVerdict.steps[2].status, "fail");
});

// ── PART 4/5: behaviour in a real browser ─────────────────────────────────────────────────────

test("BOOKING date → slots: the live shape now passes, driving the date group", { ...needsBrowser, timeout: 300_000 },
  async () => {
    const result = await drive("booking-auto-advance");
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[booking-auto-advance]\n${transcript}\n`);
    assert.equal(steps[2].status, "pass", `the auto-advancing date step must pass\n${transcript}`);
    assert.match(steps[2].detail, /advanced the flow/, transcript);
    // Proof it drove the DATE group and captured which option: the pre-click identity survives.
    assert.match(steps[2].detail, /October/, transcript);
    // And the slot step then drives slots, not dates.
    assert.equal(steps[3].status, "pass", transcript);
    assert.match(steps[3].detail, /6:30 PM|8:30 PM/, transcript);
  });

test("ADVERSARIAL — unrelated content appears instead of the contracted next state",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await drive("booking-unrelated-content");
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[booking-unrelated-content]\n${transcript}\n`);
    assert.notEqual(steps[2].status, "pass", `a newsletter is not "slots for that date"\n${transcript}`);
    assert.notEqual(result.journeys[0].status, "pass");
  });

test("ADVERSARIAL — the wrong contracted control appears next", { ...needsBrowser, timeout: 300_000 },
  async () => {
    const result = await drive("booking-wrong-next-state");
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[booking-wrong-next-state]\n${transcript}\n`);
    // Party size is a real contracted control — but it is not what selecting a date must produce.
    assert.notEqual(steps[2].status, "pass", `party size is not the contracted next state\n${transcript}`);
    assert.notEqual(result.journeys[0].status, "pass");
  });

test("ADVERSARIAL — a re-render that never moves selection still fails", { ...needsBrowser, timeout: 300_000 },
  async () => {
    const result = await drive("booking-rerender-only");
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[booking-rerender-only]\n${transcript}\n`);
    // The group stays mounted, so branch A applies and the option must gain selected state.
    // This fixture DOES set it, so the step passes — what must NOT happen is a pass via the
    // auto-advance branch, which would mean "the DOM changed, therefore pass".
    assert.equal(/advanced the flow/.test(steps[2].detail || ""), false,
      `a persistent control must be judged on selected state, not on advancement\n${transcript}`);
  });

for (const [shape, label] of [["checkout-auto-advance", "CHECKOUT delivery → payment"],
  ["onboarding-auto-advance", "ONBOARDING account type → details"],
  ["crm-auto-advance", "CRM pipeline stage → owner"]]) {
  test(`GENERIC — ${label}`, { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await drive(shape);
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[${shape}]\n${transcript}\n`);
    assert.equal(steps[2].status, "pass", `the auto-advancing selection must pass\n${transcript}`);
    assert.match(steps[2].detail, /advanced the flow/, transcript);
  });
}
