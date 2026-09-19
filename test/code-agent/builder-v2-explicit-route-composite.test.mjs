import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { actionIdFor, controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

const requireCjs = createRequire(import.meta.url);
let browserAvailable = true;
try { requireCjs("playwright"); } catch { browserAvailable = false; }
const needsBrowser = { skip: browserAvailable ? false : "requires playwright" };

let server;
let baseUrl;

const searchControlId = controlIdFor("searchQuery");
const applyActionId = actionIdFor("apply-catalogue-filter");

before(async () => {
  server = http.createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.writeHead(200, { "content-type": "text/html" });
    if (path === "/catalogue") {
      response.end(`<!doctype html><html><body>
        <h1>Software catalogue</h1>
        <p>Durable catalogue state restored</p>
        <label>Search query
          <input data-thrallo-control="${searchControlId}" aria-label="Search query" />
        </label>
        <button data-thrallo-action="${applyActionId}">Apply catalogue filter</button>
        <p id="result">Catalogue route active</p>
        <script>
          document.querySelector('[data-thrallo-action="${applyActionId}"]').addEventListener('click', () => {
            document.querySelector('#result').textContent = 'Catalogue filter applied';
          });
        </script>
      </body></html>`);
      return;
    }
    response.end("<!doctype html><html><body><h1>Workspace board</h1></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

function contractFor(step, flows) {
  return {
    journeys: [{
      id: "catalogue-route-journey",
      title: "Use the software catalogue",
      priority: "primary",
      steps: [step],
    }],
    interactionContract: {
      version: 1,
      flows: flows.map((flow) => ({
        journeyId: "catalogue-route-journey",
        stepIndex: 0,
        stateOwner: "src/Catalogue.jsx",
        responsibleModules: ["src/Catalogue.jsx"],
        reads: [],
        writes: [],
        ...flow,
      })),
    },
  };
}

test("an explicit route remains authoritative for a composite input and action step",
  { ...needsBrowser, timeout: 60_000 }, async () => {
    const step = {
      action: "enter a catalogue query and apply it",
      target: "/catalogue",
      expect: "the catalogue filter is applied",
    };
    const contract = contractFor(step, [
      {
        id: "catalogue-route-journey:1:input:searchquery",
        kind: "input",
        target: "/catalogue",
        control: {
          logicalField: "searchQuery",
          accessibleName: "Search query",
          accessibleNames: ["Search query"],
          machineId: searchControlId,
          roles: ["textbox"],
          inputTypes: ["text"],
          editable: true,
          statePath: "catalogue-route-journey.draft.searchQuery",
          verificationValue: "atlas",
        },
        writes: ["catalogue-route-journey.draft.searchQuery"],
      },
      {
        id: "catalogue-route-journey:1:action",
        kind: "action",
        target: "/catalogue",
        control: {
          accessibleName: "Apply catalogue filter",
          accessibleNames: ["Apply catalogue filter"],
          machineId: applyActionId,
          roles: ["button"],
        },
        reads: ["catalogue-route-journey.draft.searchQuery"],
      },
    ]);

    const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000 });
    assert.equal(result.journeys[0].steps[0].status, "pass",
      JSON.stringify(result.journeys[0].steps[0], null, 2));
  });

test("a recovery step reloads its explicit route rather than the previous screen",
  { ...needsBrowser, timeout: 60_000 }, async () => {
    const step = {
      action: "reload the catalogue",
      target: "/catalogue",
      expect: "durable catalogue state is restored",
    };
    const contract = contractFor(step, [{
      id: "catalogue-route-journey:1:recovery",
      kind: "recovery",
      target: "/catalogue",
    }]);

    const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 35_000 });
    assert.equal(result.journeys[0].steps[0].status, "pass",
      JSON.stringify(result.journeys[0].steps[0], null, 2));
  });
