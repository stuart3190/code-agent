import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import {
  collectionMembershipExpectationSpec, controlResetTransition, expectationKeywords, expectationOutcome,
  expectationRequestsControlReset, isObservationOnlyStep, removalExpectationSpec, selectedRemovalExpectationSpec,
  requestsSingleCollectionMemberAction, selectedCollectionExpectationSpec, verifyJourneys,
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

test("layout guidance does not become required visible copy", () => {
  assert.deepEqual(
    expectationKeywords("a distinctive Atlas Suite hero is visible above the software catalogue section"),
    ["atlas", "suite", "software", "catalogue", "section"],
  );
  assert.deepEqual(
    expectationKeywords("the default catalogue grid is visible with multiple software cards"),
    ["catalogue", "software"],
  );
  assert.deepEqual(
    expectationKeywords("the detail panel is visible with the heading Atlas CLI and shows its category, platform, pricing, and description"),
    ["atlas", "cli", "category", "platform", "pricing"],
  );
  assert.deepEqual(
    expectationKeywords("the selected card is visually highlighted and its software title, category, summary, and feature list are shown"),
    ["software", "category", "summary", "feature", "list"],
  );
  assert.deepEqual(
    expectationKeywords("the detail panel replaces the previous selection and displays Pulse QA Monitor details"),
    ["pulse", "monitor"],
  );
});

test("removal expectations retain a separate positive postcondition", () => {
  const spec = removalExpectationSpec({
    action: "remove the selected software from the saved catalogue",
    expect: "Atlas Editor is removed from the saved catalogue and the saved catalogue empty state is visible again",
  });
  assert.deepEqual(spec, {
    target: "Atlas Editor",
    collection: "saved catalogue",
    postcondition: "the saved catalogue empty state is visible again",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.equal(removalExpectationSpec({
    action: "remove the selected software",
    expect: "Atlas Editor is removed from the saved catalogue",
  }), null);
  assert.deepEqual(removalExpectationSpec({
    action: "remove Atlas Editor from favourites",
    expect: "Atlas Editor is removed and the favourites section shows an empty favourites message",
  }), {
    target: "Atlas Editor",
    collection: "favourites section",
    postcondition: "the favourites section shows an empty favourites message",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(removalExpectationSpec({
    action: "remove the same software from favourites",
    expect: "Forge Planner is removed and the favourites panel shows its empty favourites message",
  }), {
    target: "Forge Planner",
    collection: "favourites panel",
    postcondition: "the favourites panel shows its empty favourites message",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(removalExpectationSpec({
    action: "remove the favourited software",
    expect: "Compass Deploy is removed and the favourites empty message is visible again",
  }), {
    target: "Compass Deploy",
    collection: "favourites",
    postcondition: "the favourites empty message is visible again",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(selectedRemovalExpectationSpec(removalExpectationSpec({
    action: "remove the same software from favourites",
    expect: "the software is removed from the favourites list and the empty favourites message appears",
  }), ["Atlas Editor\nDeveloper Tools"]), {
    target: "Atlas Editor",
    collection: "favourites list",
    postcondition: "the empty favourites message appears",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(selectedRemovalExpectationSpec(removalExpectationSpec({
    action: "remove the favourite from the favourites list",
    expect: "the favourites area shows the empty state text No saved software yet and the favourites count reads 0",
  }), ["Atlas Editor\nDeveloper Tools"]), {
    target: "Atlas Editor",
    collection: "favourites list",
    postcondition: "the favourites area shows the empty state text No saved software yet and the favourites count reads 0",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(selectedRemovalExpectationSpec(removalExpectationSpec({
    action: "remove the software from favourites",
    expect: "the software is removed from the favourites list and the empty favourites message is visible again",
  }), ["AUTOMATION · CLOUD\nForge Flow\nCoordinate routine catalogue workflows"]), {
    target: "Forge Flow",
    collection: "favourites list",
    postcondition: "the empty favourites message is visible again",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
  assert.deepEqual(selectedRemovalExpectationSpec(removalExpectationSpec({
    action: "remove the software from favourites",
    expect: "the software is removed from the favourites list and an empty favourites message is visible",
  }), ["PLANNING\nForge Planner\nWeb · Team\nCoordinate project milestones"], ["forge-planner"]), {
    target: "Forge Planner",
    collection: "favourites list",
    postcondition: "an empty favourites message is visible",
    emptyStateRequired: true,
    remainingMemberRequired: false,
  });
});

test("multi-member collection expectations retain their named scope", () => {
  assert.equal(
    collectionMembershipExpectationSpec("the favourites list shows Meridian Atlas and the favourites count is 1"),
    null,
  );
  assert.deepEqual(
    collectionMembershipExpectationSpec("the favourites list contains Atlas Editor and Compass Deploy"),
    { collection: "favourites list", members: ["Atlas Editor", "Compass Deploy"] },
  );
  assert.deepEqual(
    collectionMembershipExpectationSpec("Atlas Build Studio appears in the favourites list and its card shows a favourited state"),
    { collection: "favourites list", members: ["Atlas Build Studio"] },
  );
  assert.deepEqual(
    collectionMembershipExpectationSpec("Pulse QA Monitor appears in the favourites list while Atlas Build Studio remains listed"),
    { collection: "favourites list", members: ["Pulse QA Monitor", "Atlas Build Studio"] },
  );
  assert.deepEqual(
    collectionMembershipExpectationSpec("the favourites list shows both Atlas Editor and Compass Deploy"),
    { collection: "favourites list", members: ["Atlas Editor", "Compass Deploy"] },
  );
  assert.equal(collectionMembershipExpectationSpec("Atlas Editor is visible"), null);
  assert.equal(collectionMembershipExpectationSpec(
    "the visible software list shows only software matching the search and selected filters",
  ), null);
  assert.equal(collectionMembershipExpectationSpec(
    "the software grid shows Atlas Metrics and does not show unrelated categories",
  ), null);
  assert.deepEqual(collectionMembershipExpectationSpec(
    "the favourites list contains Atlas Editor and Compass Deploy and the favourite count is 2",
  ), { collection: "favourites list", members: ["Atlas Editor", "Compass Deploy"] });
  assert.deepEqual(selectedCollectionExpectationSpec(
    "the favourites list shows one item and displays the selected software name",
    ["Atlas Editor\nDeveloper Tools"],
  ), { collection: "favourites list", members: ["Atlas Editor"] });
  assert.deepEqual(selectedCollectionExpectationSpec(
    "the favourites list shows one item and displays the selected software name",
    ["DESIGN · TEAM\nVector Studio\nCreate reusable catalogue assets"],
  ), { collection: "favourites list", members: ["Vector Studio"] });
  const selectedMemberOutcome = expectationOutcome({
    wanted: ["favourites", "list", "one", "item", "displays"], found: [], fresh: [],
    drove: true, action: "add selected software", actionProven: true,
    collectionStateRequired: true, collectionStateSatisfied: true,
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
  });
  assert.equal(selectedMemberOutcome.classification, VERIFICATION_RESULT_CLASS.PASS);
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
          <button data-thrallo-action="clear-filters" onclick="document.getElementById('query').value=''; document.getElementById('empty').hidden=true; document.getElementById('results').hidden=false">Reset catalogue</button>
          <p id="empty">No software matches the current search.</p>
          <section id="results" hidden><h2>Software cards</h2><p>Default catalogue item</p></section></main>`,
      { action: "clear the current search and filters",
        expect: "the full software card grid returns and the no-results empty state is hidden" },
      [{ kind: "action", operationId: "clear-catalogue-filters", control: clear }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.resetTransition.ok, true);
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.equivalentCandidates, 2);
    });

    await t.test("a contracted reset clears a fixture-protected input without inventing a value", async () => {
      const search = { ...control("searchQuery", "search-query"), requiresVerificationFixture: true };
      const clear = control("clear search control", "clear-search", ["button"]);
      const result = await run(`<main><label>Software search box
          <input data-thrallo-control="search-query" aria-label="search Query" value="missing-entry"></label>
          <button data-thrallo-action="clear-search"
            onclick="document.querySelector('[data-thrallo-control=search-query]').value='';document.getElementById('cards').hidden=false">Clear search</button>
          <section id="cards" hidden><h2>Software cards</h2><p>Atlas Editor</p></section></main>`,
      { action: "clear the current search", operates: ["searchQuery"],
        expect: "software cards are visible again and the empty results message is no longer shown" }, [
        { kind: "input", valueWritten: "searchQuery", action: "clear the current search", control: search },
        { kind: "action", operationId: "clear-search", action: "clear the current search", control: clear },
      ]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].expectedValue, "");
      assert.equal(result.journeys[0].steps[0].controlEvidence.fields[0].fixtureAuthority, "contract_reset");
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

    await t.test("an implicit empty-state removal scopes duplicate action identities", async () => {
      const remove = {
        ...control("Remove Atlas Editor from favourites control", "remove-favourite-software", ["button"]),
        accessibleName: "Remove Atlas Editor from favourites control",
        accessibleNames: ["Remove Atlas Editor from favourites control"],
      };
      const step = {
        action: "remove Atlas Editor from the favourites list",
        expect: "the favourites area shows the empty state text No favourites yet and the favourites count reads 0",
      };
      const result = await run(`<main><section aria-label="Software detail"><h2>Atlas Editor</h2>
        <button data-thrallo-action="remove-favourite-software" aria-label="Remove Atlas Editor from favourites control">Remove</button>
        </section><section aria-label="Favourites"><h2>Favourites</h2><p id="favourite-count">Favourites count reads 1</p><ul>
        <li id="favourite-item">Atlas Editor <button data-thrallo-action="remove-favourite-software"
          aria-label="Remove Atlas Editor from favourites control"
          onclick="document.getElementById('favourite-item').remove();document.getElementById('favourite-count').textContent='Favourites count reads 0';document.getElementById('empty').hidden=false">Remove</button></li>
        </ul><p id="empty" data-empty-state hidden>No favourites yet</p></section></main>`, step,
      [{ kind: "action", operationId: "remove-favourite-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.scope, "contracted_collection_member");
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
    });

    await t.test("a contracted removal proves disappearance and its positive empty state", async () => {
      const remove = {
        ...control("saved catalogue remove control", "remove-catalogue-software", ["button"]),
        accessibleName: "saved catalogue remove control",
        accessibleNames: ["saved catalogue remove control"],
      };
      const step = {
        action: "remove the selected software from the saved catalogue",
        expect: "Atlas Editor is removed from the saved catalogue and the saved catalogue empty state is visible again",
      };
      const result = await run(`<main><section aria-label="Software detail"><h2>Atlas Editor</h2>
        <button data-thrallo-action="remove-catalogue-software" aria-label="saved catalogue remove control"
          onclick="document.getElementById('saved-item').remove();document.getElementById('empty').hidden=false">Remove</button>
        </section><section aria-label="Saved catalogue"><h2>Saved catalogue</h2><ul>
        <li id="saved-item">Atlas Editor <button data-thrallo-action="remove-catalogue-software"
          aria-label="saved catalogue remove control"
          onclick="document.getElementById('saved-item').remove();document.getElementById('empty').hidden=false">Remove</button></li>
        </ul><p id="empty" data-empty-state hidden>No saved software yet</p></section></main>`, step,
      [{ kind: "action", operationId: "remove-catalogue-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.equivalentCandidates, 2);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.postcondition.emptyStateEvidence.visible, true);
    });

    await t.test("a removal is scoped to its collection instead of a broad catalogue wrapper", async () => {
      const remove = {
        ...control("favourites list remove control", "remove-favourite-software", ["button"]),
        accessibleName: "favourites list remove control",
        accessibleNames: ["favourites list remove control"],
      };
      const step = {
        action: "remove the selected software from the favourites list",
        expect: "Atlas Editor is removed from the favourites list and the favourites list empty state is visible",
      };
      const result = await run(`<main><section>
        <header><p>Browse the software catalogue and keep a session favourites shortlist.</p></header>
        <section aria-label="Software detail"><h2>Atlas Editor</h2>
          <button data-thrallo-action="remove-favourite-software" aria-label="detail panel favourite control"
            onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove Atlas Editor from favourites</button>
        </section>
        <section aria-label="Session favourites"><h2>Session favourites</h2><ul>
          <li id="favourite-item">Atlas Editor <button data-thrallo-action="remove-favourite-software"
            aria-label="favourites list remove control"
            onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove from favourites</button></li>
          </ul><p id="favourites-empty" data-empty-state hidden>No favourites yet. Add Atlas Editor from the catalogue.</p>
        </section></section></main>`, step,
      [{ kind: "action", operationId: "remove-favourite-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.postcondition.emptyStateEvidence.visible, true);
    });

    await t.test("a detail action measures removal in the explicitly named collection", async () => {
      const remove = {
        ...control("remove favourite control", "remove-favourite-software", ["button"]),
        accessibleName: "remove favourite control",
        accessibleNames: ["remove favourite control"],
      };
      const step = {
        action: "remove Atlas Editor from favourites",
        expect: "Atlas Editor is removed from the favourites panel and the panel shows an empty favourites message if no favourites remain",
      };
      const result = await run(`<main><section aria-label="Selected item detail panel"><h2>Atlas Editor</h2>
        <button data-thrallo-action="remove-favourite-software" aria-label="remove favourite control"
          onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove favourite</button>
        </section><section aria-label="Favourites panel"><h2>Favourites panel</h2><ul>
        <li id="favourite-item">Atlas Editor</li></ul>
        <p id="favourites-empty" data-empty-state hidden>No favourites remain</p></section></main>`, step,
      [{ kind: "action", operationId: "remove-favourite-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.scope, "contracted_collection_member");
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
    });

    await t.test("a removal can derive collection scope from its positive empty-message clause", async () => {
      const remove = {
        ...control("favourites list remove control", "remove-favourite-software", ["button"]),
        accessibleName: "favourites list remove control",
        accessibleNames: ["favourites list remove control"],
      };
      const step = {
        action: "remove Atlas Editor from favourites",
        expect: "Atlas Editor is removed and the favourites section shows an empty favourites message",
      };
      const result = await run(`<main><section aria-label="Software catalogue"><h2>Software catalogue</h2>
        <article>Atlas Editor</article></section>
        <section aria-label="Session favourites"><h2>Favourites</h2>
          <div id="favourite-item">Atlas Editor <button data-thrallo-action="remove-favourite-software"
            aria-label="favourites list remove control"
            onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove</button></div>
          <p id="favourites-empty" data-empty-state hidden>Empty favourites message: no software is saved yet.</p>
        </section></main>`, step,
      [{ kind: "action", operationId: "remove-favourite-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.postcondition.emptyStateEvidence.visible, true);
    });

    await t.test("one removal operation may appear in both detail and collection contexts", async () => {
      const remove = {
        ...control("remove favourite control", "remove-favourite-software", ["button"]),
        accessibleName: "remove favourite control",
        accessibleNames: ["remove favourite control"],
      };
      const step = {
        action: "remove the favourited software",
        expect: "Compass Deploy is removed and the favourites empty message is visible again",
      };
      const result = await run(`<main>
        <section aria-label="Software detail"><h2>Compass Deploy</h2>
          <button data-thrallo-action="remove-favourite-software" aria-label="remove favourite control"
            onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove favourite</button>
        </section>
        <section aria-label="Session favourites"><h2>Favourites</h2>
          <div id="favourite-item">Compass Deploy <button data-thrallo-action="remove-favourite-software"
            aria-label="remove favourite control"
            onclick="document.getElementById('favourite-item').remove();document.getElementById('favourites-empty').hidden=false">Remove</button></div>
          <p id="favourites-empty" hidden>No favourites have been added in this browser session.</p>
        </section></main>`, step,
      [{ kind: "action", operationId: "remove-favourite-software", control: remove }]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.equivalentCandidates, 2);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.postcondition.emptyStateEvidence.visible, true);
    });

    await t.test("global catalogue copy cannot hide a missing collection member", async () => {
      const favourite = {
        ...control("favouriteSoftwareIds", "add-favourite-software", ["button", "option"]),
        verificationValue: "compass-deploy",
        selectedState: true,
      };
      const result = await run(`<main>
        <section aria-label="Software catalogue"><h2>Software catalogue</h2>
          <article>Atlas Editor</article><article>Compass Deploy</article>
          <button data-thrallo-control="add-favourite-software" data-thrallo-option="compass-deploy"
            value="compass-deploy" aria-pressed="false"
            onclick="this.setAttribute('aria-pressed','true');document.getElementById('favourite-members').innerHTML='<li>Compass Deploy</li>'">Add Compass Deploy</button>
        </section>
        <section aria-label="Session favourites"><h2>Session favourites</h2>
          <p id="favourite-count">Favourite count is 1</p>
          <ul id="favourite-members"><li>Atlas Editor</li></ul>
        </section></main>`,
      { action: "add a second software item to favourites", operates: ["favouriteSoftwareIds"],
        expect: "the favourites list contains Atlas Editor and Compass Deploy" },
      [{ kind: "selection", valueWritten: "favouriteSoftwareIds", control: favourite },
        { kind: "action", operationId: "toggle-favourite", reads: ["favouriteSoftwareIds"],
          writes: ["favouriteSoftwareIds"] }]);
      assert.equal(result.pass, false, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.deepEqual(result.journeys[0].steps[0].controlEvidence.collectionMembership.missing,
        ["Atlas Editor"]);

      const retained = await run(`<main>
        <div role="status" aria-label="Catalogue results and favourites status">1 result visible. Favourite count is 1.</div>
        <section aria-label="Software catalogue"><h2>Software catalogue</h2>
          <article>Atlas Editor</article><article>Compass Deploy</article>
          <button data-thrallo-control="add-favourite-software" data-thrallo-option="compass-deploy"
            value="compass-deploy" aria-pressed="false"
            onclick="this.setAttribute('aria-pressed','true');document.getElementById('favourite-members').insertAdjacentHTML('beforeend','<li>Compass Deploy</li>');document.getElementById('favourite-count').textContent='Favourite count is 2'">Add Compass Deploy</button>
        </section>
        <section aria-label="Session favourites"><h2>Session favourites</h2>
          <p id="favourite-count">Favourite count is 1</p>
          <ul id="favourite-members"><li>Atlas Editor</li></ul>
        </section></main>`,
      { action: "add a second software item to favourites", operates: ["favouriteSoftwareIds"],
        expect: "the favourites list contains Atlas Editor and Compass Deploy and the favourite count is 2" },
      [{ kind: "selection", valueWritten: "favouriteSoftwareIds", control: favourite },
        { kind: "action", operationId: "toggle-favourite", reads: ["favouriteSoftwareIds"],
          writes: ["favouriteSoftwareIds"] }]);
      assert.equal(retained.pass, true, JSON.stringify(retained.journeys));
    });

    await t.test("an empty-state message cannot hide a failed contracted removal", async () => {
      const remove = {
        ...control("saved catalogue remove control", "remove-catalogue-software", ["button"]),
        accessibleName: "saved catalogue remove control",
        accessibleNames: ["saved catalogue remove control"],
      };
      const result = await run(`<main><section aria-label="Software detail"><h2>Atlas Editor</h2>
        <button data-thrallo-action="remove-catalogue-software" aria-label="saved catalogue remove control"
          onclick="document.getElementById('empty').hidden=false">Remove</button>
        </section><section aria-label="Saved catalogue"><h2>Saved catalogue</h2><ul>
        <li>Atlas Editor</li>
        </ul><p id="empty" data-empty-state hidden>No saved software yet</p></section></main>`,
      { action: "remove the selected software from the saved catalogue",
        expect: "Atlas Editor is removed from the saved catalogue and the saved catalogue empty state is visible again" },
      [{ kind: "action", operationId: "remove-catalogue-software", control: remove }]);
      assert.equal(result.pass, false, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.ok, false);
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 1);
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

    await t.test("an exact catalogue item already selected with its outcome visible is accepted", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-editor",
        selectedState: true,
      };
      const step = { action: "select the visible software item", operates: ["selectedSoftwareId"],
        expect: "selected software details are visible" };
      const flow = { kind: "selection", valueWritten: "selectedSoftwareId", control: selectedItem };
      const established = await run(`<main><div role="radiogroup" aria-label="selected software">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="true">Atlas Editor</button>
        </div><section><h2>Atlas Editor details</h2><p>Selected software details are visible</p></section></main>`,
      step, [flow]);
      assert.equal(established.pass, true, JSON.stringify(established.journeys));
      assert.equal(established.journeys[0].steps[0].drove, false);
      assert.equal(established.journeys[0].steps[0].controlEvidence.selections[0].precondition,
        "already_selected");

      const missingOutcome = await run(`<main><div role="radiogroup" aria-label="selected software">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="true">Atlas Editor</button>
        </div></main>`, step, [flow]);
      assert.equal(missingOutcome.pass, false, "selected state alone must not satisfy the outcome");
    });

    await t.test("a repeated card control identity resolves the contracted catalogue member", async () => {
      const selectedItem = {
        ...control("selectedItemId", "catalogue-item", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-cli",
        selectedState: true,
      };
      const step = { action: "select the matching software card", operates: ["selectedItemId"],
        expect: "the detail panel is visible with the heading Atlas CLI and shows its category, platform, pricing, and description" };
      const flow = { kind: "selection", valueWritten: "selectedItemId", control: selectedItem };
      const result = await run(`<main><section><h2>Software catalogue</h2><div>
          <article><h3>Compass Deploy</h3><button data-thrallo-control="catalogue-item"
            value="compass-deploy" aria-pressed="false">Select Compass Deploy</button></article>
          <article><h3>Atlas CLI</h3><button data-thrallo-control="catalogue-item"
            value="atlas-cli" aria-label="selected Item Id atlas-cli" aria-pressed="true">Select Atlas CLI</button></article>
        </div></section><aside><h2>Atlas CLI</h2><dl>
          <dt>Category</dt><dd>Developer Tools</dd><dt>Platform</dt><dd>Desktop</dd>
          <dt>Pricing</dt><dd>Free</dd><dt>Description</dt><dd>Command-line software</dd>
        </dl></aside></main>`, step, [flow]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.selections[0].verificationValue,
        "atlas-cli");
    });

    await t.test("one catalogue identity anchors equivalent unnamed card selections", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        verificationValue: "analytics-desk",
        selectedState: true,
      };
      const selectSoftware = control("software card list", "select-software", ["button"]);
      const step = { action: "select the Analytics Desk software card", operates: ["selectedSoftwareId"],
        expect: "the detail result shows the active Analytics Desk workspace marker" };
      const result = await run(`<main><div role="list" aria-label="software card list">
          <article role="listitem"><h2>ForgeKit Pro</h2><button data-thrallo-control="software-item"
            data-thrallo-action="select-software" value="forgekit-pro" aria-pressed="false"
            onclick="for(const card of document.querySelectorAll('[aria-pressed]'))card.setAttribute('aria-pressed',String(card===this));document.getElementById('detail').textContent='ForgeKit Pro detail result'">ForgeKit Pro</button></article>
          <article role="listitem"><h2>Analytics Desk</h2><button value="analytics-desk" aria-pressed="false"
            onclick="for(const card of document.querySelectorAll('[aria-pressed]'))card.setAttribute('aria-pressed',String(card===this));document.getElementById('detail').textContent='Active Analytics Desk workspace marker'">Analytics Desk</button>
            <button type="button">Open documentation</button></article>
        </div><aside id="detail">Select software to view its detail result</aside></main>`, step, [
        { kind: "selection", valueWritten: "selectedSoftwareId", control: selectedItem },
        { kind: "action", operationId: "select-software", control: selectSoftware },
      ]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const selection = result.journeys[0].steps[0].controlEvidence.selections[0];
      assert.equal(selection.verificationValue, "analytics-desk");
      assert.deepEqual(selection.selectedOptions.map((option) => option.value),
        ["forgekit-pro", "analytics-desk"], "ordinary sibling actions stay outside the selection group");
      assert.deepEqual(selection.selectedOptions.map((option) => option.selected), [false, true]);
      assert.deepEqual(result.journeys[0].steps[0].controlEvidence.selectionOwnedAction,
        { selectionControl: "software-item", actionControl: "select-software" });
    });

    await t.test("an established catalogue selection owns its hidden transient result proxy", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-compiler",
        selectedState: true,
      };
      const refreshResult = control("software catalogue", "refresh-software-result", ["button"]);
      const html = `<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
          overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}</style>
        <main><label>Selected software
          <select data-thrallo-control="software-item" aria-label="selected Software Id">
            <option value="atlas-compiler" selected>Atlas Compiler</option>
          </select></label>
          <button class="sr-only" data-thrallo-action="refresh-software-result">Refresh selected software</button>
          <section><h2>Atlas Compiler</h2><p>The active compiler workspace details are visible</p></section>
        </main>`;
      const flows = [
        { kind: "selection", valueWritten: "selectedSoftwareId", writes: ["journey.selectedSoftwareId"],
          control: selectedItem },
        { kind: "action", operationId: "select-software", reads: ["journey.selectedSoftwareId"],
          writes: ["journey.result.selectedSoftwareName"], control: refreshResult },
      ];
      const result = await run(html,
        { action: "select Atlas Compiler from the software catalogue", operates: ["selectedSoftwareId"],
          expect: "the active compiler workspace details are visible" }, flows);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const evidence = result.journeys[0].steps[0].controlEvidence.establishedSelectionAction;
      assert.deepEqual({
        selectionControl: evidence.selectionControl,
        actionControl: evidence.actionControl,
        matchedBy: evidence.matchedBy,
        candidateCount: evidence.candidateCount,
        perceivableCount: evidence.perceivableCount,
      }, {
        selectionControl: "software-item",
        actionControl: "refresh-software-result",
        matchedBy: "established_selection_auto_applied_action",
        candidateCount: 1,
        perceivableCount: 0,
      });
      assert.equal(evidence.expectationEvidence.met, true);

      const explicitApply = await run(html,
        { action: "select Atlas Compiler and press Apply", operates: ["selectedSoftwareId"],
          expect: "the active compiler workspace details are visible" }, flows);
      assert.equal(explicitApply.pass, false, "an explicit activation cannot be replaced by established state");
      assert.match(explicitApply.journeys[0].steps[0].detail, /contracted action control was not offered/i);
    });

    await t.test("independent named selections in one software grid keep separate state", async () => {
      const targetSoftware = {
        ...control("targetSoftwareId", "target-software", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-build-studio",
        selectedState: true,
      };
      const updateFavourites = control("update favourites", "update-favourites", ["button"]);
      const result = await run(`<main>
        <div role="list" aria-label="software card grid">
          <article role="listitem"><h2>Atlas Build Studio</h2>
            <button name="selectedSoftwareId" value="atlas-build-studio"
              data-thrallo-control="selected-software" aria-pressed="true">Select details</button>
            <button name="targetSoftwareId" value="atlas-build-studio"
              data-thrallo-control="target-software" aria-pressed="false"
              onclick="for (const item of document.querySelectorAll('[name=targetSoftwareId]')) item.setAttribute('aria-pressed', String(item === this))">Choose favourite target</button>
          </article>
          <article role="listitem"><h2>Pulse QA Monitor</h2>
            <button name="selectedSoftwareId" value="pulse-qa-monitor"
              data-thrallo-control="selected-software" aria-pressed="false">Select details</button>
            <button name="targetSoftwareId" value="pulse-qa-monitor"
              data-thrallo-control="target-software" aria-pressed="true"
              onclick="for (const item of document.querySelectorAll('[name=targetSoftwareId]')) item.setAttribute('aria-pressed', String(item === this))">Choose favourite target</button>
          </article>
        </div>
        <button data-thrallo-action="update-favourites"
          onclick="document.getElementById('out').textContent='Atlas Build Studio is removed from favourites and Pulse QA Monitor remains listed'">Update favourites</button>
        <p id="out"></p>
      </main>`,
      { action: "choose Atlas Build Studio and update favourites", operates: ["targetSoftwareId"],
        expect: "Atlas Build Studio is removed from favourites and Pulse QA Monitor remains listed" }, [
        { kind: "selection", valueWritten: "targetSoftwareId", control: targetSoftware },
        { kind: "action", control: updateFavourites, writes: ["favouriteSoftwareIds"] },
      ]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const selection = result.journeys[0].steps[0].controlEvidence.selections[0];
      assert.equal(selection.verificationValue, "atlas-build-studio");
      assert.deepEqual(selection.selectedOptions.map((option) => option.selected), [true, false]);
    });

    await t.test("one catalogue toggle is not activated twice when its collection change is proven", async () => {
      const targetSoftware = {
        ...control("targetSoftwareId", "target-software", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-build-studio",
        selectedState: true,
      };
      const toggleFavourite = control("toggle favourite", "toggle-favourite", ["button"]);
      const result = await run(`<main>
        <div role="list" aria-label="software card grid">
          <article role="listitem"><h2>Atlas Build Studio</h2><button
            name="targetSoftwareId" value="atlas-build-studio" data-thrallo-control="target-software"
            data-thrallo-action="toggle-favourite" aria-pressed="false"
            onclick="const list=document.getElementById('favourites-list');const prior=document.getElementById('atlas-favourite');if(prior){prior.remove();this.setAttribute('aria-pressed','false')}else{list.insertAdjacentHTML('beforeend','<li id=atlas-favourite>Atlas Build Studio</li>');this.setAttribute('aria-pressed','true')}">Toggle favourite</button></article>
          <article role="listitem"><h2>Pulse QA Monitor</h2><button
            name="targetSoftwareId" value="pulse-qa-monitor" data-thrallo-control="target-software"
            data-thrallo-action="toggle-favourite" aria-pressed="false">Toggle favourite</button></article>
        </div>
        <section aria-label="favourites list"><h2>Favourites</h2><ul id="favourites-list"></ul></section>
      </main>`,
      { action: "add Atlas Build Studio to favourites", operates: ["targetSoftwareId"],
        expect: "Atlas Build Studio appears in the favourites list and its card shows a favourited state" }, [
        { kind: "selection", valueWritten: "targetSoftwareId", control: targetSoftware },
        { kind: "action", control: toggleFavourite, writes: ["favouriteSoftwareIds"] },
      ]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      const evidence = result.journeys[0].steps[0].controlEvidence.selectionOwnedOperation;
      assert.equal(evidence.kind, "collection_membership");
      assert.deepEqual(evidence.present, ["Atlas Build Studio"]);
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation, undefined,
        "the already-proven toggle must not be clicked a second time");
    });

    await t.test("filled catalogue controls cannot replace a missing contracted filter result", async () => {
      const search = { ...control("searchQuery", "catalogue-search"), verificationValue: "atlas" };
      const apply = control("catalogue controls", "apply-catalogue-filter", ["button"]);
      const result = await run(`<main><label>Software search
          <input data-thrallo-control="catalogue-search" aria-label="search Query"></label>
          <button data-thrallo-action="apply-catalogue-filter"
            onclick="document.getElementById('results').hidden=true">Catalogue controls</button>
          <section id="results"><h2>Other software</h2><p>No matching catalogue item is available.</p></section></main>`,
      { action: "search and filter the software catalogue", operates: ["searchQuery"],
        expect: "the results area shows a visible card named Atlas CLI and the result count reflects the active search" }, [
        { kind: "input", valueWritten: "searchQuery", writes: ["journey.searchQuery"], control: search },
        { kind: "action", operationId: "filter-catalogue", reads: ["journey.searchQuery"],
          writes: ["journey.resultItemIds"], control: apply },
      ]);
      assert.equal(result.pass, false, "filled inputs do not prove a contracted operation result");
      assert.equal(result.journeys[0].steps[0].classification,
        VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, JSON.stringify(result.journeys));
      assert.doesNotMatch(result.journeys[0].steps[0].detail, /fields hold values/i);
    });

    await t.test("a sole filtered catalogue item already selected with its outcome visible is accepted", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        selectedState: true,
      };
      const step = { action: "select the visible software item", operates: ["selectedSoftwareId"],
        expect: "selected software details are visible" };
      const flow = { kind: "selection", valueWritten: "selectedSoftwareId", control: selectedItem };
      const established = await run(`<main><div role="radiogroup" aria-label="selected software">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="true">Atlas Editor</button>
        </div><section><h2>Atlas Editor details</h2><p>Selected software details are visible</p></section></main>`,
      step, [flow]);
      assert.equal(established.pass, true, JSON.stringify(established.journeys));
      assert.equal(established.journeys[0].steps[0].drove, false);
      assert.equal(established.journeys[0].steps[0].controlEvidence.selections[0].fixtureAuthority,
        "single_available_option");

      const missingOutcome = await run(`<main><div role="radiogroup" aria-label="selected software">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="true">Atlas Editor</button>
        </div></main>`, step, [flow]);
      assert.equal(missingOutcome.pass, false, "a sole selected option still requires its outcome");
    });

    await t.test("a duplicated action identity is scoped to the named catalogue member", async () => {
      const favouriteAction = control("favouriteSoftwareIds", "favourite-action", ["button"]);
      const step = { action: "remove Atlas QA from favourites", operates: ["favouriteSoftwareIds"],
        expect: "Atlas QA is removed from the favourites list and the empty favourites message is visible again" };
      const flow = { kind: "action", control: favouriteAction, writes: ["favouriteSoftwareIds"] };
      const result = await run(`<main>
        <section><h2>Selected software</h2><p>Beacon Monitor</p>
          <button data-thrallo-action="favourite-action" onclick="this.dataset.clicked='true'">Toggle selected</button>
        </section>
        <section><h2>Favourites list</h2><ul><li id="atlas-member">Atlas QA
          <button data-thrallo-action="favourite-action" onclick="document.querySelector('#atlas-member').remove(); document.querySelector('#empty-favourites').hidden=false">Remove</button>
        </li></ul><p id="empty-favourites" data-empty-state hidden>No favourites saved yet.</p></section>
      </main>`, step, [flow]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.equal(result.journeys[0].steps[0].controlEvidence.activation.scope,
        "contracted_collection_member");
      assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
    });

    await t.test("a clipped accessibility mirror cannot shadow the visible catalogue selection", async () => {
      const selectedItem = {
        ...control("selectedSoftwareId", "software-item", ["button", "radio", "option", "combobox"]),
        verificationValue: "atlas-editor",
        selectedState: true,
      };
      const step = { action: "select the visible software item", operates: ["selectedSoftwareId"],
        expect: "selected software details are visible" };
      const flow = { kind: "selection", valueWritten: "selectedSoftwareId", control: selectedItem };
      const result = await run(`<main>
        <div role="radiogroup" aria-label="selected software mirror"
          style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="false">Accessibility mirror</button>
        </div>
        <div role="radiogroup" aria-label="selected software">
          <button data-thrallo-control="software-item" value="atlas-editor" aria-pressed="false"
            onclick="this.setAttribute('aria-pressed','true'); document.getElementById('out').textContent='Selected software details are visible'">Atlas Editor</button>
          <button data-thrallo-control="software-item" value="compass-deploy" aria-pressed="false">Compass Deploy</button>
        </div>
        <p id="out"></p></main>`, step, [flow]);
      assert.equal(result.pass, true, JSON.stringify(result.journeys));
      assert.match(result.journeys[0].steps[0].detail, /selection created/i);
    });

    await t.test("a transient search operation may be owned by its contracted input", async () => {
      const search = { ...control("searchQuery", "software-search"), verificationValue: "no-match" };
      const apply = control("search input", "apply-software-filter", ["button"]);
      const flows = [
        { kind: "input", valueWritten: "searchQuery", writes: ["journey.searchQuery"], control: search },
        { kind: "action", operationId: "apply-software-filter", reads: ["journey.searchQuery"],
          writes: ["journey.visibleSoftwareIds"], control: apply },
      ];
      const html = `<main><label>Software search
        <input data-thrallo-control="software-search" aria-label="search Query"
          oninput="document.getElementById('out').textContent='No software matches the current search'">
        </label><p id="out"></p></main>`;
      const automatic = await run(html, {
        action: "type a search term with no catalogue matches", operates: ["searchQuery"],
        expect: "no software matches the current search",
      }, flows);
      assert.equal(automatic.pass, true, JSON.stringify(automatic.journeys));
      assert.equal(automatic.journeys[0].steps[0].controlEvidence.activation.matchedBy,
        "contracted_input_auto_applied_action");

      const genericCopyAlreadyVisible = await run(`<main>
        <p>Visible result count updates in the software grid.</p>
        <label>Software search <input data-thrallo-control="software-search" aria-label="search Query"
          oninput="document.getElementById('result-card').textContent='Atlas Insight'"></label>
        <p id="result-card">Beacon Monitor</p>
      </main>`, {
        action: "type a search term that matches a catalogue product", operates: ["searchQuery"],
        expect: "the visible result count updates and the software grid includes a card titled Atlas Insight",
      }, flows);
      assert.equal(genericCopyAlreadyVisible.pass, true, JSON.stringify(genericCopyAlreadyVisible.journeys));
      assert.equal(genericCopyAlreadyVisible.journeys[0].steps[0].controlEvidence.activation.stateChanged, true);

      const explicit = await run(html, {
        action: "type a search term and click apply filters", operates: ["searchQuery"],
        expect: "no software matches the current search",
      }, flows);
      assert.equal(explicit.pass, false, "an explicit apply action still requires its own control");
      assert.equal(explicit.journeys[0].steps[0].status, "undriveable");
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

test("a removed marked catalogue member outranks a retained detail action", { ...needsBrowser }, async () => {
  const remove = {
    ...control("favourites list remove control", "toggle-favourite-software", ["button"]),
    accessibleName: "favourites list remove control",
    accessibleNames: ["favourites list remove control"],
  };
  const step = {
    action: "remove the same software from favourites",
    expect: "Flow Automation Suite is removed from the favourites list and the empty favourites message is visible when no favourites remain",
  };
  const result = await run(`<main><aside>
    <div><p>Detail panel</p><div role="status"><h2>Flow Automation Suite</h2>
      <p>Selected software: Flow Automation Suite is highlighted in the software card grid.</p>
      <button data-thrallo-action="toggle-favourite-software" aria-label="detail panel favourite control">Saved to favourites — remove</button>
    </div></div>
    <div id="favourites-panel"><div><h2>Favourites</h2><span>Favourite count: 1</span></div>
      <div id="favourites-list" role="list"><span>Favourites list</span><div role="listitem" id="favourite-item"><span>Flow Automation Suite</span>
        <button data-thrallo-action="toggle-favourite-software" aria-label="favourites list remove control"
          onclick="document.getElementById('favourites-list').remove();document.getElementById('favourite-count').textContent='Favourite count: 0';document.getElementById('favourites-empty').hidden=false">Remove</button>
      </div></div><span id="favourite-count">Favourite count: 1</span>
      <p id="favourites-empty" role="status" hidden>Empty favourites list — no software is saved yet.</p>
    </div>
    </aside></main>`, step,
  [{ kind: "action", operationId: "toggle-favourite-software", control: remove }]);
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  assert.equal(result.journeys[0].steps[0].controlEvidence.activation.scope,
    "contracted_collection_member");
  assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.beforeCount, 1);
  assert.equal(result.journeys[0].steps[0].controlEvidence.removalTransition.afterCount, 0);
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
