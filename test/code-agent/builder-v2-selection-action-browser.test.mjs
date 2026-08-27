import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

const requireCjs = createRequire(import.meta.url);
let browserAvailable = true;
try { requireCjs("playwright"); } catch { browserAvailable = false; }
const needsBrowser = { skip: browserAvailable ? false : "requires playwright" };

let server;
let baseUrl;

before(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<main>
      <h1>Saved software</h1>
      <div role="group" aria-label="saved software" data-thrallo-control="saved-software">
        <button type="button" value="atlas-editor" data-thrallo-control="saved-software"
          data-thrallo-option="atlas-editor" aria-pressed="true">Atlas Editor</button>
        <button type="button" value="beacon-test" data-thrallo-control="saved-software"
          data-thrallo-option="beacon-test" aria-pressed="false">Beacon Test</button>
      </div>
      <button type="button" data-thrallo-action="remove-saved-software"
        onclick="document.querySelector('[value=atlas-editor]').hidden=true;
          document.getElementById('out').textContent='Atlas Editor disappears and the saved software empty state is visible'">
        Remove saved software
      </button>
      <div role="group" aria-label="software category" data-thrallo-control="software-category">
        <button type="button" value="all-categories" data-thrallo-control="software-category"
          data-thrallo-option="all-categories" aria-pressed="true">All categories</button>
        <button type="button" value="developer-tools" data-thrallo-control="software-category"
          data-thrallo-option="developer-tools" aria-pressed="false"
          onclick="this.parentElement.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', 'false')); this.setAttribute('aria-pressed', 'true')">Developer Tools</button>
      </div>
      <div role="group" aria-label="software platform" data-thrallo-control="software-platform">
        <button type="button" value="all-platforms" data-thrallo-control="software-platform"
          data-thrallo-option="all-platforms" aria-pressed="true">All platforms</button>
        <button type="button" value="desktop" data-thrallo-control="software-platform"
          data-thrallo-option="desktop" aria-pressed="false">Desktop</button>
      </div>
      <article>Atlas Editor is Developer Tools software</article>
      <section aria-label="Software catalogue fragments">
        <article>
          <button type="button" value="atlas-buildkit" data-thrallo-control="catalogue-favourite"
            aria-pressed="false">Favourite Atlas BuildKit</button>
        </article>
        <article>
          <button type="button" value="pulsedesk" data-thrallo-control="catalogue-favourite"
            aria-pressed="false"
            onclick="this.setAttribute('aria-pressed', 'true'); document.getElementById('fragmented-favourite-out').textContent='PulseDesk appears in favourites'">
            Favourite PulseDesk
          </button>
        </article>
        <p id="fragmented-favourite-out"></p>
      </section>
      <section aria-label="Selected software fragments">
        <article>
          <button type="button" value="atlas-buildkit" data-thrallo-control="selected-software"
            aria-pressed="true">Open Atlas BuildKit details</button>
        </article>
        <aside>
          <button type="button" value="none" data-thrallo-control="selected-software"
            aria-pressed="false"
            onclick="this.setAttribute('aria-pressed', 'true'); document.getElementById('fragmented-selection-out').textContent='Select software from the catalogue'">
            Close detail panel
          </button>
          <p id="fragmented-selection-out"></p>
        </aside>
      </section>
      <section aria-label="Labelled collection removal fixture">
        <div role="group" aria-label="selected Software Id" data-thrallo-control="labelled-removal-selection">
          <button type="button" value="forge-planner" data-thrallo-control="labelled-removal-selection"
            aria-pressed="false"
            onclick="this.setAttribute('aria-pressed', 'true'); document.getElementById('labelled-detail-title').textContent='Forge Planner'">
            <span>PLANNING</span>
            <span style="display:block">Forge Planner</span>
            <span style="display:block">Web · Team</span>
            <span style="display:block">Coordinate project milestones</span>
          </button>
        </div>
        <aside aria-label="Catalogue side panel">
          <div aria-label="Selected-item detail panel">
            <h2 id="labelled-detail-title">No selected software</h2>
            <button type="button" data-thrallo-action="toggle-labelled-favourite"
              onclick="document.getElementById('labelled-favourites-list').hidden=false; document.getElementById('labelled-empty').hidden=true; this.textContent='Remove selected software from favourites'; document.getElementById('labelled-removal-out').textContent='Forge Planner appears in favourites list'">
              detail panel favourite control
            </button>
          </div>
          <div aria-label="Session-only favourites list">
            <h2>Session favourites</h2>
            <ul id="labelled-favourites-list" hidden>
              <li>Forge Planner <span>Planning</span>
                <button type="button" data-thrallo-action="toggle-labelled-favourite"
                  aria-label="favourites list remove control"
                  onclick="document.getElementById('labelled-favourites-list').hidden=true; document.getElementById('labelled-empty').hidden=false; document.getElementById('labelled-removal-out').textContent='No favourites remain'">
                  Remove
                </button>
              </li>
            </ul>
            <p id="labelled-empty">No favourites yet</p>
            <p id="labelled-removal-out"></p>
          </div>
        </aside>
      </section>
      <p id="out"></p>
    </main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

test("an already-selected exact target still runs its separate contracted action",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const selection = {
      logicalField: "savedSoftwareId",
      accessibleName: "saved software",
      accessibleNames: ["saved software"],
      machineId: "saved-software",
      roles: ["button", "radio", "option", "combobox"],
      selectedState: true,
      statePath: "manage-saved-software.draft.savedSoftwareId",
      verificationValue: "atlas-editor",
    };
    const action = {
      logicalField: "remove saved software",
      accessibleName: "remove saved software",
      accessibleNames: ["remove saved software"],
      machineId: "remove-saved-software",
      roles: ["button"],
      statePath: "manage-saved-software.custom.savedSoftwareIds",
    };
    const step = {
      action: "remove Atlas Editor from saved software",
      target: "saved software remove control",
      operates: ["savedSoftwareId", "remove-saved-software"],
      verificationValues: { savedSoftwareId: "atlas-editor" },
      expect: "Atlas Editor disappears and the saved software empty state is visible",
    };
    const flows = [
      { id: "manage-saved-software:1:selection:savedsoftwareid", journeyId: "manage-saved-software",
        stepIndex: 0, kind: "selection", valueWritten: "savedSoftwareId", control: selection,
        stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], reads: [], writes: [] },
      { id: "manage-saved-software:1:operation:remove-saved-software", journeyId: "manage-saved-software",
        stepIndex: 0, kind: "action", operationId: "remove-saved-software", control: action,
        stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], reads: [], writes: [] },
    ];
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "manage-saved-software", title: "Manage saved software", priority: "primary",
          steps: [step] }],
        interactionContract: { flows },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    assert.equal(result.journeys[0].steps[0].controlEvidence.selections[0].precondition,
      "already_selected");
    assert.ok(result.journeys[0].steps[0].controlEvidence.activation,
      JSON.stringify(result.journeys[0].steps[0]));
    assert.equal(result.journeys[0].steps[0].controlEvidence.activation.matchedBy, "machine_identity");
  });

test("a compound filter step may retain one exact sentinel while another selection moves",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const step = {
      action: "choose a software category while keeping all platforms visible",
      target: "software filters",
      operates: ["categoryFilter", "platformFilter"],
      verificationValues: { categoryFilter: "developer-tools", platformFilter: "all-platforms" },
      expect: "Atlas Editor remains visible as Developer Tools software",
    };
    const selection = (logicalField, machineId, verificationValue) => ({
      id: `filter-software:1:selection:${logicalField}`,
      journeyId: "filter-software",
      stepIndex: 0,
      kind: "selection",
      valueWritten: logicalField,
      control: {
        logicalField,
        accessibleName: logicalField,
        accessibleNames: [logicalField],
        machineId,
        roles: ["button", "radio", "option", "combobox"],
        selectedState: true,
        statePath: `filter-software.draft.${logicalField}`,
        verificationValue,
      },
      stateOwner: "src/App.jsx",
      responsibleModules: ["src/App.jsx"],
      reads: [],
      writes: [],
    });
    const flows = [
      selection("categoryFilter", "software-category", "developer-tools"),
      selection("platformFilter", "software-platform", "all-platforms"),
    ];
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "filter-software", title: "Filter software", priority: "primary", steps: [step] }],
        interactionContract: { flows },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    const evidence = result.journeys[0].steps[0].controlEvidence.selections;
    assert.equal(evidence[1].precondition, "already_selected");
  });

test("an exact fixture selects the matching repeated-card fragment with the same control identity",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const flow = {
      id: "manage-session-favourites:1:selection:favouritesoftwareids",
      journeyId: "manage-session-favourites",
      stepIndex: 0,
      kind: "selection",
      valueWritten: "favouriteSoftwareIds",
      control: {
        logicalField: "favouriteSoftwareIds",
        accessibleName: "favourite Software Ids",
        accessibleNames: ["favourite Software Ids"],
        machineId: "catalogue-favourite",
        roles: ["button", "radio", "option", "combobox"],
        selectedState: true,
        verificationValue: "pulsedesk",
      },
      stateOwner: "src/App.jsx",
      responsibleModules: ["src/App.jsx"],
      reads: [],
      writes: [],
    };
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "manage-session-favourites", title: "Manage session favourites",
          priority: "primary", steps: [{ action: "add a second software card to favourites",
            target: "PulseDesk favourite control", operates: ["favouriteSoftwareIds"],
            verificationValues: { favouriteSoftwareIds: "pulsedesk" },
            expect: "PulseDesk appears in favourites" }] }],
        interactionContract: { flows: [flow] },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    assert.equal(result.journeys[0].steps[0].selectedTexts[0], "Favourite PulseDesk");
  });

test("an exact fixture selects a matching auxiliary fragment with the same control identity",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const flow = {
      id: "inspect-software:1:selection:selectedsoftwareid",
      journeyId: "inspect-software",
      stepIndex: 0,
      kind: "selection",
      valueWritten: "selectedSoftwareId",
      control: {
        logicalField: "selectedSoftwareId",
        accessibleName: "selected Software Id",
        accessibleNames: ["selected Software Id"],
        machineId: "selected-software",
        roles: ["button", "radio", "option", "combobox"],
        selectedState: true,
        verificationValue: "none",
      },
      stateOwner: "src/App.jsx",
      responsibleModules: ["src/App.jsx"],
      reads: [],
      writes: [],
    };
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "inspect-software", title: "Inspect software", priority: "primary",
          steps: [{ action: "close the selected-item detail panel",
            target: "detail panel close control", operates: ["selectedSoftwareId"],
            verificationValues: { selectedSoftwareId: "none" },
            expect: "Select software from the catalogue" }] }],
        interactionContract: { flows: [flow] },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    assert.equal(result.journeys[0].steps[0].selectedTexts[0], "Close detail panel");
  });

test("a labelled collection stays authoritative when selected-card metadata remains in a sibling panel",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const selectionControl = {
      logicalField: "selectedSoftwareId",
      accessibleName: "selected Software Id",
      accessibleNames: ["selected Software Id"],
      machineId: "labelled-removal-selection",
      roles: ["button", "radio", "option", "combobox"],
      selectedState: true,
      verificationValue: "forge-planner",
    };
    const actionControl = {
      accessibleName: "toggle favourite",
      accessibleNames: ["toggle favourite"],
      machineId: "toggle-labelled-favourite",
      roles: ["button"],
    };
    const flows = [
      { id: "manage-favourites:1:selection:selectedsoftwareid", journeyId: "manage-favourites",
        stepIndex: 0, kind: "selection", valueWritten: "selectedSoftwareId",
        control: selectionControl, stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"],
        reads: [], writes: [] },
      { id: "manage-favourites:2:action", journeyId: "manage-favourites", stepIndex: 1,
        kind: "action", operationId: "toggle-favourite", control: actionControl,
        stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], reads: [], writes: [] },
      { id: "manage-favourites:3:action", journeyId: "manage-favourites", stepIndex: 2,
        kind: "action", operationId: "toggle-favourite", control: actionControl,
        stateOwner: "src/App.jsx", responsibleModules: ["src/App.jsx"], reads: [], writes: [] },
    ];
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "manage-favourites", title: "Manage session favourites", priority: "primary",
          steps: [
            { action: "select a software card", target: "Forge Planner card",
              operates: ["selectedSoftwareId"],
              verificationValues: { selectedSoftwareId: "forge-planner" },
              expect: "the selected-item detail panel displays Forge Planner" },
            { action: "add the selected software to favourites", target: "detail panel favourite control",
              expect: "Forge Planner appears in the favourites list" },
            { action: "remove the software from favourites", target: "favourites list remove control",
              expect: "the software is removed from the favourites list and an empty favourites message is visible" },
          ] }],
        interactionContract: { flows },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    const removal = result.journeys[0].steps[2].controlEvidence.removalTransition;
    assert.equal(removal.target, "Forge Planner");
    assert.equal(removal.beforeCount, 1);
    assert.equal(removal.afterCount, 0);
    assert.equal(removal.postcondition.emptyStateEvidence.inMarkedRegion, true);
  });
