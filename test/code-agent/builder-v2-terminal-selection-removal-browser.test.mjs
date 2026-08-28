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
      <h1>Software catalogue</h1>
      <section aria-label="Favourites list">
        <button type="button" value="atlas-notes" aria-pressed="false"
          data-thrallo-control="favourite-choice" data-thrallo-action="remove-favourite"
          onclick="this.remove(); document.getElementById('empty').textContent =
            'The removed software no longer appears in favourites. No favourites have been added.'">
          Favourite Software Id Atlas Notes remove control
        </button>
        <p id="empty" role="status"></p>
      </section>
    </main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

test("a terminal catalogue removal is proved by its fresh empty-state outcome", {
  ...needsBrowser, timeout: 120_000,
}, async () => {
  const result = await verifyJourneys({
    previewUrl: baseUrl,
    timeoutMs: 35_000,
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    contract: {
      journeys: [{
        id: "manage-favourites", title: "Manage catalogue favourites", priority: "primary",
        steps: [{
          action: "remove the favourite",
          target: "favourites list remove control",
          operates: ["favouriteSoftwareId", "remove-favourite"],
          expect: "the removed software no longer appears in favourites and the empty favourites message is visible again",
        }],
      }],
      interactionContract: { flows: [
        {
          id: "manage-favourites:1:action", journeyId: "manage-favourites", stepIndex: 0,
          kind: "action", action: "remove the favourite", writes: ["favourites"], reads: [],
          control: {
            purpose: "favourites list remove control", machineId: "remove-favourite",
            accessibleName: "favourites list remove control", accessibleNames: ["favourites list remove control"],
            roles: ["button"], statePath: "favourites",
          },
        },
        {
          id: "manage-favourites:1:selection", journeyId: "manage-favourites", stepIndex: 0,
          kind: "selection", action: "remove the favourite", valueWritten: "favouriteSoftwareId",
          writes: ["favouriteSoftwareId"], reads: ["favourites"],
          control: {
            purpose: "favouriteSoftwareId", machineId: "favourite-choice",
            logicalField: "favouriteSoftwareId", accessibleName: "favourite Software Id",
            accessibleNames: ["favourite Software Id"], roles: ["button"], selectedState: true,
            statePath: "favouriteSoftwareId",
          },
        },
      ] },
    },
  });

  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  const step = result.journeys[0].steps[0];
  assert.equal(step.status, "pass");
  assert.equal(step.controlEvidence.selections[0].autoAdvance.expectationMet, true);
  assert.equal(step.controlEvidence.selections[0].autoAdvance.terminalStep, true);
});
