import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }

const contract = deriveBuildSpec({
  summary: "A calculated layout editor", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Planner" }],
  entities: [{ name: "project", fields: [
    { name: "name", type: "string" }, { name: "length", type: "number" },
  ] }],
  operations: [{ name: "save-project", entity: "project", kind: "create",
    journey: "create-auto-layout-save-project" }],
  journeys: [{ id: "create-auto-layout-save-project", title: "Create and save a layout",
    priority: "primary", steps: [
      { action: "open the planner", target: "/", expect: "the planner header is visible" },
      { action: "enter core room setup details", target: "room setup panel",
        operates: ["name", "length"], primitive: "textbox",
        expect: "the plan outline and calculated area are visible" },
      { action: "press AUTO LAYOUT", target: "AUTO LAYOUT button",
        expect: "numbered downlights appear inside the room outline" },
      // The retained production contract asks to inspect calculated outputs. It does NOT say
      // that this panel must repeat every earlier setup input verbatim.
      { action: "review live calculation results", target: "results panel",
        expect: "area, total lumen requirement, estimated fitting count, installed lumens and wall offsets are visible" },
      { action: "save the project", target: "Save project button",
        expect: "a saved status message and a project name are visible" },
    ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;

const html = `<!doctype html><html><body>
  <h1>Planner header</h1>
  <section aria-label="room setup panel">
    <label>name<input aria-label="name" value="Initial project"></label>
    <label>length<input aria-label="length" type="number" value="5.8" min="1" max="20" step="0.1"></label>
    <p>Plan outline and calculated area are visible.</p>
  </section>
  <button type="button" aria-label="AUTO LAYOUT button" id="layout">AUTO LAYOUT</button>
  <section id="layout-result" hidden><p>Numbered downlights appear inside the room outline.</p>
    <section aria-label="results panel"><p>Area</p><p>Total lumen requirement</p>
      <p>Estimated fitting count</p><p>Installed lumens</p><p>Wall offsets</p></section></section>
  <button type="button" aria-label="Save project button" id="save">Save project</button>
  <p id="saved" hidden>Saved status message: project name is stored.</p>
  <script>
    document.getElementById("layout").onclick = () => { document.getElementById("layout-result").hidden = false; };
    document.getElementById("save").onclick = () => { document.getElementById("saved").hidden = false; };
  </script>
</body></html>`;

test("LIVE REGRESSION — a valid calculated-results review reaches the save step", {
  skip: playwrightAvailable ? false : "requires playwright", timeout: 120_000,
}, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }); response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract, timeoutMs: 90_000,
    });
    const journey = result.journeys[0];
    const transcript = journey.steps.map((step) => `${step.status}: ${step.action} — ${step.detail}`).join("\n");
    assert.equal(journey.status, "pass", transcript);
    assert.equal(journey.steps[3].status, "pass", transcript);
    assert.equal(journey.steps[3].readOnlyAssertion, true, transcript);
    assert.equal(journey.steps[4].status, "pass", transcript);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
