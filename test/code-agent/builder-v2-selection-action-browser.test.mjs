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
