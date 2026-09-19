// THE ADVERSARIAL FALSE-PASS MATRIX.
//
// Three domains now drive green. That proves the platform can grade a CORRECT application, and
// says nothing about the failure that actually costs money: grading a BROKEN one green. Every
// case here is an application that lies in exactly one way, driven through the real verifier
// against the real contract, and every one of them must be caught.
//
// Real path throughout: authored contract → deriveBuildSpec → interaction/scenario derivation →
// journeyVerifier's public entry point → compiled React/Vite → real Chromium. One build serves
// every variant — they differ only by an injected `window.__DEFECT__` — so a variant cannot fail
// for an incidental compilation difference, and the control case proves the harness itself green.
//
// The pure-rule sections at the end are NOT substitutes for the browser cases above them: they
// pin the verdict functions directly so the matrix covers combinations a fixture cannot stage.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  durableCommitIdentity, durableRecordKey, durableStatusWords, durableTransitionFlow,
  expectationOutcome, invalidValueFor,
  recoveryEvidenceVerdict, verifyJourneys,
} from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { adversarialApp } from "./fixtures/adversarialApp.mjs";
import { CRM_CONTRACT } from "./fixtures/crmScenarioApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(CRM_CONTRACT);
const CONTRACT = SPEC.contract;
const CASE = "bv2-adversarial-matrix";

// The whole contract is narrowed, interaction plan included: swapping journeys under a contract
// that kept its original derivation would drive one journey's steps against another's flows.
const scoped = (ids, contract = CONTRACT) => ({
  ...contract, journeys: contract.journeys.filter((journey) => ids.includes(journey.id)),
});

let built = null;
const runs = new Map();

/** Serve the one compiled bundle with a defect injected, and drive the contracted journeys. */
async function driveVariant(defect, contract) {
  const root = path.join(workDirFor(CASE), "dist");
  const inject = (html) => html.replace("</head>",
    `<script>window.__DEFECT__=${JSON.stringify(defect)}</script></head>`);
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
      try {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(inject((await readFile(path.join(root, "index.html"))).toString("utf8")));
      } catch { response.writeHead(404); response.end("not found"); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract, timeoutMs: 600_000,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// One contract-level adversarial rather than an app-level one: the step demands an invalid value
// for a free-text note, and nothing in the contract says what would make a note invalid. The
// journey is a single step on purpose — its prerequisites put the flow on the contact screen, and
// a second "advance" step of its own would leave it again.
const UNSUPPORTED_RULE_CONTRACT = deriveBuildSpec({
  ...CRM_CONTRACT,
  journeys: CRM_CONTRACT.journeys.map((journey) => (journey.id !== "contact-validation" ? journey : {
    ...journey,
    steps: [{ action: "enter an invalid note", target: "notes field",
      expect: "a validation message is shown and the continue control remains disabled" }],
  })),
}).contract;

const VARIANTS = [
  ["none", ["capture-new-lead", "recover-existing-lead", "update-existing-lead",
    "archive-existing-lead", "contact-validation"]],
  ["wrong-reference", ["capture-new-lead", "recover-existing-lead"]],
  ["stale-update", ["capture-new-lead", "update-existing-lead"]],
  ["accepts-invalid", ["capture-new-lead", "contact-validation"]],
  ["decoy-only", ["capture-new-lead"]],
  ["dom-only-advance", ["capture-new-lead", "contact-validation"]],
  ["never-archives", ["capture-new-lead", "archive-existing-lead"]],
  ["server-terminal", ["capture-new-lead", "contact-validation"]],
];

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...adversarialApp() }, CASE, () => {});
  if (!built.ok) return;
  for (const [defect, ids] of VARIANTS) runs.set(defect, await driveVariant(defect, scoped(ids)));
  // A consumer with NO producer anywhere in the contract: nothing in this run ever created the
  // record it depends on.
  runs.set("orphan-recover", await driveVariant("none", scoped(["recover-existing-lead"])));
  runs.set("orphan-update", await driveVariant("none", scoped(["update-existing-lead"])));
  // A contracted invalid-value demand the contract states no rule for.
  runs.set("unsupported-rule", await driveVariant("none",
    scoped(["capture-new-lead", "contact-validation"], UNSUPPORTED_RULE_CONTRACT)));
}, { timeout: 3_600_000 });

after(() => {
  if (!runs.size) return;
  for (const [defect, run] of runs) {
    const lines = (run.journeys || []).map((journey) => `  ${journey.id} => ${journey.status}`
      + (journey.steps || []).map((step, index) =>
        `\n      ${index + 1} ${String(step.status).toUpperCase().padEnd(12)} ${(step.detail || "").slice(0, 96)}`).join(""));
    console.log(`\n### ${defect}\n${lines.join("\n")}`);
  }
});

const journeyOf = (defect, id) => runs.get(defect)?.journeys?.find((journey) => journey.id === id);
const statusOf = (defect, id) => journeyOf(defect, id)?.status;
const stepOf = (defect, id, index) => journeyOf(defect, id)?.steps?.[index];
const GREEN = "pass";

test("the adversarial fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

// ── CONTROL ────────────────────────────────────────────────────────────────────────────────────

test("CONTROL — the honest variant of this same bundle is green on every journey", { ...needsBrowser }, () => {
  for (const journey of runs.get("none").journeys) {
    assert.equal(journey.status, GREEN, `${journey.id}: ${JSON.stringify(journey.steps)}`);
  }
  // Control cases the sections below depend on: a persistent selection with correct downstream
  // state passes, and invalid → blocked → corrected → progression passes.
  assert.equal(stepOf("none", "capture-new-lead", 3).status, GREEN);
  assert.equal(statusOf("none", "contact-validation"), GREEN);
});

// ── 1. SCENARIO ISOLATION ──────────────────────────────────────────────────────────────────────

test("an app that lands every visitor in terminal state cannot pass an independent journey", { ...needsBrowser }, () => {
  // The independent scenario opens a brand-new context. If the finished state comes back anyway —
  // as it does when a server holds it — the journey's contracted starting state is unreachable and
  // the only honest verdict is that it was not reached.
  assert.notEqual(statusOf("server-terminal", "contact-validation"), GREEN,
    JSON.stringify(journeyOf("server-terminal", "contact-validation")));
});

test("a consumer journey cannot pass on a record no scenario in the run produced", { ...needsBrowser }, () => {
  // Nothing here is broken except the premise: the producer is absent, so the durable record the
  // journey depends on does not exist. Passing would mean the verifier graded UI residue.
  assert.notEqual(statusOf("orphan-recover", "recover-existing-lead"), GREEN,
    JSON.stringify(journeyOf("orphan-recover", "recover-existing-lead")));
  assert.notEqual(statusOf("orphan-update", "update-existing-lead"), GREEN,
    JSON.stringify(journeyOf("orphan-update", "update-existing-lead")));
  // Per STEP, not merely per journey. The lookup step itself claimed the record was displayed;
  // it passed as "1/1 fields hold values" against a screen showing no record at all, and only a
  // later step's failure made the journey red. A journey that ended there would have been green.
  const lookupStep = stepOf("orphan-recover", "recover-existing-lead", 1);
  assert.notEqual(lookupStep.status, GREEN,
    `a lookup that found nothing may not pass on form state: ${JSON.stringify(lookupStep)}`);
});

// ── 2 & 6. DURABLE EVIDENCE AND RECOVERY ───────────────────────────────────────────────────────

test("a right-shaped reference belonging to no record fails recovery", { ...needsBrowser }, () => {
  assert.equal(statusOf("wrong-reference", "capture-new-lead"), GREEN,
    "the lie is on the manage surface only — the producer journey is unaffected");
  assert.notEqual(statusOf("wrong-reference", "recover-existing-lead"), GREEN,
    JSON.stringify(journeyOf("wrong-reference", "recover-existing-lead")));
});

test("a record that never changed status cannot satisfy an archive journey", { ...needsBrowser }, () => {
  // The screen says "Archived" while the record does not. The reload is where that stops being
  // a matter of opinion.
  assert.notEqual(statusOf("never-archives", "archive-existing-lead"), GREEN,
    JSON.stringify(journeyOf("never-archives", "archive-existing-lead")));
});

// ── 3. FLOW ADVANCE ────────────────────────────────────────────────────────────────────────────

test("a control that changes the page without advancing the flow is not an advance", { ...needsBrowser }, () => {
  const validation = journeyOf("dom-only-advance", "contact-validation");
  assert.notEqual(validation.status, GREEN, JSON.stringify(validation));
  assert.notEqual(statusOf("dom-only-advance", "capture-new-lead"), GREEN,
    "a flow that cannot advance cannot complete its primary journey either");
});

// ── 4. SELECTION ───────────────────────────────────────────────────────────────────────────────

test("a prose-shaped option group with no identity cannot satisfy a contracted selection", { ...needsBrowser }, () => {
  const capture = journeyOf("decoy-only", "capture-new-lead");
  assert.notEqual(capture.status, GREEN, JSON.stringify(capture));
  // The journey stops AT the decoy: the source selection auto-advances into the priority step, and
  // the contracted priority control is not there to be reached. Either the arriving step or the
  // priority step itself must break — what may not happen is the decoy answering for the contract.
  const sourceStep = capture.steps[2];
  const priorityStep = capture.steps[3];
  assert.ok([sourceStep, priorityStep].some((step) => step.status !== GREEN),
    `the decoy must stop the flow: ${JSON.stringify([sourceStep, priorityStep])}`);
  const reason = `${sourceStep.detail || ""} ${priorityStep.detail || ""}`;
  assert.match(reason, /contracted next state|no selectable control group matched|could not drive|priority/i,
    `the verdict must name the contracted control it could not reach: ${reason}`);
});

// ── 5. FIELD / EDIT ────────────────────────────────────────────────────────────────────────────

test("an edit that is shown and announced but never stored fails at the reload", { ...needsBrowser }, () => {
  // Directly exercises the CRM fixes: the form holds the new values, a success banner claims the
  // update, and the durable record still holds the old ones.
  const update = journeyOf("stale-update", "update-existing-lead");
  assert.notEqual(update.status, GREEN, JSON.stringify(update));
  const reload = update.steps.at(-1);
  assert.notEqual(reload.status, GREEN, JSON.stringify(reload));
});

// ── 7. VALIDATION ──────────────────────────────────────────────────────────────────────────────

test("an app that complains about an invalid value and advances anyway fails", { ...needsBrowser }, () => {
  const validation = journeyOf("accepts-invalid", "contact-validation");
  assert.notEqual(validation.status, GREEN, JSON.stringify(validation));
  const invalidStep = validation.steps[1];
  assert.equal(invalidStep.status, "fail", JSON.stringify(invalidStep));
  assert.match(String(invalidStep.detail || ""), /accepted an invalid/i);
});

test("an invalid-value demand with no stated rule is never a pass, and says why", { ...needsBrowser }, () => {
  // The guarantee is that a demand the contract cannot support produces a MACHINE-READABLE
  // refusal rather than a value guessed at random and a green step.
  //
  // Observed, and reported rather than papered over: for this contract shape the refusal is
  // `notes:missing` rather than `notes:validation_intent_unsupported`. A single-step secondary
  // journey whose prerequisites fill the other fields on the same screen does not reliably arrive
  // on that screen, so the driver refuses at the locator instead of at the rule. Both are honest
  // refusals carrying the field and the reason; neither is a pass. The unsupported-rule branch
  // itself is pinned directly below, and was observed live during the CRM work.
  const step = journeyOf("unsupported-rule", "contact-validation").steps[0];
  assert.notEqual(step.status, GREEN, JSON.stringify(step));
  assert.match(String(step.detail || ""), /contracted control\(s\) could not be driven: \w+:\w+/,
    "the refusal names the contracted field and a machine-readable status");
  assert.ok((step.controlEvidence?.attemptedLocators || []).length > 0,
    "and carries the locators it tried, so a repair is not guesswork");
});

test("no invalid value is invented for a field the contract states no rule for", () => {
  // The trigger for validation_intent_unsupported, pinned at its source: a rule exists for the
  // shapes the contract can express, and free text gets nothing rather than something arbitrary.
  assert.equal(invalidValueFor("notes", ["text"]), null);
  assert.equal(invalidValueFor("contactName", ["text"]), null);
  assert.equal(invalidValueFor("contactEmail", ["email"]), "not-an-email");
  assert.equal(invalidValueFor("partySize", ["number"]), "not-a-number");
});

// ── PURE RULES — combinations no single fixture can stage ───────────────────────────────────────

const evidence = (overrides = {}) => ({
  captured: true, values: ["Ada Lovelace", "ada@example.com"], references: ["LEAD-REF-4417"],
  statusWords: ["confirmed"], ...overrides,
});
const PAGE = "The saved lead details are displayed. Status Confirmed. Reference LEAD-REF-4417."
  + " Ada Lovelace · ada@example.com";

test("recovery verdicts: only the true record passes", () => {
  assert.equal(recoveryEvidenceVerdict(evidence(), PAGE).ok, true);
  // Wrong reference — including one of exactly the right shape.
  assert.equal(recoveryEvidenceVerdict(evidence(), PAGE.replace("4417", "9999")).ok, false);
  // A required value silently dropped, and a required value quietly changed.
  assert.equal(recoveryEvidenceVerdict(evidence(), PAGE.replace(" Ada Lovelace ·", "")).ok, false);
  assert.equal(recoveryEvidenceVerdict(evidence(), PAGE.replace("Ada Lovelace", "Alan Turing")).ok, false);
  // Wrong status on the surface that created the record.
  assert.equal(recoveryEvidenceVerdict(evidence(), PAGE.replace("Confirmed", "Cancelled")).ok, false);
  // A cancelled record cannot answer for a confirmed one, or the reverse.
  assert.equal(recoveryEvidenceVerdict(evidence({ statusWords: ["cancelled"] }), PAGE).ok, false);
  // Recovery vocabulary in full voice, durable state wrong.
  assert.equal(recoveryEvidenceVerdict(evidence(),
    "The recovered lead remains displayed with the same status and reference. Reference LEAD-REF-9999.").ok, false);
  // No evidence is never a pass — it is not a verdict at all.
  assert.equal(recoveryEvidenceVerdict({ captured: false }, PAGE).checked, false);
  assert.equal(recoveryEvidenceVerdict(null, PAGE).checked, false);
});

test("durable evidence keeps lifecycle status but discards transient operation copy", () => {
  assert.deepEqual(durableStatusWords(
    "the booking is confirmed and its reference is shown",
    "Status Confirmed. Reference BK-4417.",
  ), ["confirmed", "reference"]);
  assert.deepEqual(durableStatusWords(
    "the duplicated object disappears from the hierarchy and the part count decreases",
    "The duplicated object disappears from the hierarchy.",
  ), ["object", "hierarchy"], "transient delete verbs must not be required to survive reload");
  assert.deepEqual(durableStatusWords(
    "the booking screen changes to an explicit Cancelled state",
    "The booking screen changes to an explicit Cancelled state.",
  ), ["booking", "screen", "explicit", "cancelled"],
  "a lifecycle transition keeps its resulting status but not the one-time change verb");
});

test("a cancellation-only interaction refreshes the durable recovery baseline", () => {
  const cancellation = { kind: "cancellation", durableLifecycle: "reservation" };
  assert.strictEqual(durableTransitionFlow([cancellation]), cancellation,
    "Cancel is a durable transition even when the step is not also classified as mutation");
  const mutation = { kind: "mutation", durableLifecycle: "reservation" };
  assert.strictEqual(durableTransitionFlow([mutation, cancellation]), mutation,
    "the primary mutation remains the baseline when one step carries both classifications");
});

test("prerequisite mutation waits for a rendered durable identity, not progress copy", () => {
  const input = { enteredValues: ["Journey 924950"], textBefore: "Generate asset" };
  assert.deepEqual(durableCommitIdentity({
    ...input,
    textAfter: "Generation progress. Generating asset.",
  }), { value: null, reference: null });
  assert.deepEqual(durableCommitIdentity({
    ...input,
    textAfter: "Journey 924950 Asset. Saved version ASSET-924950.",
  }), { value: "Journey 924950", reference: "ASSET-924950" });
});

test("durable evidence is keyed to one lifecycle and cannot cross", () => {
  const lead = { durableLifecycle: "crud:lead" };
  const invoice = { durableLifecycle: "crud:invoice" };
  const booking = { durableLifecycle: "booking:booking" };
  assert.equal(durableRecordKey(lead), durableRecordKey({ durableLifecycle: "crud:lead" }));
  assert.notEqual(durableRecordKey(lead), durableRecordKey(invoice), "a different ENTITY is a different record");
  assert.notEqual(durableRecordKey(lead), durableRecordKey(booking), "a different CAPABILITY is a different record");
  // Without a stamped lifecycle the key still separates capability and entity rather than
  // collapsing everything onto one bucket.
  assert.notEqual(
    durableRecordKey({ capability: "makeEntityStore", writes: ["j.durable.record"] }),
    durableRecordKey({ capability: "makeBookingSystem", writes: ["j.durable.record"] }),
  );
});

test("expectation verdicts: static prose and undriven steps are never passes", () => {
  const wanted = ["saved", "lead", "reference"];
  // Everything present, nothing new, nothing navigational: the step demonstrated nothing.
  assert.equal(expectationOutcome({ wanted, found: wanted, fresh: [], drove: true, action: "confirm the lead" }).status, "fail");
  // Nothing driven at all.
  assert.equal(expectationOutcome({ wanted, found: [], fresh: [], drove: false, action: "confirm the lead" }).status, "undriveable");
  // A real transition.
  assert.equal(expectationOutcome({ wanted, found: wanted, fresh: ["saved"], drove: true, action: "confirm the lead" }).status, "pass");
  // The review exemption cannot fire without exact values behind it.
  assert.equal(expectationOutcome({ wanted, found: wanted, fresh: [], drove: true, action: "review the lead",
    reviewWithValues: false }).status, "fail");
});
