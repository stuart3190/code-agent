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
  server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/plain-sign-in") {
      response.end(`<main>
        <form onsubmit="event.preventDefault(); this.remove(); document.getElementById('out').textContent='Project dashboard opens and the header shows Studio Operations'">
          <h1>Team workspace sign-in</h1>
          <label>Member email<input type="email" aria-label="member email"
            data-thrallo-control="member-email"></label>
          <button type="submit">Sign in</button>
        </form>
        <p id="out" role="status"></p>
      </main>`);
      return;
    }
    if (request.url === "/stuck-sign-in") {
      response.end(`<main>
        <form onsubmit="event.preventDefault()">
          <h1>Team workspace sign-in</h1>
          <label>Member email<input type="email" aria-label="member email"
            data-thrallo-control="member-email"></label>
          <button type="submit">Sign in</button>
        </form>
        <p id="out" role="status"></p>
      </main>`);
      return;
    }
    if (request.url === "/multi-journey-auth") {
      response.end(`<main id="app"></main><script>
        const root = document.getElementById('app');
        const renderWorkspace = () => {
          root.innerHTML = '<h1>Team dashboard shell</h1>'
            + '<button type="button" data-thrallo-action="open-board">Board navigation</button>'
            + '<p id="board-output" role="status"></p>';
          root.querySelector('[data-thrallo-action="open-board"]').onclick = () => {
            document.getElementById('board-output').textContent = 'Board page shows To Do, In Progress, Review, and Done columns';
          };
        };
        const renderSignIn = () => {
          root.innerHTML = '<h1>Team workspace sign-in</h1>'
            + '<button type="button" data-thrallo-action="open-sign-in">sign-in form</button>';
          root.querySelector('[data-thrallo-action="open-sign-in"]').onclick = () => {
            root.innerHTML = '<form id="auth"><label>Email <input type="email"></label>'
              + '<label>Password <input type="password"></label>'
              + '<button type="submit">Open team workspace</button></form>';
            document.getElementById('auth').onsubmit = (event) => {
              event.preventDefault();
              localStorage.setItem('contracted-auth-session', 'active');
              renderWorkspace();
            };
          };
        };
        localStorage.getItem('contracted-auth-session') === 'active' ? renderWorkspace() : renderSignIn();
      </script>`);
      return;
    }
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

const plainSignInContract = {
  journeys: [{
    id: "team-member-sign-in", title: "Open the team workspace", priority: "primary",
    steps: [{
      action: "sign in with a team member account",
      target: "team workspace sign-in",
      operates: ["memberEmail"],
      expect: "the project dashboard opens and the header shows Studio Operations",
    }],
  }],
  interactionContract: { flows: [{
    id: "team-member-sign-in:1:input:member-email",
    journeyId: "team-member-sign-in", stepIndex: 0, kind: "input",
    valueWritten: "memberEmail", writes: ["team-member-sign-in.draft.memberEmail"], reads: [],
    control: {
      logicalField: "memberEmail", machineId: "member-email",
      accessibleName: "member email", accessibleNames: ["member email"],
      roles: ["textbox"], editable: true, statePath: "team-member-sign-in.draft.memberEmail",
    },
  }] },
};

test("a contracted plain sign-in input submits its owning form and proves the protected surface",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const result = await verifyJourneys({
      previewUrl: `${baseUrl}/plain-sign-in`, timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: plainSignInContract,
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    assert.match(result.journeys[0].steps[0].detail, /project, dashboard, header, studio, operations/i);
  });

test("a contracted sign-in outcome cannot pass on retained credential fields alone",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const result = await verifyJourneys({
      previewUrl: `${baseUrl}/stuck-sign-in`, timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: plainSignInContract,
    });

    assert.equal(result.pass, false, JSON.stringify(result.journeys));
    assert.doesNotMatch(result.journeys[0].steps[0].detail, /fields hold values/i);
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

test("dependent journeys start with fresh browser auth state while retaining shared backend identity",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const signIn = {
      id: "team-primary:0:flow-start", journeyId: "team-primary", stepIndex: 0,
      kind: "flow_start", writes: ["team-primary.authenticated"], reads: [],
      control: {
        purpose: "sign-in form", machineId: "open-sign-in",
        accessibleName: "sign-in form", accessibleNames: ["sign-in form"],
        roles: ["button"], flowEntry: true,
      },
    };
    const boardControl = {
      purpose: "board navigation", machineId: "open-board",
      accessibleName: "Board navigation", accessibleNames: ["Board navigation"],
      roles: ["button"],
    };
    const primaryBoard = {
      id: "team-primary:1:action:board", journeyId: "team-primary", stepIndex: 1,
      kind: "action", writes: ["team-primary.boardVisible"], reads: ["team-primary.authenticated"],
      observable: "Board page shows To Do, In Progress, Review, and Done columns",
      control: boardControl,
    };
    const dependentBoard = {
      id: "team-dependent:0:action:board", journeyId: "team-dependent", stepIndex: 0,
      kind: "action", writes: ["team-dependent.boardVisible"], reads: ["team-primary.authenticated"],
      observable: "Board page shows To Do, In Progress, Review, and Done columns",
      control: boardControl,
    };
    const result = await verifyJourneys({
      previewUrl: `${baseUrl}/multi-journey-auth`, timeoutMs: 45_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [
          {
            id: "team-primary", title: "Open the team board", priority: "primary",
            steps: [
              { action: "sign in with a team member account", target: "sign-in form",
                expect: "the Team dashboard shell is visible" },
              { action: "open the board page", target: "Board navigation",
                expect: "the Board page shows To Do, In Progress, Review, and Done columns" },
            ],
          },
          {
            id: "team-dependent", title: "Reopen the team board", priority: "secondary",
            steps: [{ action: "open the board page", target: "Board navigation",
              expect: "the Board page shows To Do, In Progress, Review, and Done columns" }],
          },
        ],
        interactionContract: {
          flows: [signIn, primaryBoard, dependentBoard],
          scenarios: {
            "team-primary": { role: "produces", startState: "fresh", lifecycle: "team:workspace" },
            "team-dependent": { role: "consumes", startState: "inherits", lifecycle: "team:workspace" },
          },
        },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys, null, 2));
    assert.deepEqual(result.journeys.map((journey) => journey.status), ["pass", "pass"]);
    assert.equal(result.journeys[1].setup?.ok, true);
    assert.equal(result.journeys[1].setup?.performed?.[0]?.kind, "authentication");
  });
