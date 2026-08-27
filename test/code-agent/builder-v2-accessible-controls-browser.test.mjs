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
    const unnamed = request.url === "/unnamed-control";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<main>
      <h1>Software catalogue</h1>
      <label for="catalogue-search">Search software</label>
      <input id="catalogue-search" type="search">
      <button type="button">Apply filters</button>
      <button type="button" ${unnamed ? "" : "aria-label=\"Clear filters\""}>${unnamed ? "&#215;" : ""}</button>
      <label for="catalogue-sort">Sort software</label>
      <select id="catalogue-sort"><option>Recently updated</option></select>
      <a href="#catalogue">View catalogue</a>
    </main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

const accessibilityContract = {
  journeys: [{
    id: "inspect-software-controls",
    title: "Inspect software controls",
    priority: "primary",
    steps: [{
      action: "inspect the interactive controls",
      target: "software catalogue",
      expect: "each interactive control has a visible label or accessible name that describes its purpose",
    }],
  }],
  interactionContract: { flows: [] },
};

test("a structural accessibility observation accepts labelled catalogue controls",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const result = await verifyJourneys({
      previewUrl: `${baseUrl}/accessible-controls`,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: accessibilityContract,
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    const step = result.journeys[0].steps[0];
    assert.equal(step.classification, "PASS");
    assert.equal(step.controlEvidence.accessibility.total, 5);
    assert.equal(step.controlEvidence.accessibility.unnamed, 0);
  });

test("a structural accessibility observation rejects an unnamed catalogue control",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const result = await verifyJourneys({
      previewUrl: `${baseUrl}/unnamed-control`,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: accessibilityContract,
    });

    assert.equal(result.pass, false);
    const step = result.journeys[0].steps[0];
    assert.equal(step.status, "fail");
    assert.equal(step.classification, "APP_FUNCTIONAL_FAILURE");
    assert.equal(step.controlEvidence.accessibility.unnamed, 1);
    assert.equal(step.controlEvidence.accessibility.unnamedControls[0].reason, "non_descriptive_name");
  });
