import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import {
  controlResetTransition, expectationOutcome, expectationRequestsControlReset,
  isObservationOnlyStep, requestsSingleCollectionMemberAction, verifyJourneys,
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

test("explicit reset expectations accept a proven native control reset", () => {
  const expect = "the empty state disappears, the search box is blank, filters return to their all-options values, and the default software cards are visible again";
  assert.equal(expectationRequestsControlReset(expect), true);
  assert.equal(expectationRequestsControlReset("the result card appears"), false);
  const reset = controlResetTransition(
    [{ key: "input:search:0", type: "search", value: "no-match", selectedIndex: -1, checked: false }],
    [{ key: "input:search:0", type: "search", value: "", selectedIndex: -1, checked: false }],
  );
  assert.equal(reset.ok, true);
  const outcome = expectationOutcome({
    wanted: ["empty", "state", "disappears", "search", "box"], found: [], fresh: [],
    drove: true, actionProven: true, stateChanged: reset.ok, action: "clear filters",
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
  assert.equal(outcome.classification, VERIFICATION_RESULT_CLASS.PASS);
});

test("an enumerated selection that omits the exact fixture is an app-repairable defect", () => {
  const selection = { ...control("selectedItemId", "selected-item", ["button", "radio", "option", "combobox"]),
    verificationValue: "catalogue-item-1", selectedState: true };
  const step = { action: "select the matching catalogue item", operates: ["selectedItemId"],
    expect: "the item detail panel is visible" };
  const contract = contractFor(step, [{ id: "journey:1:selection:selecteditemid", kind: "selection",
    valueWritten: "selectedItemId", control: selection }]);
  const defects = verificationDefects({ contract, interactionContract: contract.interactionContract,
    journeyResults: {
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      journeys: [{ id: "journey", title: "Minimal contract journey", priority: "primary",
        owners: ["src/App.jsx"], status: "undriveable", steps: [{ ...step, status: "undriveable",
          drove: false, classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
          detail: "the contracted verification value \"catalogue-item-1\" is not an available option",
          controlEvidence: { contractedField: "selectedItemId", fixtureAuthority: "contract",
            verificationValue: "catalogue-item-1",
            selectedOptions: [{ text: "Catalogue Item One", label: "selected Item Id", value: null,
              selected: false }] } }] }],
    } });
  assert.equal(defects[0].defectClass, "interaction", JSON.stringify(defects));
  assert.equal(defects[0].owner, "app", JSON.stringify(defects));
  assert.equal(defects[0].tier, "repair", JSON.stringify(defects));
  assert.equal(actionableDefects(defects).length, 1);
  assert.equal(platformDefectsOf(defects).length, 0);
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

    await t.test("a clear action is proven by a non-default input returning to blank", async () => {
      const clear = control("clear filters control", "clear-filters", ["button"]);
      const result = await run(`<main><label>search Query
          <input id="query" type="search" value="no-match"></label>
          <button data-thrallo-action="clear-filters" onclick="document.getElementById('query').value=''; document.getElementById('empty').hidden=true; document.getElementById('results').hidden=false">Clear filters</button>
          <p id="empty">No software matches the current search.</p>
          <section id="results" hidden><h2>Software cards</h2><p>Default catalogue item</p></section></main>`,
      { action: "clear the current search and filters",
        expect: "the full software card grid returns and the no-results empty state is hidden" },
      [{ kind: "action", operationId: "clear-catalogue-filters", control: clear }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.resetTransition.ok, true);
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

    await t.test("native select inputs use an enabled option instead of an invented text fixture", async () => {
      const category = { ...control("categoryFilter", "category-filter", ["combobox"]),
        valueType: "string" };
      const result = await run(`<main><label>Category
          <select data-thrallo-control="category-filter"
            onchange="document.getElementById('out').textContent='Filtered software results are visible'">
            <option value="">All software</option><option value="editor">Editors</option>
            <option value="testing">Testing</option>
          </select></label><p id="out"></p></main>`,
      { action: "filter the software catalogue", operates: ["categoryFilter"],
        expect: "filtered software results are visible" },
      [{ kind: "input", valueWritten: "categoryFilter", control: category }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const field = result.journeys[0].steps[0].controlEvidence.fields[0];
      assert.equal(field.expectedValue, "editor");
      assert.equal(field.observedValue, "editor");
    });

    await t.test("a native select already holding its contracted option is accepted", async () => {
      const category = { ...control("categoryFilter", "category-filter", ["combobox"]),
        valueType: "string", verificationValue: "testing" };
      const result = await run(`<main><label>Category
          <select data-thrallo-control="category-filter">
            <option value="editor">Editors</option><option value="testing" selected>Testing</option>
          </select></label><p>Filtered software results are visible</p></main>`,
      { action: "filter the software catalogue", operates: ["categoryFilter"],
        expect: "filtered software results are visible" },
      [{ kind: "input", valueWritten: "categoryFilter", control: category }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].alreadyAccepted, true);
    });

    await t.test("selection journeys drive an identity-bound native select", async () => {
      const category = { ...control("categoryFilter", "category-filter", ["combobox"]),
        valueType: "string", verificationValue: "testing", selectedState: true };
      const result = await run(`<main><label>Category
          <select data-thrallo-control="category-filter"
            onchange="document.getElementById('out').textContent='Selected category value is displayed'">
            <option value="" disabled>Select a category</option><option value="editor">Editors</option>
            <option value="testing">Testing</option>
          </select></label><p id="out"></p></main>`,
      { action: "choose a category filter", operates: ["categoryFilter"],
        expect: "the selected category value is displayed" },
      [{ kind: "selection", valueWritten: "categoryFilter", control: category }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].selectedTexts.includes("Testing"), true,
        JSON.stringify(result.journeys[0].steps[0]));
      assert.equal(result.mechanics.skipped.some((row) => (
        row.id === "category-filter" && row.reason === "no_options_on_entry"
      )), false, JSON.stringify(result.mechanics));
    });

    await t.test("focus-only controls are keyboard-proven without changing catalogue state", async () => {
      const search = control("searchQuery", "catalogue-search");
      const selected = { ...control("selectedSoftwareId", "catalogue-selection",
        ["button", "radio", "option", "combobox"]), selectedState: true };
      pageBody = `<style>:focus-visible { outline: 4px solid rgb(0, 120, 212); outline-offset: 2px; }</style>
        <main><label>search Query <input data-thrallo-control="catalogue-search"
          oninput="document.getElementById('catalogue-grid').hidden=this.value!==''"></label>
        <div id="catalogue-grid" role="group" aria-label="selected Software Id"
          data-thrallo-control="catalogue-selection">
          <button type="button" value="atlas-editor" data-thrallo-control="catalogue-selection"
            aria-label="selected Software Id Atlas Editor" aria-pressed="false">View Atlas Editor</button>
          <button type="button" value="compass-deploy" data-thrallo-control="catalogue-selection"
            aria-label="selected Software Id Compass Deploy" aria-pressed="false">View Compass Deploy</button>
        </div></main>`;
      const contract = {
        journeys: [{ id: "journey", title: "Use accessible catalogue controls", priority: "primary", steps: [
          { action: "move keyboard focus to the catalogue search control", operates: ["searchQuery"],
            primitive: "textbox", expect: "a visible focus indicator appears on the labelled search control" },
          { action: "move keyboard focus to a software card action", operates: ["selectedSoftwareId"],
            primitive: "selection",
            expect: "a visible focus indicator appears and its accessible name identifies the software" },
        ] }],
        interactionContract: { flows: [
          { journeyId: "journey", stepIndex: 0, kind: "input", interactionMode: "keyboard_focus",
            valueWritten: "searchQuery", control: search, reads: [], writes: [] },
          { journeyId: "journey", stepIndex: 1, kind: "selection", interactionMode: "keyboard_focus",
            valueWritten: "selectedSoftwareId", control: selected, reads: [], writes: [] },
        ] },
      };
      const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY });
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps.length, 2);
      for (const stepResult of result.journeys[0].steps) {
        assert.equal(stepResult.controlEvidence.focus[0].visibleIndicator, true);
        assert.equal(stepResult.controlEvidence.focus[0].mutationObserved, false);
      }
      assert.equal(result.journeys[0].steps[1].controlEvidence.focus[0].nameSpecificity, true);
    });

    await t.test("focus-only verification rejects a control with no visible focus indicator", async () => {
      const selected = { ...control("selectedSoftwareId", "catalogue-selection",
        ["button", "radio", "option", "combobox"]), selectedState: true };
      const result = await run(`<style>button:focus,button:focus-visible { outline: none; box-shadow: none; }</style>
        <main><button type="button" data-thrallo-control="catalogue-selection"
          aria-label="selected Software Id Atlas Editor" aria-pressed="false">View Atlas Editor</button></main>`,
      { action: "move keyboard focus to a software card action", operates: ["selectedSoftwareId"],
        primitive: "selection",
        expect: "a visible focus indicator appears and its accessible name identifies the software" },
      [{ kind: "selection", interactionMode: "keyboard_focus",
        valueWritten: "selectedSoftwareId", control: selected, reads: [], writes: [] }]);
      assert.equal(result.pass, false, JSON.stringify(result.journeys));
      assert.match(result.journeys[0].steps[0].detail, /no visible keyboard focus indicator/i);
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

    await t.test("one collection member action drives one exact repeated control", async () => {
      const remove = {
        ...control("saved software list remove control", "remove-saved-software", ["button"]),
        accessibleName: "saved software list remove control",
        accessibleNames: ["saved software list remove control"],
      };
      const step = {
        action: "remove one saved software item",
        expect: "the removed software is no longer shown and the remaining favourite is still visible",
      };
      assert.equal(requestsSingleCollectionMemberAction(step), true);
      const result = await run(`<main><ul>
        <li>Atlas Editor <button data-thrallo-action="remove-saved-software"
          aria-label="saved software list remove control"
          onclick="this.closest('li').remove();document.getElementById('out').textContent='Removed software; remaining favourite is still visible'">Remove</button></li>
        <li>Compass Deploy <button data-thrallo-action="remove-saved-software"
          aria-label="saved software list remove control"
          onclick="this.closest('li').remove();document.getElementById('out').textContent='Removed software; remaining favourite is still visible'">Remove</button></li>
        </ul><p id="out"></p></main>`, step,
      [{ kind: "action", operationId: "remove-saved-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.equivalentCandidates, 2);
    });

    await t.test("repeated unbound ordinary commit actions are app-repairable", async () => {
      const action = control("save project", "missing-save-identity", ["button"]);
      const result = await run(`<main>
        <button aria-label="save project">Save one</button>
        <button aria-label="save project">Save two</button>
        <p id="out"></p></main>`,
      { action: "click save project", expect: "project saved result visible" },
      [{ kind: "action", control: action }]);
      assert.equal(result.journeys[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.equal(requestsSingleCollectionMemberAction({
        action: "save the project", expect: "the project remains visible",
      }), false);
    });

    await t.test("a required unlocatable control is an app interaction defect", async () => {
      const action = control("save project", "missing-action", ["button"]);
      const contract = contractFor({ action: "click save project", expect: "project saved result visible" },
        [{ kind: "action", control: action }]);
      pageBody = "<main><h1>Project</h1></main>";
      const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY });
      assert.equal(result.journeys[0].classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
      const defects = verificationDefects({ contract, journeyResults: result });
      assert.equal(actionableDefects(defects).length, 1, JSON.stringify(defects));
      assert.equal(platformDefectsOf(defects).length, 0, JSON.stringify(defects));
      assert.equal(actionableDefects(defects)[0].defectClass, "interaction");
    });

    await t.test("a required flow entry absent from a healthy active surface is app-repairable", async () => {
      const entry = {
        ...control("catalogueItem", "open-catalogue-item", ["button", "link"]),
        accessibleName: "open catalogue item",
        accessibleNames: ["open catalogue item"],
        flowEntry: true,
      };
      const contract = contractFor({
        action: "open a catalogue item", expect: "software details are visible",
      }, [{ kind: "flow_start", valueWritten: "catalogueItem", control: entry }]);
      pageBody = "<main><h1>Software catalogue</h1><p>Available tools</p></main>";
      const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY });
      assert.equal(result.journeys[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.reason,
        "not_reliably_located");
      const defects = verificationDefects({ contract, journeyResults: result });
      assert.equal(actionableDefects(defects).length, 1, JSON.stringify(defects));
      assert.equal(platformDefectsOf(defects).length, 0, JSON.stringify(defects));
      assert.equal(actionableDefects(defects)[0].defectClass, "interaction");
    });

    await t.test("a required selection absent from a healthy active surface is app-repairable", async () => {
      const category = {
        ...control("categoryId", "software-category", ["group"]),
        accessibleName: "software category", accessibleNames: ["software category"],
        selectedState: true,
      };
      const result = await run("<main><h1>Software catalogue</h1><p>Available tools</p></main>",
        { action: "select a software category", operates: ["categoryId"],
          expect: "filtered software results are visible" },
        [{ kind: "selection", valueWritten: "categoryId", control: category }]);
      assert.equal(result.journeys[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.requiredControl.kind, "selection");
    });

    await t.test("one machine-identified catalogue result proves a real selection transition", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        selectedState: true,
      };
      const step = { action: "select the visible software item", operates: ["selectedSoftwareId"],
        expect: "selected software details are visible" };
      const flow = { kind: "selection", valueWritten: "selectedSoftwareId", control: selectedItem };
      const working = `<main><button data-thrallo-control="software-item" aria-pressed="false"
          onclick="this.setAttribute('aria-pressed','true'); document.getElementById('out').textContent='Selected software details are visible'">Atlas Editor</button>
          <p id="out"></p></main>`;
      const result = await run(working, step, [flow]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.match(result.journeys[0].steps[0].detail, /selection created/i);

      const unchanged = await run(working.replace("this.setAttribute('aria-pressed','true');", ""), step, [flow]);
      assert.equal(unchanged.pass, false, "a machine identity must not weaken selected-state proof");
      assert.equal(unchanged.journeys[0].steps[0].status, "fail");
      assert.match(unchanged.journeys[0].steps[0].detail, /never gained a selected state/i);
    });

    await t.test("a required input absent from a healthy active surface is app-repairable", async () => {
      const query = control("searchQuery", "search-query");
      const result = await run("<main><h1>Software catalogue</h1><p>Available tools</p></main>",
        { action: "enter a search query", operates: ["searchQuery"],
          expect: "matching software is visible" },
        [{ kind: "input", valueWritten: "searchQuery", control: query }]);
      assert.equal(result.journeys[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].status, "missing");
    });

    await t.test("secondary setup replays the primary route before a contracted choice", async () => {
      const category = {
        ...control("categoryId", "catalogue-category", ["group"]),
        accessibleName: "software category",
        accessibleNames: ["software category"], selectedState: true,
      };
      const primary = { id: "browse", title: "Browse software", priority: "primary", steps: [] };
      const secondary = { id: "filter", title: "Filter software", priority: "secondary", steps: [{
        action: "select a software category", operates: ["categoryId"],
        expect: "filtered software results are visible",
      }] };
      const navigation = { id: "browse:route", journeyId: "browse", stepIndex: 0,
        kind: "navigation", target: "/catalogue", control: null };
      const primaryChoice = { id: "browse:category", journeyId: "browse", stepIndex: 1,
        kind: "selection", valueWritten: "categoryId", control: category };
      const secondaryChoice = { id: "filter:category", journeyId: "filter", stepIndex: 0,
        kind: "selection", valueWritten: "categoryId", control: category };
      pageBody = `<main id="app"></main><script>
        if (location.pathname === '/catalogue') {
          document.getElementById('app').innerHTML = '<h1>Software catalogue</h1>'
            + '<div role="group" aria-label="software category" data-thrallo-control="catalogue-category">'
            + '<button data-thrallo-control="catalogue-category" data-thrallo-option="editor" aria-pressed="false">Editors</button>'
            + '<button data-thrallo-control="catalogue-category" data-thrallo-option="testing" aria-pressed="false">Testing</button></div>'
            + '<p id="result"></p>';
          for (const button of document.querySelectorAll('button')) button.onclick = () => {
            for (const item of document.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
            document.getElementById('result').textContent = 'Filtered software results are visible';
          };
        } else document.getElementById('app').innerHTML = '<h1>Home</h1>';
      </script>`;
      const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY, contract: {
          journeys: [secondary], allJourneys: [primary, secondary],
          interactionContract: { flows: [secondaryChoice] },
          prerequisiteInteractionContract: { flows: [navigation, primaryChoice, secondaryChoice] },
        } });
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.deepEqual(result.journeys[0].setup.performed.map((row) => row.kind), ["navigation"]);
    });

    await t.test("a ready same-screen secondary control does not replay unrelated primary filters", async () => {
      const search = { ...control("searchQuery", "search-query"), verificationValue: "Atlas" };
      const apply = control("apply filters", "apply-filters", ["button"]);
      const selected = {
        ...control("selectedSoftwareId", "selected-software", ["button", "radio", "option", "combobox"]),
        verificationValue: "compass-deploy", selectedState: true,
      };
      const primary = { id: "browse", title: "Browse", priority: "primary", steps: [] };
      const secondary = { id: "manage", title: "Manage shortlist", priority: "secondary", steps: [{
        action: "select Compass Deploy from the software grid", operates: ["selectedSoftwareId"],
        expect: "the detail panel shows Compass Deploy",
      }] };
      const primarySearch = { id: "browse:search", journeyId: "browse", stepIndex: 0,
        kind: "input", valueWritten: "searchQuery", control: search };
      const primaryApply = { id: "browse:apply", journeyId: "browse", stepIndex: 1,
        kind: "action", control: apply };
      const primarySelection = { id: "browse:selected", journeyId: "browse", stepIndex: 2,
        kind: "selection", valueWritten: "selectedSoftwareId", control: selected };
      const secondarySelection = { id: "manage:selected", journeyId: "manage", stepIndex: 0,
        kind: "selection", valueWritten: "selectedSoftwareId", control: selected };
      pageBody = `<main>
        <label>Search query <input data-thrallo-control="search-query"></label>
        <button data-thrallo-action="apply-filters" onclick="document.getElementById('grid').replaceChildren()">Apply filters</button>
        <div id="grid"><button type="button" value="compass-deploy" data-thrallo-control="selected-software"
          aria-label="selected Software Id Compass Deploy" aria-pressed="false"
          onclick="this.setAttribute('aria-pressed','true');document.getElementById('detail').textContent='Detail panel shows Compass Deploy'">Compass Deploy</button></div>
        <p id="detail"></p>
      </main>`;
      const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 35_000,
        verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY, contract: {
          journeys: [secondary], allJourneys: [primary, secondary],
          interactionContract: { flows: [secondarySelection] },
          prerequisiteInteractionContract: {
            flows: [primarySearch, primaryApply, primarySelection, secondarySelection],
          },
        } });
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.deepEqual(result.journeys[0].setup.performed, []);
      assert.equal(result.journeys[0].setup.directEntry, "selectedSoftwareId");
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
