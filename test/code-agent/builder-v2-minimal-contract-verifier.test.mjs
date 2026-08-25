import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import {
  expectationOutcome, isObservationOnlyStep, verifyJourneys,
} from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { verifyApp } from "../../shell/server/lib/appBuild/verificationAgent.mjs";
import {
  MINIMAL_CONTRACT_VERIFIER_POLICY,
  VERIFICATION_RESULT_CLASS,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import {
  actionableDefects, platformDefectsOf, verificationDefects,
} from "../../shell/server/lib/builderV2/verificationDefects.mjs";

const requireCjs = createRequire(import.meta.url);
let browserAvailable = true;
try { requireCjs("playwright"); } catch { browserAvailable = false; }
const needsBrowser = { skip: browserAvailable ? false : "requires playwright" };

let server;
let baseUrl;
let pageBody = "";

before(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(pageBody);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

const control = (logicalField, machineId, roles = ["textbox"]) => ({
  logicalField, accessibleName: logicalField.replace(/([A-Z])/g, " $1").trim(),
  accessibleNames: [logicalField.replace(/([A-Z])/g, " $1").trim()],
  machineId, roles, statePath: `journey.${logicalField}`,
});

function contractFor(step, flows = []) {
  return {
    journeys: [{ id: "journey", title: "Minimal contract journey", priority: "primary", steps: [step] }],
    interactionContract: { flows: flows.map((flow) => ({
      journeyId: "journey", stepIndex: 0, stateOwner: "src/App.jsx",
      responsibleModules: ["src/App.jsx"], reads: [], writes: [], ...flow,
    })) },
  };
}

async function run(html, step, flows = []) {
  pageBody = html;
  return verifyJourneys({
    previewUrl: baseUrl,
    contract: contractFor(step, flows),
    timeoutMs: 35_000,
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
}

test("minimal_contract_v1 keeps only contract outcome evidence blocking", async () => {
  const visible = expectationOutcome({
    wanted: ["confirmation", "visible"], found: ["confirmation", "visible"], fresh: [],
    drove: true, action: "save", verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
  assert.equal(visible.classification, VERIFICATION_RESULT_CLASS.PASS);

  const uncertain = expectationOutcome({
    wanted: ["competition", "cards"], found: [], fresh: [], drove: false,
    action: "view competitions", readOnlyAssertion: true,
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
  assert.equal(uncertain.classification, VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE);

  const broken = expectationOutcome({
    wanted: ["confirmation"], found: [], fresh: [], drove: true, actionProven: true,
    action: "submit", verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
  assert.equal(broken.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
});

test("observation steps require no control identity", () => {
  assert.equal(isObservationOnlyStep({
    action: "view live competitions", expect: "competition cards are visible", reads: ["competitions"],
  }, [], { verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY }), true);
  assert.equal(isObservationOnlyStep({
    action: "review and submit the order", expect: "order confirmation is visible",
  }, [], { verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY }), false);
});

test("retained false negatives and concrete failures classify correctly in a real browser",
  { ...needsBrowser, timeout: 240_000 }, async (t) => {
    await t.test("already-visible observation passes without a control", async () => {
      const result = await run("<main><h1>Live competitions</h1><p>Competition cards are visible</p></main>",
        { action: "view live competitions", expect: "competition cards are visible", reads: ["competitions"] });
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].drove, false);
    });

    await t.test("a pre-populated accepted input is not rejected for starting correct", async () => {
      const field = { ...control("displayName", "display-name"), verificationValue: "Preset value" };
      const result = await run(`<main><label>display Name
          <input data-thrallo-control="display-name" value="Preset value"></label>
          <p>Accepted value is visible</p></main>`,
      { action: "enter the display name", operates: ["displayName"], expect: "accepted value is visible" },
      [{ kind: "input", valueWritten: "displayName", control: field }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].alreadyAccepted, true);
    });

    await t.test("numeric and checkbox fixtures use native control types", async () => {
      const amount = { ...control("quantity", "quantity"), valueType: "number" };
      const enabled = { ...control("enabled", "enabled"), valueType: "boolean" };
      const result = await run(`<main><label>quantity <input data-thrallo-control="quantity"
          type="number" min="2" max="10" step="2" value="2"></label>
          <label>enabled <input data-thrallo-control="enabled" type="checkbox"></label>
          <p>Values are accepted</p></main>`,
      { action: "enter quantity and choose enabled", operates: ["quantity", "enabled"],
        expect: "values are accepted" }, [
        { kind: "input", valueWritten: "quantity", control: amount },
        { kind: "input", valueWritten: "enabled", control: enabled },
      ]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const fields = result.journeys[0].steps[0].controlEvidence.fields;
      assert.equal(fields.find((row) => row.field === "quantity").expectedValue, "4");
      assert.equal(fields.find((row) => row.field === "enabled").observedValue, "true");
    });

    await t.test("unchanged wording does not fail a satisfied result", async () => {
      const action = control("save", "save", ["button"]);
      const result = await run(`<main><button data-thrallo-action="save">Save</button>
          <p>Saved confirmation is visible</p></main>`,
      { action: "click save", expect: "saved confirmation is visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.ok(result.journeys[0].steps[0].advisories?.some((row) => row.code === "text_freshness_not_observed"));
    });

    await t.test("ambiguous machine identity may fall through to one reliable semantic locator", async () => {
      const action = control("save project", "shared-action", ["button"]);
      const result = await run(`<main>
        <button data-thrallo-action="shared-action" aria-label="Save project"
          onclick="document.getElementById('out').textContent='Project saved result visible'">Save</button>
        <button data-thrallo-action="shared-action" aria-label="Archive">Archive</button>
        <p id="out"></p></main>`,
      { action: "click save project", expect: "project saved result visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
    });

    await t.test("repeated collection entries drive one stable flow-entry candidate", async () => {
      const entry = {
        ...control("competitionId", "featured-card", ["button", "link"]),
        accessibleName: "featured competition card",
        accessibleNames: ["featured competition card"],
        flowEntry: true,
      };
      const result = await run(`<main>
        <button aria-label="featured competition card"
          onclick="document.getElementById('out').textContent='Competition detail prize title ticket price Enter Now'">First competition</button>
        <button aria-label="featured competition card"
          onclick="document.getElementById('out').textContent='Competition detail prize title ticket price Enter Now'">Second competition</button>
        <p id="out"></p></main>`,
      { action: "open a featured competition detail",
        expect: "competition detail prize title ticket price Enter Now" },
      [{ kind: "flow_start", valueWritten: "competitionId", control: entry }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.equivalentCandidates, 2);
    });

    await t.test("repeated ordinary commit actions remain inconclusive", async () => {
      const action = control("save project", "missing-save-identity", ["button"]);
      const result = await run(`<main>
        <button aria-label="save project">Save one</button>
        <button aria-label="save project">Save two</button>
        <p id="out"></p></main>`,
      { action: "click save project", expect: "project saved result visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification,
        VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE, JSON.stringify(result.journeys));
    });

    await t.test("an unlocatable control is platform-inconclusive and cannot request repair", async () => {
      const action = control("save project", "missing-action", ["button"]);
      const contract = contractFor({ action: "click save project", expect: "project saved result visible" },
        [{ kind: "action", control: action }]);
      pageBody = "<main><h1>Project</h1></main>";
      const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY });
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE);
      const defects = verificationDefects({ contract, journeyResults: result });
      assert.equal(actionableDefects(defects).length, 0, JSON.stringify(defects));
      assert.ok(platformDefectsOf(defects).length > 0, JSON.stringify(defects));
    });

    await t.test("a real dead button is an app-functional failure", async () => {
      const action = control("save project", "save-project", ["button"]);
      const result = await run("<main><button data-thrallo-action=\"save-project\">Save project</button><p id=out></p></main>",
        { action: "click save project", expect: "project saved result visible" },
        [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
    });

    await t.test("a real wrong state transition is an app-functional failure", async () => {
      const action = control("complete project", "complete-project", ["button"]);
      const result = await run(`<main><button data-thrallo-action="complete-project"
          onclick="document.getElementById('out').textContent='Still editing'">Complete project</button>
          <p id="out"></p></main>`,
      { action: "click complete project", expect: "project completion result visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
        JSON.stringify(result.journeys));
    });

    await t.test("a fatal ReferenceError that breaks the required action is fatal-runtime", async () => {
      const action = control("calculate", "calculate", ["button"]);
      const result = await run(`<main><button data-thrallo-action="calculate"
          onclick="missingCalculation()">Calculate</button><p id=out></p></main>`,
      { action: "click calculate", expect: "calculation result visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE,
        JSON.stringify(result.journeys));
      assert.ok(result.fatalErrors.some((detail) => /missingCalculation/.test(detail)));
    });

    await t.test("a fatal mount error that prevents the required surface is fatal-runtime", async () => {
      const action = control("continue", "continue", ["button"]);
      const result = await run("<script>missingInitialRender()</script><main><h1>Loading</h1></main>",
        { action: "click continue", expect: "next screen visible" },
        [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE,
        JSON.stringify(result.journeys));
      assert.ok(result.fatalErrors.some((detail) => /missingInitialRender/.test(detail)));
    });

    await t.test("a real save/reload failure is persistence failure", async () => {
      pageBody = `<main><label>record Title <input data-thrallo-control="record-title"></label>
        <button data-thrallo-action="save-record" onclick="document.getElementById('out').textContent =
          'Saved record visible ' + document.querySelector('input').value + ' REC-1'">Save record</button>
        <p id="out"></p></main>`;
      const title = { ...control("recordTitle", "record-title"), verificationValue: "Record A" };
      const save = control("save record", "save-record", ["button"]);
      const durableLifecycle = "journey:record";
      const contract = {
        journeys: [{ id: "journey", title: "Save and reopen", priority: "primary", steps: [
          { action: "enter the record title and save", operates: ["recordTitle"],
            expect: "saved record visible" },
          { action: "reload the application", reads: ["record.durable.record"],
            expect: "saved record visible" },
        ] }],
        interactionContract: { flows: [
          { journeyId: "journey", stepIndex: 0, kind: "input", valueWritten: "recordTitle",
            stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], control: title,
            reads: [], writes: ["journey.draft.recordTitle"] },
          { journeyId: "journey", stepIndex: 0, kind: "mutation", durableLifecycle,
            stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], control: save,
            reads: ["journey.draft.recordTitle"], writes: ["journey.durable.record"] },
          { journeyId: "journey", stepIndex: 1, kind: "recovery", durableLifecycle,
            stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], control: null,
            reads: ["journey.durable.record"], writes: ["journey.restored"] },
        ] },
      };
      const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 45_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY });
      assert.equal(result.journeys[0].steps[1].classification,
        VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE, JSON.stringify(result.journeys, null, 2));
    });

    await t.test("non-fatal console and network noise is advisory", async () => {
      const result = await run(`<main><h1>Dashboard result visible</h1>
        <script>console.warn('layout hint'); console.error('optional analytics failed')</script></main>`,
      { action: "view dashboard", expect: "dashboard result visible", reads: ["dashboard"] });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.fatalErrors.length, 0);
      assert.ok(result.advisories.some((row) => /console/.test(row.code)));
    });

    await t.test("missing domain fixture is inconclusive instead of invented", async () => {
      const answer = { ...control("skillAnswer", "skill-answer"), requiresVerificationFixture: true };
      const result = await run(`<main><label>skill Answer
          <input data-thrallo-control="skill-answer"></label></main>`,
      { action: "enter the correct skill answer", operates: ["skillAnswer"],
        expect: "correct answer is accepted" },
      [{ kind: "input", valueWritten: "skillAnswer", control: answer }]);
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE);
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].status, "fixture_unavailable");
    });

    await t.test("generic smoke does not invent auth or CRUD requirements", async () => {
      pageBody = "<main><h1>Simple content application</h1></main>";
      const result = await verifyApp({ previewUrl: baseUrl, usesBackend: true,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY, timeoutMs: 20_000 });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.checks.some((row) => row.id === "signup"), false);
    });
  });

test("minimal result classes route only concrete app failures to repair", () => {
  const base = {
    id: "journey", title: "Save", priority: "primary", owners: ["src/App.jsx"],
    steps: [{ action: "save", expect: "saved", drove: true, status: "fail",
      classification: VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE, detail: "record did not survive reload" }],
    status: "fail", classification: VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE,
  };
  const contract = contractFor({ action: "save", expect: "saved" }, [{ kind: "recovery" }]);
  const defects = verificationDefects({ contract, journeyResults: {
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY, journeys: [base],
  } });
  assert.equal(actionableDefects(defects).length, 1, JSON.stringify(defects));
  assert.equal(defects[0].defectClass, "durability");

  const advisoryOnly = verificationDefects({ contract, journeyResults: {
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    journeys: [{ id: "journey", title: "Save", priority: "primary", status: "pass", steps: [] }],
    mechanics: { failures: [{ id: "unreached-control", expected: "changed", observed: "unchanged" }] },
  } });
  assert.deepEqual(advisoryOnly, [], "an advisory mechanics probe cannot create an app repair");
});

test("the verifier policy is durable and historical interpretation is unchanged", async () => {
  const migration = await readFile(new URL("../../supabase/migrations/20260825105631_add_bv2_minimal_verifier_policy.sql",
    import.meta.url), "utf8");
  assert.match(migration, /default 'legacy_rich_v1'/i);
  assert.match(migration, /minimal_contract_v1/i);
  const orchestrator = await readFile(new URL("../../shell/server/lib/builderV2/orchestrator.mjs", import.meta.url), "utf8");
  assert.equal((orchestrator.match(/verifier_policy: MINIMAL_CONTRACT_VERIFIER_POLICY/g) || []).length, 4);
});
