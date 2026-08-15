// PR6 — the contract's journeys are driven in a real browser against the real preview.
//
// The existing verifier proves the app LOADS. It cannot prove the app DOES what was agreed,
// because until PR4 nothing had written down what was agreed. "The page rendered" and "a booking
// made in this browser is still there after a reload" are different claims, and only the second is
// what the customer asked for.
//
// These tests use a real Chromium against a real static server — a fake page object would prove
// the test harness works, not the driver.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { verifyJourneys, journeyFailures, journeySummary } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// A tiny app that really works: a form that stores to a server-side map and survives a reload.
const WORKING = `<!doctype html><html><body>
<h1>Book a slot</h1>
<div id="app">
  <p>Available slots</p>
  <form id="f">
    <label>Name <input name="name" /></label>
    <label>Email <input type="email" name="email" /></label>
    <button type="submit">Confirm booking</button>
  </form>
  <p id="out"></p>
</div>
<script>
  const out = document.getElementById("out");
  const saved = localStorage.getItem("ref");
  if (saved) out.textContent = "Your booking reference is " + saved;
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = "BK-" + Math.floor(Math.random() * 9000 + 1000);
    localStorage.setItem("ref", ref);
    out.textContent = "Your booking reference is " + ref;
  });
</script>
</body></html>`;

// The same page with the confirmation removed: submits, says nothing, stores nothing.
const BROKEN = WORKING
  .replace('out.textContent = "Your booking reference is " + ref;', "/* nothing happens */")
  .replace('if (saved) out.textContent = "Your booking reference is " + saved;', "");

let server = null;
let baseUrl = "";
let body = WORKING;
let delayedHistoryMs = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/history-delay" && delayedHistoryMs > 0) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      }, delayedHistoryMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => { await new Promise((resolve) => server?.close(resolve)); });

const CONTRACT = {
  journeys: [{
    id: "book", title: "A visitor books a slot", priority: "primary",
    steps: [
      { action: "open the booking page", target: "/", expect: "the available slots are visible" },
      { action: "enter name and email", target: "details form", expect: "the fields accept the details" },
      { action: "click confirm booking", target: "confirm button", expect: "a booking reference is shown" },
    ],
  }],
};

test("a working journey passes against a real browser", needsBrowser, async () => {
  body = WORKING;
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });

  assert.equal(result.pass, true, `journeys: ${journeySummary(result)}`);
  assert.equal(result.primaryStatus, "pass");
  assert.deepEqual(result.failures, []);
  // Every step was really driven, not skipped past.
  const steps = result.journeys[0].steps;
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.status === "pass"), JSON.stringify(steps, null, 1));
  assert.match(journeySummary(result), /book:pass/);
});

test("a journey whose confirmation never appears FAILS", needsBrowser, async () => {
  // The class this exists for: the form submits, the page looks finished, and nothing happened.
  // `npm run build` passes on this. So does "the app loads".
  body = BROKEN;
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });

  assert.equal(result.pass, false, `expected a failure; got ${journeySummary(result)}`);
  assert.equal(result.failures.length, 1);

  const failures = journeyFailures(result);
  assert.ok(failures.length, "a failure must produce something a repair brief can act on");
  assert.match(failures[0], /the journey "A visitor books a slot" fails at/);
  assert.match(failures[0], /reference/, "and it names what was expected but missing");
});

test("console errors and failed requests are collected as evidence", needsBrowser, async () => {
  body = WORKING.replace("<script>", '<script>console.error("boom-from-the-app"); fetch("/missing-endpoint").catch(()=>{});\n');
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });
  assert.ok(result.consoleErrors.some((e) => /boom-from-the-app/.test(e)));
  body = WORKING;
});

test("visible evidence is not shadowed by an earlier hidden responsive copy", needsBrowser, async () => {
  body = `<!doctype html><html><body>
    <div style="display:none">model hierarchy properties panel</div>
    <main><h1>Saved asset preview</h1><p>Model hierarchy and properties panel are visible.</p></main>
  </body></html>`;
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: { journeys: [{
    id: "saved", title: "Open saved asset", priority: "primary",
    steps: [{ action: "open the saved asset", target: "/",
      expect: "the asset preview, model hierarchy, and properties panel are visible" }],
  }] } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  body = WORKING;
});

test("invalid input tests only its owning form and never an unrelated page action", needsBrowser, async () => {
  body = `<!doctype html><html><body>
    <form><label>Size <input data-thrallo-control="ctl-size" value="2, 2, 2"></label>
      <button type="submit">Save properties</button></form>
    <p id="validation"></p><button id="unrelated" type="button">Continue to unrelated generator</button>
    <script>
      const input = document.querySelector('[data-thrallo-control="ctl-size"]');
      const save = document.querySelector('button[type="submit"]');
      input.addEventListener('input', () => {
        const invalid = input.value.split(/[ ,]+/).some((value) => Number(value) <= 0);
        save.disabled = invalid;
        document.getElementById('validation').textContent = invalid
          ? 'Readable validation message: export controls are disabled until corrected' : '';
      });
      document.getElementById('unrelated').onclick = () => { document.body.textContent = 'unrelated action advanced'; };
    </script>
  </body></html>`;
  const control = { logicalField: "size", accessibleName: "size", accessibleNames: ["size"],
    machineId: "ctl-size", roles: ["textbox"], inputTypes: ["text"], validity: "invalid",
    statePath: "asset.draft.size" };
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: {
    journeys: [{ id: "invalid", title: "Reject invalid size", priority: "primary",
      steps: [{ action: "enter an invalid size value", target: "size", operates: ["size"],
        expect: "a readable validation message is shown and export controls are disabled until corrected" }] }],
    interactionContract: { flows: [{ journeyId: "invalid", stepIndex: 0, kind: "input", control }] },
  } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  assert.doesNotMatch(result.journeys[0].steps[0].observation?.text || "", /unrelated action advanced/);
  body = WORKING;
});

test("opaque control identity proves an invalid field remains mounted", needsBrowser, async () => {
  body = `<!doctype html><html><body>
    <form id="properties"><input data-thrallo-control="ctl-size" value="2, 2, 2">
      <button>Save property changes</button></form><p id="validation"></p>
    <script>
      const input = document.querySelector('[data-thrallo-control="ctl-size"]');
      input.addEventListener('input', () => {
        const invalid = input.value.split(/[ ,]+/).some((value) => Number(value) <= 0);
        document.querySelector('button').disabled = invalid;
        document.getElementById('validation').textContent = invalid
          ? 'Readable validation message: export controls are disabled until corrected' : '';
      });
    </script>
  </body></html>`;
  const control = { logicalField: "size", accessibleName: "size", accessibleNames: ["size"],
    machineId: "ctl-size", roles: ["textbox"], inputTypes: ["text"], validity: "invalid",
    statePath: "asset.draft.size" };
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: {
    journeys: [{ id: "invalid", title: "Reject invalid size", priority: "primary",
      steps: [{ action: "enter an invalid size value", target: "size", operates: ["size"],
        expect: "a readable validation message is shown and export controls are disabled until corrected" }] }],
    interactionContract: { flows: [{ journeyId: "invalid", stepIndex: 0, kind: "input", control }] },
  } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  assert.equal(result.journeys[0].steps[0].controlEvidence?.fields?.[0]?.matchedBy, "machine=ctl-size");
  body = WORKING;
});

test("generic action driving chooses the control whose name best matches the contracted target", needsBrowser, async () => {
  body = `<!doctype html><html><body>
    <aside><button id="asset">Duplicate asset</button></aside>
    <main><button id="object">Duplicate selected object</button><p id="status"></p></main>
    <script>
      document.getElementById('asset').onclick = () => { document.getElementById('status').textContent = 'History asset copied'; };
      document.getElementById('object').onclick = () => { document.getElementById('status').textContent = 'A second object with a distinct name appears in the hierarchy and the part count increases'; };
    </script>
  </body></html>`;
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: {
    journeys: [{ id: "duplicate", title: "Duplicate a selected object", priority: "primary",
      steps: [{ action: "duplicate the selected object", target: "duplicate object control",
        reads: ["objectId"],
        expect: "a second object with a distinct name appears in the hierarchy and the part count increases" }] }],
  } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  assert.match(result.journeys[0].steps[0].detail || "", /second|distinct|name/i);
  body = WORKING;
});

test("isolated durable setup waits for its asynchronously refreshed consumer entry", needsBrowser, async () => {
  delayedHistoryMs = 1_200;
  body = `<!doctype html><html><body>
    <form id="generator"><label>Prompt <input data-thrallo-control="ctl-prompt"></label>
      <button data-thrallo-action="act-generate" type="submit">Generate</button></form>
    <p id="saved"></p><div id="history"></div><p id="opened"></p>
    <script>
      document.getElementById('generator').onsubmit = async (event) => {
        event.preventDefault();
        const value = document.querySelector('[data-thrallo-control="ctl-prompt"]').value;
        document.getElementById('saved').textContent = 'Named saved asset ' + value;
        await fetch('/history-delay');
        document.getElementById('history').innerHTML = '<button data-thrallo-action="act-history">History item</button>';
        document.querySelector('[data-thrallo-action="act-history"]').onclick = () => {
          document.getElementById('opened').textContent = 'Asset preview hierarchy properties panel current version validation panel';
        };
      };
    </script>
  </body></html>`;
  const primary = { id: "primary", title: "Create an asset", priority: "primary", steps: [] };
  const secondary = { id: "edit", title: "Edit an existing asset", priority: "secondary", steps: [{
    action: "open a saved generation", expect: "the asset preview, hierarchy, properties panel, current version, and validation panel are visible",
  }] };
  const primaryFlows = [
    { id: "primary:input", journeyId: "primary", stepIndex: 0, kind: "input",
      control: { logicalField: "prompt", accessibleName: "Prompt", accessibleNames: ["Prompt"],
        machineId: "ctl-prompt", roles: ["textbox"], statePath: "primary.draft.prompt" } },
    { id: "primary:mutation", journeyId: "primary", stepIndex: 0, kind: "mutation",
      durableLifecycle: "crud:asset", observable: "a named saved asset appears",
      control: { accessibleName: "Generate", machineId: "act-generate", roles: ["button"] },
      writes: ["primary.durable.record"] },
  ];
  const secondaryFlows = [{ id: "edit:start", journeyId: "edit", stepIndex: 0, kind: "flow_start",
    observable: secondary.steps[0].expect,
    control: { accessibleName: "history item", machineId: "act-history", roles: ["button"], flowEntry: true } }];
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: {
    journeys: [secondary], allJourneys: [primary, secondary],
    prerequisiteInteractionContract: { flows: [...primaryFlows, ...secondaryFlows] },
    interactionContract: { flows: secondaryFlows },
  } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys, null, 2));
  delayedHistoryMs = 0;
  body = WORKING;
});

test("sign out is proved by the public auth entry replacing the private surface", needsBrowser, async () => {
  body = `<!doctype html><html><body><main id="private">Private editor history
    <button id="signout">Sign out</button></main><script>
      document.getElementById('signout').onclick = () => {
        document.body.innerHTML = '<main>Public landing screen <a href="/auth">Sign in</a></main>';
      };
    </script></body></html>`;
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: { journeys: [{
    id: "signout", title: "Sign out", priority: "primary",
    steps: [{ action: "sign out", target: "account menu",
      expect: "the landing or sign-in screen is visible and private editor history is no longer visible" }],
  }] } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  body = WORKING;
});

test("a mobile viewport is graded on visible controls and horizontal reflow", needsBrowser, async () => {
  body = `<!doctype html><html><head><style>
    .mobile-panels{display:none}@media(max-width:500px){.desktop{display:none}.mobile-panels{display:flex;gap:8px}}
    body{margin:0;max-width:100%}
  </style></head><body><div class="desktop">History hierarchy properties desktop sidebars</div>
    <nav class="mobile-panels"><button>History panel</button><button>Hierarchy panel</button><button>Properties panel</button></nav>
  </body></html>`;
  const result = await verifyJourneys({ previewUrl: baseUrl, timeoutMs: 30_000, contract: { journeys: [{
    id: "mobile", title: "Responsive editor", priority: "primary",
    steps: [{ action: "resize to a mobile-width viewport", target: "browser viewport",
      expect: "history, hierarchy, and properties are reachable through clearly labelled panel buttons with no horizontal scrollbar" }],
  }] } });
  assert.equal(result.pass, true, JSON.stringify(result.journeys));
  body = WORKING;
});

test("the primary journey is driven first, so a timeout still proves what gates the preview", needsBrowser, async () => {
  body = WORKING;
  const twoJourneys = {
    journeys: [
      { id: "secondary", title: "Something else", priority: "secondary",
        steps: [{ action: "open /", expect: "the page loads" }, { action: "look", expect: "slots are visible" }] },
      CONTRACT.journeys[0],
    ],
  };
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: twoJourneys, timeoutMs: 90_000 });
  assert.equal(result.journeys[0].priority, "primary", "the primary journey runs before the others");
  assert.equal(result.pass, true);
});

test("a verifier that cannot start is reported as unavailable, never as a broken app", async () => {
  // An unreachable preview must not be read as "the journeys failed" — that would fail a build
  // over infrastructure, which is the confidently-wrong mistake in the most expensive place.
  const result = await verifyJourneys({
    previewUrl: "http://127.0.0.1:1/", contract: CONTRACT, timeoutMs: 8_000,
  });
  assert.notEqual(result.pass, true);
  // Either it could not start at all, or every step was undriveable — never a confident "fail".
  if (!result.unavailable) {
    assert.notEqual(result.primaryStatus, "fail",
      "an unreachable preview must not produce confident journey failures");
  }
});

test("a contract with no journeys produces no verdict rather than a pass", async () => {
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: { journeys: [] }, timeoutMs: 5_000 });
  assert.equal(result.pass, null);
  assert.equal(journeySummary(result), "no journeys");
});

test("journeyFailures turns a verdict into something a repair can act on", () => {
  const failures = journeyFailures({
    failures: [{
      title: "A visitor books a slot",
      steps: [
        { status: "pass", action: "open the page" },
        { status: "fail", action: "click confirm", detail: "expected reference; found none" },
      ],
    }],
    consoleErrors: ["TypeError: x is not a function"],
    failedRequests: ["500 POST /api/book"],
  });
  assert.equal(failures.length, 3);
  assert.match(failures[0], /fails at "click confirm": expected reference/);
  assert.match(failures[1], /browser console reports/);
  assert.match(failures[2], /network request failed: 500 POST/);
  // A passing step is not reported as a failure.
  assert.ok(!failures.some((f) => /open the page/.test(f)));
});
