// BROWSER-RED → TYPED DEFECT → SCOPED REPAIR → MEASURED PROGRESS.
//
// Ten paid qualifications ended red and none was turned green by a repair round. The evidence was
// never missing: the probe knew a control carried no machine identity, the failing step kept the
// page's own text and console, attribution knew which modules own the journey. Each was written
// somewhere nothing downstream read, and the repair was briefed with a sentence.
//
// These tests hold the corrected path to its claims on deterministic fixtures only. Nothing here
// launches a browser or spends a credit; the browser's verdicts are supplied in exactly the shape
// `journeysFn` really returns them.

import test from "node:test";
import assert from "node:assert/strict";

import { createOrchestrator, memoryBuildStore, browserRepairEvidence }
  from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import {
  DEFECT_CLASS, DEFECT_OWNER, REPAIR_TIER,
  verificationDefects, actionableDefects, platformDefectsOf,
  defectEvidence, defectWriteBoundary, defectProgress, defectSignature,
} from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { deriveVerificationManifest, controlIdFor, actionIdFor }
  from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { repairFailureOwnedPaths } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { validateModulePatchScope } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const CONTRACT = {
  summary: "A booking workflow with durable confirmation",
  entities: [{ name: "booking", fields: [{ name: "guestName" }, { name: "eventDate" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create", journey: "booking" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "booking", title: "Complete a booking", priority: "primary", steps: [
    { action: "enter the guest name", target: "guestName", expect: "the name is held" },
    { action: "select an event date", target: "eventDate", expect: "the date becomes selected" },
    { action: "confirm the booking", target: "confirm booking", expect: "a confirmation reference appears" },
    { action: "reload the confirmed booking", target: "booking", expect: "the confirmed booking is recovered" },
  ] }],
};

const SPEC = deriveBuildSpec(CONTRACT);
const MANIFEST = deriveVerificationManifest(SPEC);
const JOURNEY_OWNER = "src/routes/Booking.jsx";
const STATE_OWNER = "src/data/wizard.js";
const UNRELATED = "src/routes/Marketing.jsx";

/**
 * One browser verdict in `journeysFn` shape, with the failing step at its CONTRACTED index —
 * the interaction contract answers "which flow is this step" by index, so a fixture that
 * collapses the journey would be asking about the wrong control.
 */
function verdicts({ failAt = 0, step: over = {}, mechanics = null, verifierDefects = [], journeyId = "booking",
  owners = [JOURNEY_OWNER] } = {}) {
  const steps = CONTRACT.journeys[0].steps.map((step, index) => (
    index < failAt ? { action: step.action, expect: step.expect, status: "pass", drove: true }
      : index === failAt ? { action: step.action, expect: step.expect, status: "fail", drove: true, ...over }
      : { action: step.action, expect: step.expect, status: "not_reached" }
  ));
  const failing = steps[failAt];
  return {
    journeys: [{
      id: journeyId, title: "Complete a booking",
      priority: journeyId === "booking" ? "primary" : "secondary",
      status: failing.status === "fail" ? "fail" : "undriveable",
      steps, owners, attributionStatus: "attributed",
    }],
    mechanics, verifierDefects, blockingErrors: [], consoleErrors: [], failedRequests: [],
  };
}

const defectsFrom = (result, spec = SPEC) => verificationDefects({
  contract: spec.contract, interactionContract: spec.interactionContract,
  journeyResults: result, manifest: MANIFEST, tree: null,
});

// ── the defect shapes ─────────────────────────────────────────────────────────────────────────

test("a dead textbox is an addressed interaction defect the correction tier owns", () => {
  const id = controlIdFor("guestName");
  const defects = defectsFrom(verdicts({
    failAt: 0,
    step: { status: "undriveable", drove: false, detail: "guestName:value_not_accepted" },
    mechanics: { probed: 1, failures: [{ id, primitive: "textbox", expected: "Probe", observed: "",
      detail: "the contracted textbox did not retain a probe value" }], skipped: [], outcomes: [] },
  }));

  const dead = defects.find((defect) => defect.code === "control_cannot_hold_value");
  assert.ok(dead, `no dead-control defect in ${JSON.stringify(defects.map((d) => d.code))}`);
  assert.equal(dead.defectClass, DEFECT_CLASS.INTERACTION);
  assert.equal(dead.owner, DEFECT_OWNER.APP);
  // A proven, addressed structural defect draws on the correction allowance — never the single
  // browser-informed repair slot, which is what run #7 spent on three dead inputs and lost.
  assert.equal(dead.tier, REPAIR_TIER.CORRECTION);
  assert.equal(dead.control.id, id);
  assert.equal(dead.control.logicalField, "guestName");
  assert.equal(dead.evidence.mechanics.observed, "");
});

test("a dead selection is reported by its own identity, not by the step that tripped over it", () => {
  const id = controlIdFor("eventDate");
  const defects = defectsFrom(verdicts({
    failAt: 1,
    step: { status: "undriveable", drove: false, detail: "the clicked option never gained a selected state" },
    mechanics: { probed: 1, failures: [{ id, primitive: "selection", expected: "selection_state_changed",
      observed: "unchanged", detail: "clicking a contracted option produced no selected state" }],
      skipped: [], outcomes: [] },
  }));

  const dead = defects.find((defect) => defect.control?.id === id);
  assert.ok(dead, `the selection defect is addressed by its machine identity: ${JSON.stringify(defects)}`);
  assert.equal(dead.defectClass, DEFECT_CLASS.INTERACTION);
  assert.equal(dead.tier, REPAIR_TIER.CORRECTION);
  assert.equal(dead.evidence.mechanics.observed, "unchanged");
});

test("a contracted BUTTON that carries no machine identity says so on the defect", () => {
  // The run #8 shape: the model hand-wired the control, so every identity-addressed path is blind
  // to it. The action probe answers that before a journey ever runs.
  const confirmId = actionIdFor("confirm booking");
  const defects = defectsFrom(verdicts({
    failAt: 2,
    step: { status: "undriveable", drove: false, detail: "the contracted action could not be activated" },
    mechanics: { probed: 1, failures: [], skipped: [],
      outcomes: [{ id: confirmId, outcome: "identity_absent", addressedBy: "fallback_name",
        detail: "the contracted action was reached only by a contract-supplied name" }] },
  }));

  const undriveable = defects.find((defect) => defect.code === "contracted_control_undriveable");
  assert.ok(undriveable, `no undriveable defect: ${JSON.stringify(defects.map((d) => d.code))}`);
  assert.equal(undriveable.defectClass, DEFECT_CLASS.INTERACTION);
  assert.equal(undriveable.control.id, confirmId, "the action's own identity addresses the defect");
  assert.equal(undriveable.evidence.addressing.reason, "identity_absent",
    "the probe's addressing evidence rides on the defect it explains");
});

test("a record that does not survive a reload is a DURABILITY defect, not a behaviour one", () => {
  const defects = defectsFrom(verdicts({
    failAt: 3,
    step: { status: "fail", drove: true, detail: "recovered state no longer shows: confirmed",
      observation: { text: "Booking status page empty/error state: no booking details are displayed.",
        consoleSince: [], requestsSince: [] } },
  }));

  const durable = defects.find((defect) => defect.defectClass === DEFECT_CLASS.DURABILITY);
  assert.ok(durable, `no durability defect: ${JSON.stringify(defects.map((d) => [d.code, d.defectClass]))}`);
  assert.equal(durable.code, "durable_outcome_missing");
  assert.equal(durable.tier, REPAIR_TIER.REPAIR, "a durable outcome needs a model round, not a binding fix");
  // Run #10's blocker was diagnosable in seconds from exactly this text — and the model repairing
  // the app never saw it.
  assert.match(durable.evidence.pageText, /no booking details/);
});

test("a mutation the browser never managed to trigger is not evidence about durability", () => {
  const defects = defectsFrom(verdicts({
    failAt: 2,
    step: { status: "fail", drove: false, detail: "the commit control was never activated" },
  }));
  const defect = defects.find((row) => row.journeyId === "booking");
  assert.equal(defect.defectClass, DEFECT_CLASS.INTERACTION,
    "drove=false means the control, not the record, is the subject");
});

test("a behavioural failure on a driven control is neither interaction nor durability", () => {
  const defects = defectsFrom(verdicts({
    failAt: 1, step: { status: "fail", drove: true, detail: "the date never became active" },
  }));
  const defect = defects.find((row) => row.journeyId === "booking");
  assert.equal(defect.defectClass, DEFECT_CLASS.BEHAVIOUR);
  assert.equal(defect.tier, REPAIR_TIER.REPAIR);
});

test("a verification platform failure is owned by the platform and is not repairable", () => {
  const defects = defectsFrom(verdicts({
    failAt: 0, step: { status: "undriveable", detail: "driver error: Target closed" },
    verifierDefects: [{ code: "journey_driver_error", detail: "Target closed", journeyId: "booking" }],
  }));

  const platform = platformDefectsOf(defects);
  assert.equal(platform.length, 1);
  assert.equal(platform[0].defectClass, DEFECT_CLASS.PLATFORM);
  assert.equal(platform[0].tier, REPAIR_TIER.NONE);
  assert.ok(!actionableDefects(defects).some((defect) => defect.owner === DEFECT_OWNER.PLATFORM),
    "a platform defect never enters the actionable set");
});

test("ambiguous addressing stays UNKNOWN rather than being charged to the application", () => {
  const id = controlIdFor("guestName");
  const defects = defectsFrom(verdicts({
    failAt: 0, step: { status: "undriveable", drove: false, detail: "contracted control could not be driven" },
    mechanics: { probed: 0, failures: [], outcomes: [],
      skipped: [{ id, reason: "ambiguous_identity", candidates: 3, addressedBy: "identity" }] },
  }));

  const defect = defects.find((row) => row.control?.id === id);
  assert.equal(defect.owner, DEFECT_OWNER.UNKNOWN);
  assert.equal(defect.uncertain, true);
});

// ── attribution, brief and boundary ───────────────────────────────────────────────────────────

test("the write boundary is the verifier's own attribution, and absent attribution means none", () => {
  const boundary = defectWriteBoundary(defectsFrom(verdicts({ failAt: 1 })));
  assert.ok(boundary.allowedFiles.includes(STATE_OWNER), "the flow's declared state owner is in scope");
  assert.ok(boundary.allowedFiles.includes(JOURNEY_OWNER), "the journey's owning module is in scope");
  assert.ok(!boundary.allowedFiles.includes(UNRELATED), "an unrelated route is not");
  // Platform runtime is never a repair target: the patch engine refuses it, so naming it would
  // only waste an attempt.
  assert.ok(!boundary.allowedFiles.some((path) => path.startsWith("src/lib/capabilities/")));
  // No directory prefixes: `src/routes/` would readmit every sibling route and the boundary
  // would mean nothing for exactly the files a repair is most likely to wander into.
  assert.deepEqual(boundary.allowedPrefixes, []);

  // Nothing attributed anywhere means NO boundary — a repair is never confined to a guess.
  const unattributed = verificationDefects({
    contract: CONTRACT, interactionContract: { flows: [] }, manifest: MANIFEST,
    journeyResults: verdicts({ failAt: 0, owners: [] }),
  });
  assert.ok(actionableDefects(unattributed).length, "there is still a defect to repair");
  assert.equal(defectWriteBoundary(unattributed), null);
});

test("a boundary is machine-enforced by the same check a pre-compile correction gets", () => {
  const boundary = defectWriteBoundary(defectsFrom(verdicts({ failAt: 1 })));
  const inside = validateModulePatchScope([{ file: STATE_OWNER, content: "x" }], boundary);
  const outside = validateModulePatchScope([{ file: UNRELATED, content: "x" }], boundary);
  assert.equal(inside.ok, true);
  assert.equal(outside.ok, false);
  assert.equal(outside.findings[0].code, "module_correction_scope_exceeded");
});

test("the brief carries the page's own account of the failure, not a summary of it", () => {
  const lines = defectEvidence(defectsFrom(verdicts({
    failAt: 2,
    step: { status: "fail", drove: true, detail: "expected confirmation; found booking",
      observation: { text: "Sorry, that slot is no longer available.",
        consoleSince: ["TypeError: cannot read property 'reference' of null"],
        requestsSince: ["500 POST /api/bookings"] } },
  })));

  const structured = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  assert.equal(structured.length, 1);
  const row = structured[0];
  // The code downstream already parses — enrichment may never break the existing readers.
  assert.equal(row.code, "interaction_verification_failure");
  assert.equal(row.pageTextWhenItFailed, "Sorry, that slot is no longer available.");
  assert.deepEqual(row.consoleErrorsDuringStep, ["TypeError: cannot read property 'reference' of null"]);
  assert.deepEqual(row.failedRequestsDuringStep, ["500 POST /api/bookings"]);
  assert.equal(row.owner, DEFECT_OWNER.APP);
  assert.ok(row.defectClass, "every row states its class");
  assert.ok(row.repairTier, "every row states which allowance answers it");
});

test("structured attribution drives retrieval — no filename is scraped out of prose", () => {
  const evidence = defectEvidence(defectsFrom(verdicts({ failAt: 1 })));
  const prose = evidence.filter((line) => !line.trim().startsWith("{"));
  assert.ok(!prose.some((line) => line.includes(STATE_OWNER) || line.includes(JOURNEY_OWNER)),
    "the owning modules are structured data, not strings for a regex to find");
  const owned = repairFailureOwnedPaths(SPEC.contract, evidence);
  assert.ok(owned.includes(STATE_OWNER),
    `retrieval resolves the write address from the structured row: ${JSON.stringify(owned)}`);
});

test("platform-owned defects reach the brief as context and never ask for a patch", () => {
  const lines = browserRepairEvidence({
    contract: SPEC.contract, interactionContract: SPEC.interactionContract,
    journeyResults: verdicts({
      failAt: 0, step: { status: "undriveable", detail: "driver error: Target closed" },
      verifierDefects: [{ code: "journey_driver_error", detail: "Target closed" }],
    }),
  });
  const context = lines.filter((line) => line.startsWith("context ("));
  assert.equal(context.length, 1);
  assert.match(context[0], /platform-owned, not an application defect/);
});

// ── progress ──────────────────────────────────────────────────────────────────────────────────

test("progress is measured on defects, not on whether the wording changed", () => {
  const before = defectsFrom(verdicts({ failAt: 2, step: { detail: "expected confirmation; found booking" } }));
  const reworded = defectsFrom(verdicts({ failAt: 2, step: { detail: "the confirmation did not appear" } }));
  const later = defectsFrom(verdicts({ failAt: 3, step: { detail: "recovered state no longer shows: confirmed" } }));

  assert.equal(defectProgress(before, reworded).moved, false, "a reworded failure is not progress");
  assert.equal(defectProgress(before, reworded).reason, "unchanged");
  assert.equal(defectSignature(before[0]), defectSignature(reworded[0]),
    "the same defect keeps the same identity when only its prose changes");

  // Getting further is progress: the old defect is gone even though a new one appeared.
  const advanced = defectProgress(before, later);
  assert.equal(advanced.moved, true);
  assert.equal(advanced.reason, "partial_progress");

  const fixed = defectProgress(before, []);
  assert.equal(fixed.moved, true);
  assert.equal(fixed.reason, "progress");
});

test("new defects with none resolved is a regression, and stops the loop too", () => {
  const before = defectsFrom(verdicts({ failAt: 2 }));
  const worse = verificationDefects({
    contract: SPEC.contract, interactionContract: SPEC.interactionContract, manifest: MANIFEST,
    journeyResults: {
      journeys: [{ id: "booking", title: "Complete a booking", priority: "primary", status: "fail",
        owners: [JOURNEY_OWNER],
        steps: CONTRACT.journeys[0].steps.map((step, index) => ({
          action: step.action, expect: step.expect,
          status: index <= 2 ? "fail" : "not_reached", drove: true,
        })) }],
      blockingErrors: [],
    },
  });
  const progress = defectProgress(before, worse);
  assert.equal(progress.moved, false);
  assert.equal(progress.reason, "regressed");
});

// ── the orchestrated loop ─────────────────────────────────────────────────────────────────────

// An application in a shape the platform did not prescribe, which still satisfies the durable
// ownership gates — so these tests exercise the repair tier rather than the core generation.
const APP = {
  "src/data/store.js": `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "booking", steps: ["guestName", "eventDate", "confirm"] });`,
  "src/routes/Booking.jsx": `import { useSyncExternalStore } from "react";
import { bookings, wizard } from "../data/store.js";
export default function Booking() {
  const state = useSyncExternalStore(wizard.subscribe, wizard.getState);
  return <main>
    <label htmlFor="guestName">Guest Name</label>
    <input id="guestName" name="guestName" value={state.values.guestName || ""} onChange={(e) => { wizard.restore(); wizard.setValue("guestName", e.target.value); }} />
    <label htmlFor="eventDate">Event Date</label>
    <input id="eventDate" name="eventDate" value={state.values.eventDate || ""} onChange={(e) => wizard.select("eventDate", e.target.value)} />
    <button onClick={async () => wizard.confirm(await bookings.createBooking(state.values))}>Confirm booking</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up booking</button>
  </main>;
}`,
  "src/routes/Marketing.jsx": "export default function Marketing() { return <aside>Marketing</aside>; }",
};

const asPatches = (tree) => Object.entries(tree).map(([path, content]) => ({ newFile: path, content }));

function harness({ browser, repairPatches = null, contract = CONTRACT, allPatches = null } = {}) {
  const timeline = [];
  const patchInputs = [];
  let browserCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => contract,
    patchesFn: async (input) => {
      timeline.push(`patch:${input.step}`);
      patchInputs.push(input);
      if (allPatches) return allPatches(input, patchInputs);
      if (input.step === "repair" && repairPatches) return repairPatches(input, patchInputs);
      // An increment adds to a tree the core already wrote, so re-emitting the same files would be
      // refused as inapplicable. It appends instead, which is what a real increment does.
      if (String(input.step).startsWith("increment:")) {
        return [{ replaceFile: "src/routes/Booking.jsx",
          content: `${APP["src/routes/Booking.jsx"]}\n// ${input.step}` }];
      }
      return asPatches(APP);
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async () => ({ ok: true }),
    journeysFn: async ({ journeys }) => { timeline.push("browser"); return browser(browserCalls += 1, journeys); },
    events: {},
    log: () => {},
  });
  return { orchestrator, timeline, patchInputs, browserCalls: () => browserCalls };
}

const failing = () => verdicts({
  failAt: 2,
  step: { status: "fail", drove: true, detail: "expected confirmation; found booking",
    observation: { text: "nothing was confirmed", consoleSince: [], requestsSince: [] } },
});
const passing = () => ({
  journeys: [{ id: "booking", title: "Complete a booking", priority: "primary", status: "pass", steps: [] }],
  blockingErrors: [], consoleErrors: [], failedRequests: [],
});
// A repair that really changes the module the verifier attributed the failure to.
const repairInsideBoundary = (marker) => (input) => {
  const boundary = input.repairBoundary?.allowedFiles || [];
  const target = boundary.includes("src/routes/Booking.jsx") ? "src/routes/Booking.jsx" : "src/data/store.js";
  return [{ replaceFile: target, content: `${APP[target] || ""}\n// ${marker}` }];
};

test("a browser-red journey reaches the repair with its typed defects and its write boundary", async () => {
  const h = harness({
    browser: (call) => (call === 1 ? failing() : passing()),
    repairPatches: repairInsideBoundary("repaired"),
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 2 });

  const repair = h.patchInputs.find((input) => input.step === "repair");
  assert.ok(repair, `no repair dispatch: ${h.timeline.join(" → ")}`);
  assert.ok(repair.repairBoundary, "the repair carries the verifier's attribution as a boundary");
  assert.ok(repair.repairBoundary.allowedFiles.includes("src/routes/Booking.jsx"));
  assert.ok(!repair.repairBoundary.allowedFiles.includes("src/routes/Marketing.jsx"));

  const structured = repair.problems.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  assert.ok(structured.length, "the brief carries structured rows, not only prose");
  assert.equal(structured[0].pageTextWhenItFailed, "nothing was confirmed");
  assert.ok(structured[0].responsibleModules.includes("src/routes/Booking.jsx"));
  assert.ok(structured[0].defectClass && structured[0].owner);

  // …and the repair turned the retained browser defect green.
  assert.equal(result.state, "green", JSON.stringify(result).slice(0, 400));
});

test("a repair that resolves nothing escalates its strategy instead of repeating itself", async () => {
  const h = harness({ browser: () => failing(), repairPatches: repairInsideBoundary("no-op-for-the-defect") });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 3 });

  // `patchInputs` counts every dispatch including buildIncrement's own internal retries, so the
  // round count is read from the result and the STRATEGIES from what each dispatch carried.
  assert.equal(result.repairRounds, 3, "every approved round is used, on a different strategy each time");
  const repairs = h.patchInputs.filter((input) => input.step === "repair");
  // Round 1 is bounded by attribution; round 2 drops the boundary in case attribution was wrong;
  // round 3 forces a clean re-emit of the owning modules. No two rounds are the same attempt.
  assert.ok(repairs.some((input) => input.repairBoundary), "one round is scoped to the attributed modules");
  assert.ok(repairs.some((input) => !input.repairBoundary && !input.regenerateFiles?.length),
    "one round widens past the boundary");
  assert.ok(repairs.some((input) => input.regenerateFiles?.length),
    "one round regenerates the owning modules");
  assert.equal(result.state, "blocked");
  assert.equal(result.failureClassification, "contracted_journeys_red");
  assert.equal(result.repairProgressStop.reason, "unchanged");
  assert.equal(result.repairRounds, 3);
  assert.ok(result.defects.length, "the blocked result carries the typed defect set");
  assert.ok(result.defectClasses.includes(DEFECT_CLASS.DURABILITY)
    || result.defectClasses.includes(DEFECT_CLASS.BEHAVIOUR));
  assert.ok(result.workingSnapshotId, "the retained checkpoint survives the stop");
});

test("a red SECONDARY journey earns the same repair tier the core gets", async () => {
  // The production defect: a secondary got one dispatch and, if red, was filed as pending with no
  // repair at all. Six of them failed that way on a 60-credit build that spent 21.
  const secondaryContract = {
    ...CONTRACT,
    journeys: [
      CONTRACT.journeys[0],
      { id: "review-booking", title: "Review a saved booking", priority: "secondary", steps: [
        { action: "open the saved booking", target: "booking", expect: "the saved booking is shown" },
      ] },
    ],
  };
  const h = harness({
    contract: secondaryContract,
    // The primary passes; the secondary stays red no matter what.
    browser: (call, journeys) => (journeys.some((j) => j.id === "review-booking")
      ? verdicts({ failAt: 0, step: { status: "fail", drove: true, detail: "the saved booking never appeared" } ,
        journeyId: "review-booking" })
      : passing()),
    repairPatches: repairInsideBoundary("secondary-repair"),
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 3 });

  const repairs = h.patchInputs.filter((input) => input.step === "repair");
  assert.ok(repairs.length >= 1, `a red secondary must reach the repair tier: ${h.timeline.join(" → ")}`);
  assert.equal(result.state, "blocked");
  assert.ok(result.repairRounds >= 1, "the rounds are counted and reported");
});

test("a verification platform failure never spends the application's repair allowance", async () => {
  const h = harness({
    browser: () => verdicts({
      failAt: 0, step: { status: "undriveable", detail: "driver error: Target closed" },
      verifierDefects: [{ code: "journey_driver_error", detail: "Target closed" }],
    }),
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 2 });

  assert.equal(result.failureClassification, "verification_platform_defect");
  assert.equal(h.patchInputs.filter((input) => input.step === "repair").length, 0,
    "no repair round may be charged for a platform failure");
});

test("a repair that writes outside the boundary is refused and re-briefed", async () => {
  const h = harness({
    browser: (call) => (call === 1 ? failing() : passing()),
    repairPatches: (input, all) => {
      const priorRepairs = all.filter((row) => row.step === "repair").length;
      // The first attempt reaches outside the attributed modules; the retry stays inside.
      return priorRepairs === 1
        ? [{ replaceFile: "src/routes/Marketing.jsx",
          content: "export default function Marketing() { return <aside>rewritten</aside>; }" }]
        : repairInsideBoundary("repaired-after-refusal")(input);
    },
  });
  await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking", maxRepairs: 2 });

  const repairs = h.patchInputs.filter((input) => input.step === "repair");
  assert.ok(repairs.length >= 2, "the out-of-scope write was refused and the model was asked again");
  const rejection = JSON.stringify(repairs[1].rejections || []);
  assert.match(rejection, /module_correction_scope_exceeded|correction-scope/,
    `the retry states the boundary it broke: ${rejection}`);
});

// ── the repeated no-op loop ───────────────────────────────────────────────────────────────────

test("a repeated no-op names the operation and escalates the file to a whole-file re-emit", async () => {
  // Production, 2026-08-20: the model sent the identical `replace_symbol ROUTES` three rounds
  // running. Each was byte-identical to the file it claimed to change, so the build died on
  // "no substantive generation: 3 consecutive protocol round(s) changed nothing" having written
  // nothing at all. The feedback said only that the batch was byte-identical — it never named the
  // operation, and no-ops never reached the escalation ladder, so repeating one cost nothing.
  const scaffold = fromScaffold(REACT_VITE);
  const current = scaffold["src/routes/HomePage.jsx"];
  assert.ok(current, "the scaffold ships a HomePage to re-emit");
  const seen = [];
  const h = harness({
    browser: () => passing(),
    // Re-emit the file's OWN current content: the batch applies cleanly and changes nothing.
    allPatches: (input) => {
      seen.push(input);
      return [{ replaceFile: "src/routes/HomePage.jsx", content: current }];
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });

  assert.equal(result.state, "blocked");
  assert.match(result.error, /no substantive generation/);

  // The rejection fed back names the exact operation, so the next round can see what to avoid.
  const withRejections = seen.filter((input) => (input.rejections || []).length);
  assert.ok(withRejections.length, "the no-op was fed back at all");
  const reason = String(withRejections.at(-1).rejections[0].reason);
  assert.ok(reason.includes("src/routes/HomePage.jsx"), `the file is named: ${reason}`);
  assert.match(reason, /ALREADY contains exactly that content/);
  assert.match(reason, /Do not send them again/);

  // …and by the second identical no-op the file is queued for a whole-file re-emit.
  const regenerating = seen.filter((input) => (input.regenerateFiles || []).includes("src/routes/HomePage.jsx"));
  assert.ok(regenerating.length, "a repeatedly no-op'd file escalates to whole-file regeneration");
});
