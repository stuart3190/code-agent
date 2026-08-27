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
      <h1>Team workspace sign-in</h1>
      <label>Email address<input type="email" aria-label="email" value="member@example.test"
        data-thrallo-control="team-email"></label>
      <label>Display name<input aria-label="display name" value="Workspace Member"
        data-thrallo-control="team-display-name"></label>
      <label>Password<input type="password" aria-label="password" value="Example-Password-1"></label>
      <button type="button" data-thrallo-action="open-team-workspace"
        onclick="window.authActivations=(window.authActivations||0)+1;
          setTimeout(() => { document.getElementById('out').textContent = window.authActivations === 1
            ? 'Dashboard opens and the signed-in user name and role badge are visible'
            : 'Duplicate authentication activation'; }, 100)">
        authentication form
      </button>
      <p id="out" role="status"></p>
    </main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

test("a visible authentication form uses its contracted submit action exactly once",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const control = (logicalField, machineId, accessibleName) => ({
      logicalField, machineId, accessibleName, accessibleNames: [accessibleName],
      roles: ["textbox"], editable: true,
      statePath: `team-workspace.draft.${logicalField}`,
    });
    const flows = [
      {
        id: "team-workspace:1:flow-start", journeyId: "team-workspace", stepIndex: 0,
        kind: "flow_start", writes: ["team-workspace.flowStarted"], reads: [],
        control: {
          purpose: "authentication form", machineId: "open-team-workspace",
          accessibleName: "authentication form", accessibleNames: ["authentication form"],
          roles: ["button"], flowEntry: true,
        },
      },
      {
        id: "team-workspace:1:input:email", journeyId: "team-workspace", stepIndex: 0,
        kind: "input", valueWritten: "email", writes: ["team-workspace.draft.email"], reads: [],
        control: control("email", "team-email", "email"),
      },
      {
        id: "team-workspace:1:input:displayname", journeyId: "team-workspace", stepIndex: 0,
        kind: "input", valueWritten: "displayName", writes: ["team-workspace.draft.displayName"], reads: [],
        control: control("displayName", "team-display-name", "display name"),
      },
    ];
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{
          id: "team-workspace", title: "Open the team workspace", priority: "primary",
          steps: [{
            action: "sign in or create a team account",
            target: "authentication form",
            operates: ["email", "displayName"],
            expect: "the dashboard opens and a signed-in user name and role badge are visible",
          }],
        }],
        interactionContract: { flows },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    const step = result.journeys[0].steps[0];
    assert.equal(step.controlEvidence.activation.matchedBy, "machine_identity");
    assert.equal(step.controlEvidence.authentication.authenticated, true);
    assert.equal(step.controlEvidence.authentication.via, "contracted_flow_entry");
  });
